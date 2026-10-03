// SQLite store (node:sqlite, built into Node >= 22.13 — no native deps).
// Every appearance is kept with its date and source PDF, so counts can be
// rebuilt for any date range and we always know which dates are covered.

const path = require('path');
const fs = require('fs');

// node:sqlite prints an ExperimentalWarning on Node 22; it is stable enough here.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) =>
  String(w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...rest);
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.ECOURTS_DATA_DIR || path.join(__dirname, '..', 'data');
const SIDE_KEY = { P: 'Practitioner', R: 'Respondent' };

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'causelist.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS days (
      city TEXT, date TEXT, n_pdfs INTEGER, done_at TEXT,
      PRIMARY KEY (city, date));
    CREATE TABLE IF NOT EXISTS pdfs (
      city TEXT, date TEXT, file TEXT, status TEXT, n_cases INTEGER, fetched_at TEXT,
      PRIMARY KEY (city, file));
    CREATE TABLE IF NOT EXISTS appearances (
      city TEXT, date TEXT, file TEXT, sno TEXT, case_no TEXT,
      side TEXT, name TEXT, raw TEXT);
    CREATE INDEX IF NOT EXISTS ix_app_city_date ON appearances(city, date);
    CREATE INDEX IF NOT EXISTS ix_app_file ON appearances(city, file);
    CREATE INDEX IF NOT EXISTS ix_app_name ON appearances(name);
  `);
  return db;
}

function isDayDone(db, city, date) {
  return !!db.prepare('SELECT 1 FROM days WHERE city=? AND date=?').get(city, date);
}

function isPdfDone(db, city, file) {
  const row = db.prepare('SELECT status FROM pdfs WHERE city=? AND file=?').get(city, file);
  return row?.status === 'ok';
}

// Returns the number of appearance rows written.
function savePdf(db, city, date, file, cases, status) {
  const ins = db.prepare('INSERT INTO appearances VALUES (?,?,?,?,?,?,?,?)');
  let n = 0;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM appearances WHERE city=? AND file=?').run(city, file);
    for (const c of cases) {
      const seen = new Set(); // same advocate twice on one side of one case = 1 appearance
      for (const a of c.advocates) {
        const key = `${a.side}|${a.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ins.run(city, date, file, c.sno, c.caseNo, a.side, a.name, a.raw);
        n++;
      }
    }
    db.prepare("INSERT OR REPLACE INTO pdfs VALUES (?,?,?,?,?,datetime('now'))").run(
      city, date, file, status, cases.length
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

function markDay(db, city, date, nPdfs) {
  db.prepare("INSERT OR REPLACE INTO days VALUES (?,?,?,datetime('now'))").run(city, date, nPdfs);
}

// -> { Practitioner: { NAME: count }, Respondent: { ... } } sorted by count desc
function counts(db, city, from, to) {
  const out = { Practitioner: {}, Respondent: {} };
  const rows = db
    .prepare(
      `SELECT side, name, COUNT(*) AS n FROM appearances
       WHERE city = ? AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)
       GROUP BY side, name ORDER BY n DESC, name`
    )
    .all(city, from ?? null, from ?? null, to ?? null, to ?? null);
  for (const r of rows) out[SIDE_KEY[r.side]][r.name] = r.n;
  return out;
}

function coverage(db, city, from, to) {
  return db
    .prepare(
      `SELECT MIN(date) AS first, MAX(date) AS last, COUNT(*) AS days, SUM(n_pdfs) AS pdfs
       FROM days WHERE city = ? AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)`
    )
    .get(city, from ?? null, from ?? null, to ?? null, to ?? null);
}

module.exports = { DATA_DIR, open, isDayDone, isPdfDone, savePdf, markDay, counts, coverage };
