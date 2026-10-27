// Company lawsuit search, served at /lawsuits.
//
// Rajasthan HC cases come from lawsuits.db (built by ecourts-report's
// build-lawsuits.js from the scraped cause lists: one row per case with its
// parties, advocates and hearing dates). Cases in other courts come from a
// Perplexity web search over Indian legal sites; those are sourced summaries,
// not a complete list.

const fs = require('fs');
const path = require('path');

const { log } = require('../utils/logger');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// node:sqlite prints an ExperimentalWarning on Node 22; it is stable enough here.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) =>
  String(w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...rest);
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'ecourts');
const DB_FILE = path.join(DATA_DIR, 'lawsuits.db');

// Reopen when the file is replaced by a new build.
let db = null;
let dbMtime = 0;
function getDb() {
  const { mtimeMs } = fs.statSync(DB_FILE);
  if (!db || mtimeMs !== dbMtime) {
    if (db) db.close();
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    dbMtime = mtimeMs;
  }
  return db;
}

const likePattern = q => `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`;
const cleanQuery = q => String(q || '').toUpperCase().replace(/\s+/g, ' ').trim();

// Party-name ids for a search: one exact name (picked from suggestions) or
// every name containing the query.
function matchNames(d, q, exact) {
  const sql = exact
    ? `SELECT id, name, type, cases, as_p, as_r FROM party_names WHERE name = ?`
    : `SELECT id, name, type, cases, as_p, as_r FROM party_names WHERE name LIKE ? ESCAPE '\\' ORDER BY cases DESC`;
  return d.prepare(sql).all(exact ? q : likePattern(q));
}

const PPLX_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    reported_case_count: { type: 'string' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          forum: { type: 'string' },
          title: { type: 'string' },
          case_no: { type: 'string' },
          year: { type: 'string' },
          subject: { type: 'string' },
          status: { type: 'string' },
          source_index: { type: 'integer' },
        },
        required: ['forum', 'title', 'subject'],
      },
    },
  },
  required: ['summary', 'cases'],
};
const PPLX_SYSTEM =
  'You are a legal research assistant for India. List lawsuits, court cases, tribunal (NCLT, NCLAT, consumer ' +
  'commission, ITAT etc.), arbitration and regulator proceedings involving the named organisation that your ' +
  'sources mention. Never invent case numbers, parties or outcomes: leave a field empty if the source does not ' +
  'state it. If a source states how many cases the organisation is facing, report it in reported_case_count. ' +
  'source_index is the 1-based number of the source the case comes from. If nothing is found, return an empty list.';
const PPLX_DOMAINS = [
  'indiankanoon.org', 'livelaw.in', 'barandbench.com', 'casemine.com', 'verdictum.in',
  'latestlaws.com', 'sci.gov.in', 'scconline.com',
];

// Web results are cached for a day: each Perplexity search costs ~$0.006-0.008.
const webCache = new Map();
const WEB_TTL_MS = 24 * 60 * 60 * 1000;

