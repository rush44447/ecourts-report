const express = require('express');
const fsp = require('fs').promises;
const path = require('path');

const { log } = require('../utils/logger');

const PORT = 5051;
const DATA_DIR = path.join(__dirname, '..', 'ecourts');

// Traffic is very low, so instead of holding every dataset in memory for the
// process lifetime we load only the dataset a request needs, then release it as
// soon as the response finishes (see withDataset below). Each city maps to its
// own (large) JSON file.
const CITY_FILES = {
  jodhpur: 'data1.json',
  jaipur: 'data2.json',
};

// Load + transform + sort a single dataset file. Async so the ~10-16MB read +
// parse never blocks the event loop (the mail scheduler shares this process).
async function loadAndPrepare(file) {
  const raw = await fsp.readFile(path.join(DATA_DIR, file), 'utf-8');
  const json = JSON.parse(raw);

  const result = {};

  for (const key in json) {
    result[key.toLowerCase()] = Object.entries(json[key])
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }

  return result;
}

// Interceptor: lazily load ONLY the requested city's dataset, attach it to the
// request, and register a destroyer that frees it once the response is done.
async function withDataset(req, res, next) {
  const city = req.query.city?.toLowerCase();
  const file = CITY_FILES[city];
  if (!file) return res.status(400).json({ error: 'Invalid city or type' });

  try {
    req.citySource = await loadAndPrepare(file);
  } catch (err) {
    log(`Failed to load dataset "${file}" for city "${city}": ${err.message}`);
    return res.status(500).json({ error: 'Failed to load dataset' });
  }

  // Destroyer: drop the reference to the big object the moment the response is
  // sent so it can be garbage-collected between (infrequent) requests instead of
  // lingering in memory. `finish` = response sent, `close` = client aborted.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    req.citySource = null;
    // Best-effort immediate reclaim. Only available when node is started with
    // --expose-gc; otherwise V8 collects on its own schedule (still freed).
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) { /* ignore */ }
    }
  };
  res.once('finish', release);
  res.once('close', release);

  next();
}

function startEcourtsApi() {
  const app = express();

  app.get('/api/search', withDataset, (req, res) => {
    const type = req.query.type?.toLowerCase();
    const q = (req.query.q || '').toLowerCase().trim();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const dataset = req.citySource?.[type];
    if (!dataset) return res.status(400).json({ error: 'Invalid city or type' });

    const filtered = q ? dataset.filter(r => r.name.toLowerCase().includes(q)) : dataset;
    const start = (page - 1) * limit;

    res.json({
      total: filtered.length,
      page,
      limit,
      records: filtered.slice(start, start + limit)
    });
  });

  app.get('/api/data', withDataset, (req, res) => {
    const type = req.query.type?.toLowerCase();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const dataset = req.citySource?.[type];

    if (!dataset) {
      return res.status(400).json({ error: 'Invalid city or type' });
    }

    const start = (page - 1) * limit;

    res.json({
      total: dataset.length,
      page,
      limit,
      records: dataset.slice(start, start + limit)
    });
  });

  // Company/individual label per party name, written by ecourts-report
  // (classify scripts) into party-types.json as { name: 'c' | 'i' }.
  let partyTypes = null;
  let partyTypesMtime = 0;
  async function loadPartyTypes() {
    const file = path.join(DATA_DIR, 'party-types.json');
    const { mtimeMs } = await fsp.stat(file);
    if (!partyTypes || mtimeMs !== partyTypesMtime) {
      partyTypes = JSON.parse(await fsp.readFile(file, 'utf-8'));
      partyTypesMtime = mtimeMs;
    }
    return partyTypes;
  }

  // Parties that are regularly before the court: matters listed per party on a
  // day, in a month, or overall. Built by ecourts-report (report.js) into
  // parties-<city>.json: { days: { date: rows }, months: { month: rows }, all: rows }
  // with rows [name, 'P'|'R', count]; only parties with 2+ matters are kept.
  app.get('/api/parties', async (req, res) => {
    const city = req.query.city?.toLowerCase();
    if (!CITY_FILES[city]) return res.status(400).json({ error: 'Invalid city' });
    const period = ['day', 'month', 'all'].includes(req.query.period) ? req.query.period : 'day';
    const side = { p: 'P', r: 'R' }[req.query.side?.toLowerCase()] || null;
    const q = (req.query.q || '').toLowerCase().trim();
    const kind = { company: 'c', individual: 'i' }[req.query.kind?.toLowerCase()] || null;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 10, 100);

    let types = null;
    if (kind) {
      try {
        types = await loadPartyTypes();
      } catch (err) {
        log(`Failed to load party types: ${err.message}`);
        return res.status(500).json({ error: 'Failed to load party types' });
      }
    }

    let data;
    try {
      data = JSON.parse(await fsp.readFile(path.join(DATA_DIR, `parties-${city}.json`), 'utf-8'));
    } catch (err) {
      log(`Failed to load parties for "${city}": ${err.message}`);
      return res.status(500).json({ error: 'Failed to load parties' });
    }

    const days = Object.keys(data.days).sort();
    const months = Object.keys(data.months).sort();
    let key = req.query.key || null;
    let rows;
    if (period === 'all') {
      key = null;
      rows = data.all;
    } else {
      const bucket = period === 'day' ? data.days : data.months;
      key ||= (period === 'day' ? days : months).at(-1) || null;
      rows = bucket[key] || [];
    }

    // One record per party: matters as petitioner + as respondent.
    const byName = new Map();
    for (const [name, s, count] of rows) {
      if (side && s !== side) continue;
      if (q && !name.toLowerCase().includes(q)) continue;
      // Unlabelled names count as individuals.
      if (types && (types[name] || 'i') !== kind) continue;
      const r = byName.get(name) || { name, count: 0, petitioner: 0, respondent: 0 };
      r.count += count;
      r[s === 'P' ? 'petitioner' : 'respondent'] += count;
      byName.set(name, r);
    }
    const records = [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const start = (page - 1) * limit;

    res.json({
      period,
      key,
      kind: kind ? req.query.kind.toLowerCase() : 'all',
      days,
      months,
      generated_at: data.generated_at,
      total: records.length,
      page,
      limit,
      records: records.slice(start, start + limit),
    });
  });

  app.get('/', (req, res) => {
    res.sendFile(path.join(DATA_DIR, 'index.html'));
  });

  app.listen(PORT, '0.0.0.0', () => {
    log(`Ecourts API running on port ${PORT}`);
  });
}

module.exports = { startEcourtsApi };
