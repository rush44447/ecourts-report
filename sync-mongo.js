#!/usr/bin/env node
// Push monthly advocate counts from data/causelist.db to MongoDB (MONGODB_URI in .env).
//
//   node sync-mongo.js                    # every month in the local db
//   node sync-mongo.js --from 2026-09     # only months >= 2026-09 (e.g. after a daily scrape)
//
// Collections (database "ecourts"):
//   monthly_counts  { city, month: 'YYYY-MM', side: 'P'|'R', name, count }
//   coverage        { city, month, days, court_days, pdfs, first, last, updated_at }
//   party_daily_counts    { city, date: 'YYYY-MM-DD', month, side: 'P'|'R', name, count }
//   party_monthly_counts  { city, month, side, name, count }
//                   matters per party (first-named petitioner / respondent). Only
//                   count >= 2, so one-off individual litigants don't bloat Atlas.
//   legacy_counts   { city, side, name, count, period_from, period_to }
//                   cleaned totals from the old undated JSON (import-legacy.js)
//
// Each (city, month) is replaced as a whole, so re-running is idempotent.
// Full per-appearance detail stays in SQLite; monthly totals keep Atlas M0 small.

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const { parseArgs } = require('util');
const { MongoClient } = require('mongodb');
const store = require('./src/db');

const MIN_PARTY_COUNT = 2;

const { values: args } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' }, db: { type: 'string', default: 'ecourts' } },
});

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing in .env');
  const sqlite = store.open();
  const months = sqlite
    .prepare(
      `SELECT DISTINCT city, substr(date, 1, 7) AS month FROM days
       WHERE (? IS NULL OR substr(date, 1, 7) >= ?) AND (? IS NULL OR substr(date, 1, 7) <= ?)
       ORDER BY month, city`
    )
    .all(args.from ?? null, args.from ?? null, args.to ?? null, args.to ?? null);

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(args.db);
  const counts = db.collection('monthly_counts');
  const coverage = db.collection('coverage');
  await counts.createIndexes([
    { key: { city: 1, month: 1, side: 1, name: 1 }, unique: true },
    { key: { city: 1, side: 1, name: 1 } },
  ]);
  await coverage.createIndex({ city: 1, month: 1 }, { unique: true });
  const partyDaily = db.collection('party_daily_counts');
  const partyMonthly = db.collection('party_monthly_counts');
  await partyDaily.createIndexes([
    { key: { city: 1, date: 1, side: 1, name: 1 }, unique: true },
    { key: { city: 1, month: 1 } },
    { key: { city: 1, date: 1, count: -1 } },
  ]);
  await partyMonthly.createIndexes([
    { key: { city: 1, month: 1, side: 1, name: 1 }, unique: true },
    { key: { city: 1, side: 1, name: 1 } },
  ]);

  const countStmt = sqlite.prepare(
    `SELECT side, name, COUNT(*) AS count FROM appearances
     WHERE city = ? AND substr(date, 1, 7) = ? GROUP BY side, name`
  );
  const partyDailyStmt = sqlite.prepare(
    `SELECT date, side, name, COUNT(*) AS count FROM parties
     WHERE city = ? AND substr(date, 1, 7) = ? GROUP BY date, side, name HAVING count >= ${MIN_PARTY_COUNT}`
  );
  const partyMonthlyStmt = sqlite.prepare(
    `SELECT side, name, COUNT(*) AS count FROM parties
     WHERE city = ? AND substr(date, 1, 7) = ? GROUP BY side, name HAVING count >= ${MIN_PARTY_COUNT}`
  );
  const covStmt = sqlite.prepare(
    `SELECT COUNT(*) AS days, SUM(n_pdfs > 0) AS court_days, SUM(n_pdfs) AS pdfs,
            MIN(date) AS first, MAX(date) AS last
     FROM days WHERE city = ? AND substr(date, 1, 7) = ?`
  );

  for (const { city, month } of months) {
    const docs = countStmt.all(city, month).map((r) => ({ city, month, side: r.side, name: r.name, count: r.count }));
    await counts.deleteMany({ city, month });
    for (let i = 0; i < docs.length; i += 5000) {
      await counts.insertMany(docs.slice(i, i + 5000), { ordered: false });
    }
    const daily = partyDailyStmt.all(city, month).map((r) => ({ city, month, ...r }));
    const monthly = partyMonthlyStmt.all(city, month).map((r) => ({ city, month, ...r }));
    for (const [coll, rows] of [[partyDaily, daily], [partyMonthly, monthly]]) {
      await coll.deleteMany({ city, month });
      for (let i = 0; i < rows.length; i += 5000) await coll.insertMany(rows.slice(i, i + 5000), { ordered: false });
    }
    const cov = covStmt.get(city, month);
    await coverage.replaceOne(
      { city, month },
      { city, month, ...cov, updated_at: new Date() },
      { upsert: true }
    );
    console.log(
      `${month} ${city.padEnd(8)} ${docs.length} names, ${monthly.length} parties (${daily.length} daily), ` +
        `${cov.court_days} court days`
    );
  }

  // Legacy totals: small, so always replaced in full.
  const legacy = db.collection('legacy_counts');
  await legacy.createIndexes([{ key: { city: 1, side: 1, name: 1 }, unique: true }, { key: { city: 1, side: 1, count: -1 } }]);
  for (const city of sqlite.prepare('SELECT DISTINCT city FROM legacy_counts').all().map((r) => r.city)) {
    const docs = sqlite
      .prepare('SELECT city, side, name, count, period_from, period_to FROM legacy_counts WHERE city = ?')
      .all(city)
      .map((r) => ({ ...r }));
    await legacy.deleteMany({ city });
    for (let i = 0; i < docs.length; i += 5000) await legacy.insertMany(docs.slice(i, i + 5000), { ordered: false });
    console.log(`legacy  ${city.padEnd(8)} ${docs.length} names (${docs[0]?.period_from} → ${docs[0]?.period_to})`);
  }

  const stats = await db.command({ dbStats: 1 });
  console.log(`done. db size ${(stats.dataSize / 1048576).toFixed(1)} MB data, ${(stats.indexSize / 1048576).toFixed(1)} MB indexes`);
  await client.close();
  sqlite.close();
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
