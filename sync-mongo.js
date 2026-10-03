#!/usr/bin/env node
// Push monthly advocate counts from data/causelist.db to MongoDB (MONGODB_URI in .env).
//
//   node sync-mongo.js                    # every month in the local db
//   node sync-mongo.js --from 2026-09     # only months >= 2026-09 (e.g. after a daily scrape)
//
// Collections (database "ecourts"):
//   monthly_counts  { city, month: 'YYYY-MM', side: 'P'|'R', name, count }
//   coverage        { city, month, days, court_days, pdfs, first, last, updated_at }
//
// Each (city, month) is replaced as a whole, so re-running is idempotent.
// Full per-appearance detail stays in SQLite; monthly totals keep Atlas M0 small.

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const { parseArgs } = require('util');
const { MongoClient } = require('mongodb');
const store = require('./src/db');

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

  const countStmt = sqlite.prepare(
    `SELECT side, name, COUNT(*) AS count FROM appearances
     WHERE city = ? AND substr(date, 1, 7) = ? GROUP BY side, name`
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
    const cov = covStmt.get(city, month);
    await coverage.replaceOne(
      { city, month },
      { city, month, ...cov, updated_at: new Date() },
      { upsert: true }
    );
    console.log(`${month} ${city.padEnd(8)} ${docs.length} names, ${cov.court_days} court days`);
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
