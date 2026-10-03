#!/usr/bin/env node
// Build reports from data/causelist.db.
//
//   node report.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out reports]
//
// Writes, per city:
//   <city>.json       { Practitioner: {NAME: count}, Respondent: {...} }
//                     (same shape as the website's data1.json / data2.json)
//   <city>.meta.json  date range + totals actually covered
//   <city>.xlsx       Practitioner and Respondent sheets
// and prints coverage + top names.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const XLSX = require('xlsx');
const store = require('./src/db');
const { CITIES } = require('./src/hcraj');

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string', default: path.join(__dirname, 'reports') },
    top: { type: 'string', default: '10' },
  },
});

const db = store.open();
fs.mkdirSync(args.out, { recursive: true });

for (const city of Object.keys(CITIES)) {
  const cov = store.coverage(db, city, args.from, args.to);
  if (!cov.days) {
    console.log(`${city}: no data in range`);
    continue;
  }
  const data = store.counts(db, city, args.from, args.to);
  const meta = {
    city,
    from: cov.first,
    to: cov.last,
    days_scraped: cov.days,
    pdfs: cov.pdfs,
    practitioners: Object.keys(data.Practitioner).length,
    respondents: Object.keys(data.Respondent).length,
    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(args.out, `${city}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(args.out, `${city}.meta.json`), JSON.stringify(meta, null, 2));

  const wb = XLSX.utils.book_new();
  for (const key of ['Practitioner', 'Respondent']) {
    const rows = Object.entries(data[key]).map(([name, count]) => ({ Name: name, Count: count }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), key);
  }
  XLSX.writeFile(wb, path.join(args.out, `${city}.xlsx`));

  console.log(`\n${city.toUpperCase()}  ${meta.from} → ${meta.to}  (${meta.days_scraped} days, ${meta.pdfs} pdfs)`);
  for (const key of ['Practitioner', 'Respondent']) {
    const top = Object.entries(data[key]).slice(0, Number(args.top));
    console.log(`  ${key} (${Object.keys(data[key]).length} names): ` + top.map(([n, c]) => `${n} ${c}`).join(', '));
  }
}
console.log(`\nwritten to ${args.out}`);
db.close();