async function searchWeb(name) {
  const hit = webCache.get(name);
  if (hit && Date.now() - hit.at < WEB_TTL_MS) return { ...hit.data, cached: true };

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
    body: JSON.stringify({
      model: 'sonar',
      temperature: 0,
      web_search_options: { search_context_size: 'medium' },
      search_domain_filter: PPLX_DOMAINS,
      response_format: { type: 'json_schema', json_schema: { schema: PPLX_SCHEMA } },
      messages: [
        { role: 'system', content: PPLX_SYSTEM },
        {
          role: 'user',
          content: `Find court cases, lawsuits and legal disputes involving "${name}" in Indian courts ` +
            '(Supreme Court, High Courts, NCLT, consumer commissions, tribunals).',
        },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);

  const out = JSON.parse(body.choices[0].message.content);
  const data = {
    summary: out.summary,
    reported_case_count: out.reported_case_count || null,
    cases: out.cases || [],
    sources: body.citations || [],
    cost: body.usage?.cost?.total_cost ?? null,
  };
  webCache.set(name, { at: Date.now(), data });
  log(`Perplexity lawsuit search "${name}": ${data.cases.length} cases, $${data.cost}`);
  return data;
}

function registerLawsuitRoutes(app) {
  app.get('/lawsuits', (req, res) => {
    res.sendFile(path.join(DATA_DIR, 'lawsuits.html'));
  });

  // Autocomplete: party names containing the query, companies first.
  app.get('/api/lawsuits/suggest', (req, res) => {
    const q = cleanQuery(req.query.q);
    if (q.length < 2) return res.json({ names: [] });
    try {
      const names = getDb().prepare(`
        SELECT name, type, cases FROM party_names WHERE name LIKE ? ESCAPE '\\'
        ORDER BY type = 'company' DESC, cases DESC LIMIT 12`).all(likePattern(q));
      res.json({ names });
    } catch (err) {
      log(`Lawsuit suggest failed: ${err.message}`);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // Rajasthan HC cases for a party: summary counts plus a page of cases.
  app.get('/api/lawsuits', (req, res) => {
    const q = cleanQuery(req.query.q);
    const exact = req.query.exact === '1';
    const city = ['jaipur', 'jodhpur'].includes(req.query.city) ? req.query.city : null;
    const side = { p: 'P', r: 'R' }[req.query.side?.toLowerCase()] || null;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters' });

    try {
      const d = getDb();
      const names = matchNames(d, q, exact);
      const ids = names.map(n => n.id);
      if (!ids.length) {
        return res.json({ q, exact, names: [], total: 0, as_petitioner: 0, as_respondent: 0, by_city: [], by_type: [], by_year: [], page, limit, records: [] });
      }

      // Matched case ids with the side(s) the party is on; a temp table keeps
      // the follow-up queries simple for names matching thousands of cases.
      d.exec(`DROP TABLE IF EXISTS temp.hits; CREATE TEMP TABLE hits (case_id INTEGER PRIMARY KEY, sides TEXT)`);
      d.prepare(`
        INSERT INTO temp.hits
        SELECT case_id, GROUP_CONCAT(DISTINCT side) FROM case_parties
        WHERE party_id IN (SELECT value FROM json_each(?)) GROUP BY case_id`).run(JSON.stringify(ids));

      const filter = [];
      const params = [];
      if (city) { filter.push('c.city = ?'); params.push(city); }
      if (side) { filter.push(`h.sides LIKE ?`); params.push(`%${side}%`); }
      const where = filter.length ? `WHERE ${filter.join(' AND ')}` : '';
      const from = `FROM temp.hits h JOIN cases c ON c.id = h.case_id ${where}`;

      const totals = d.prepare(`
        SELECT COUNT(*) AS total,
               SUM(h.sides LIKE '%P%') AS as_petitioner,
               SUM(h.sides LIKE '%R%') AS as_respondent,
               MAX(c.last_date) AS latest
        ${from}`).get(...params);
      const groupBy = (col, extra = '') =>
        d.prepare(`SELECT ${col} AS key, COUNT(*) AS n ${from} GROUP BY ${col} ${extra}`).all(...params);
      const records = d.prepare(`
        SELECT c.city, c.case_no, c.case_type, c.year, c.first_date, c.last_date, c.hearings,
               c.petitioners, c.respondents, c.p_advocates, c.r_advocates, h.sides
        ${from} ORDER BY c.last_date DESC, c.case_no LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
      const coverage = d.prepare(`SELECT MIN(first_date) AS from_date, MAX(last_date) AS to_date FROM cases`).get();

      res.json({
        q,
        exact,
        coverage,
        names: names.slice(0, 30),
        name_count: names.length,
        total: totals.total,
        as_petitioner: totals.as_petitioner || 0,
        as_respondent: totals.as_respondent || 0,
        latest: totals.latest,
        by_city: groupBy('c.city', 'ORDER BY n DESC'),
        by_type: groupBy('c.case_type', 'ORDER BY n DESC LIMIT 10'),
        by_year: groupBy('c.year', 'ORDER BY key DESC'),
        page,
        limit,
        records,
      });
    } catch (err) {
      log(`Lawsuit search failed for "${q}": ${err.message}`);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // Other courts, from the web (Perplexity).
  app.get('/api/lawsuits/web', async (req, res) => {
    const q = cleanQuery(req.query.q);
    if (q.length < 3) return res.status(400).json({ error: 'Type at least 3 characters' });
    if (!process.env.PERPLEXITY_API_KEY) return res.status(503).json({ error: 'Web search is not configured' });
    try {
      res.json(await searchWeb(q));
    } catch (err) {
      log(`Perplexity lawsuit search failed for "${q}": ${err.message}`);
      res.status(502).json({ error: 'Web search failed' });
    }
  });
}

module.exports = { registerLawsuitRoutes };
