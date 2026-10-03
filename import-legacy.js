#!/usr/bin/env node
// Clean and store the old undated counts (website's data1.json / data2.json),
// produced before this scraper by a regex that glued party names onto advocates.
//
//   node import-legacy.js --city jodhpur --file data/legacy/jodhpur.json \
//        --period-from 2021-04-06 --period-to 2026-04-05
//
// Run it after the new data is scraped: names from the new data are the main
// dictionary for recovering the advocate at the end of each dirty key.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const store = require('./src/db');
const { cleanLegacy } = require('./src/legacy');

const { values: args } = parseArgs({
  options: {
    city: { type: 'string' },
    file: { type: 'string' },
    'period-from': { type: 'string', default: '2021-04-06' },
    'period-to': { type: 'string', default: '2026-04-05' },
  },
});
if (!args.city || !args.file) {
  console.error('usage: node import-legacy.js --city jodhpur --file data/legacy/jodhpur.json');
  process.exit(1);
}

const db = store.open();
const known = new Map(db.prepare('SELECT name, COUNT(*) AS n FROM appearances GROUP BY name').all().map((r) => [r.name, r.n]));
const legacy = JSON.parse(fs.readFileSync(args.file, 'utf8'));
const { data, stats } = cleanLegacy(legacy, known);

const side = { Practitioner: 'P', Respondent: 'R' };
const ins = db.prepare('INSERT INTO legacy_counts VALUES (?,?,?,?,?,?)');
db.exec('BEGIN');
db.prepare('DELETE FROM legacy_counts WHERE city = ?').run(args.city);
for (const [key, names] of Object.entries(data)) {
  for (const [name, count] of Object.entries(names)) {
    ins.run(args.city, side[key], name, count, args['period-from'], args['period-to']);
  }
}
db.exec('COMMIT');

const total = Object.values(legacy).flatMap((o) => Object.values(o)).reduce((a, b) => a + b, 0);
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`${args.city}: ${total} legacy appearances`);
console.log(`  resolved: exact ${pct(stats.exact)}, party prefix removed ${pct(stats.tail + stats.marker)}`);
console.log(`  unmatched ${pct(stats.unmatched)} (not stored), dropped non-names ${pct(stats.dropped)}`);
console.log(`  keys ${Object.keys(legacy.Practitioner).length}/${Object.keys(legacy.Respondent).length}` +
  ` -> ${Object.keys(data.Practitioner).length}/${Object.keys(data.Respondent).length} (Practitioner/Respondent)`);
const out = path.join(store.DATA_DIR, 'legacy', `${args.city}.unmatched.json`);
fs.writeFileSync(out, JSON.stringify(stats.unmatchedKeys, null, 1));
console.log(`  unmatched keys listed in ${out}`);
