// Build data/lawsuits.db for the website's company lawsuit search: one row per
// case (city + case number) with its parties, advocates and hearing dates, and
// a party-name index labelled company / individual.
//
//   node build-lawsuits.js [party-types.json]
//
// party-types.json ({ name: 'c' | 'i' }, from classify/export.js) supplies the
// DeepSeek/rule labels; names missing from it are labelled with classify/rules.js.

const fs = require('fs');
const path = require('path');
const store = require('./src/db');
const { DatabaseSync } = require('node:sqlite');
const { classify } = require('./classify/rules');

const OUT = path.join(__dirname, 'data', 'lawsuits.db');
const typesFile = process.argv[2];
const labels = typesFile ? JSON.parse(fs.readFileSync(typesFile, 'utf-8')) : {};

const src = store.open();
fs.rmSync(OUT, { force: true });
const db = new DatabaseSync(OUT);
db.exec(`
  CREATE TABLE cases (
    id INTEGER PRIMARY KEY, city TEXT, case_no TEXT, case_type TEXT, year INTEGER,
    first_date TEXT, last_date TEXT, hearings INTEGER,
    petitioners TEXT, respondents TEXT, p_advocates TEXT, r_advocates TEXT);
  CREATE TABLE party_names (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE, type TEXT, cases INTEGER, as_p INTEGER, as_r INTEGER);
  CREATE TABLE case_parties (case_id INTEGER, party_id INTEGER, side TEXT);
`);

// "S.B. CIVIL WRIT PETITION 12656/2026" -> type + filing year
function splitCaseNo(caseNo) {
  const m = caseNo.match(/^(.*?)\s*(\d+)\s*\/\s*(\d{4})\s*$/);
  return m ? { type: m[1].trim() || null, year: Number(m[3]) } : { type: null, year: null };
}

const byCase = new Map(); // city|case_no -> case row
const key = (city, caseNo) => `${city}|${caseNo}`;

for (const r of src.prepare(`
  SELECT city, case_no, MIN(date) AS first, MAX(date) AS last, COUNT(DISTINCT date) AS hearings
  FROM parties WHERE case_no IS NOT NULL AND case_no <> '' GROUP BY city, case_no`).iterate()) {
  byCase.set(key(r.city, r.case_no), {
    ...r, ...splitCaseNo(r.case_no), P: new Set(), R: new Set(), advP: new Set(), advR: new Set(),
  });
}
for (const r of src.prepare(`SELECT DISTINCT city, case_no, side, name FROM parties`).iterate()) {
  const c = byCase.get(key(r.city, r.case_no));
  if (c && (r.side === 'P' || r.side === 'R')) c[r.side].add(r.name);
}
for (const r of src.prepare(`SELECT DISTINCT city, case_no, side, name FROM appearances`).iterate()) {
  const c = byCase.get(key(r.city, r.case_no));
  if (c && (r.side === 'P' || r.side === 'R')) c[r.side === 'P' ? 'advP' : 'advR'].add(r.name);
}

const names = new Map(); // name -> { id, type, cases, as_p, as_r }
const insCase = db.prepare(`INSERT INTO cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const insLink = db.prepare(`INSERT INTO case_parties VALUES (?,?,?)`);
const join = set => [...set].join(' | ');

db.exec('BEGIN');
let caseId = 0;
for (const c of byCase.values()) {
  caseId++;
  insCase.run(caseId, c.city, c.case_no, c.type, c.year, c.first, c.last, c.hearings,
    join(c.P), join(c.R), join(c.advP), join(c.advR));
  for (const side of ['P', 'R']) {
    for (const name of c[side]) {
      let n = names.get(name);
      if (!n) {
        const label = labels[name];
        const type = label ? (label === 'c' ? 'company' : 'individual') : classify(name).type;
        n = { id: names.size + 1, type, cases: new Set(), as_p: 0, as_r: 0 };
        names.set(name, n);
      }
      n.cases.add(caseId);
      n[side === 'P' ? 'as_p' : 'as_r']++;
      insLink.run(caseId, n.id, side);
    }
  }
}
const insName = db.prepare(`INSERT INTO party_names VALUES (?,?,?,?,?,?)`);
for (const [name, n] of names) insName.run(n.id, name, n.type, n.cases.size, n.as_p, n.as_r);
db.exec('COMMIT');

db.exec(`
  CREATE INDEX ix_cp_party ON case_parties(party_id);
  CREATE INDEX ix_cp_case ON case_parties(case_id);
  CREATE INDEX ix_names_cases ON party_names(cases DESC);
  VACUUM;
`);
const companies = [...names.values()].filter(n => n.type === 'company').length;
console.log(`${caseId} cases, ${names.size} party names (${companies} companies) -> ${OUT} ` +
  `(${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
