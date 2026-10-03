#!/usr/bin/env node
// Download + parse cause lists for a date range into data/causelist.db.
// Safe to re-run: finished days and PDFs are skipped (use --force to redo).
//
//   node scrape.js --from 2026-04-06 [--to 2026-10-03] [--city jodhpur jaipur]
//                  [--concurrency 3] [--force] [--keep-pdfs]

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { CITIES, listPdfs, downloadPdf, sleep } = require('./src/hcraj');
const { parsePdf } = require('./src/parser');
const store = require('./src/db');
const { renormalize } = require('./src/resolve');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    city: { type: 'string', multiple: true },
    concurrency: { type: 'string', default: '3' },
    force: { type: 'boolean', default: false },
    'keep-pdfs': { type: 'boolean', default: false },
  },
});

const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST
const cities = [...(args.city || []), ...positionals].filter(Boolean);
const CITY_LIST = cities.length ? cities : Object.keys(CITIES);
const CONCURRENCY = Math.max(1, Number(args.concurrency));
const DELAY_MS = 400; // per worker, between downloads

function* days(from, to) {
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

async function scrapeDay(db, city, date) {
  const pdfs = await listPdfs(city, date);
  const todo = pdfs.filter((p) => args.force || !store.isPdfDone(db, city, p.file));
  let rows = 0;
  let cases = 0;
  const failed = [];

  const queue = [...todo];
  const worker = async () => {
    for (let p; (p = queue.shift()); ) {
      const buf = await downloadPdf(city, p.path);
      await sleep(DELAY_MS);
      if (!buf) {
        store.savePdf(db, city, date, p.file, [], 'missing');
        continue;
      }
      if (args['keep-pdfs']) {
        const dir = path.join(store.DATA_DIR, 'pdfs', city, date);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, p.file), buf);
      }
      try {
        const parsed = await parsePdf(buf);
        cases += parsed.length;
        rows += store.savePdf(db, city, date, p.file, parsed, 'ok');
      } catch (err) {
        failed.push(p.file);
        store.savePdf(db, city, date, p.file, [], 'parse_error');
        console.warn(`   parse error ${city} ${p.file}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  store.markDay(db, city, date, pdfs.length);
  console.log(
    `${date} ${city.padEnd(8)} pdfs=${String(pdfs.length).padStart(3)} new=${String(todo.length).padStart(3)} ` +
      `cases=${cases} appearances=${rows}${failed.length ? ` parse_errors=${failed.length}` : ''}`
  );
}

async function main() {
  if (!args.from) {
    console.error('usage: node scrape.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--city jodhpur jaipur]');
    process.exit(1);
  }
  for (const c of CITY_LIST) if (!CITIES[c]) throw new Error(`unknown city "${c}"`);
  const to = args.to || today();
  const db = store.open();

  for (const date of days(args.from, to)) {
    for (const city of CITY_LIST) {
      // Today's/future lists can still change, so only skip days safely in the past.
      if (!args.force && date < today() && store.isDayDone(db, city, date)) continue;
      await scrapeDay(db, city, date);
    }
  }
  // Split combined entries ("A SHAH B SHAH-R") using the whole db as dictionary.
  const r = renormalize(db, { from: args.from, to });
  console.log(`normalised ${r.before} -> ${r.after} appearances`);
  db.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
