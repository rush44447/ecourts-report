// Turns a stored raw advocate string into final name(s), using a dictionary of
// how often each normalised name occurs overall.
//
// Some cells hold two advocates under one suffix: "MAHENDRA SHAH VIGYAN SHAH-R",
// "M SHAH/VIGYAN SHAH-R". When both halves are themselves established names,
// the entry is split and each advocate gets the appearance.

const { normalizeName, isPerson } = require('./names');

const MIN_PART = 30; // each half must occur at least this often on its own

function resolveNames(name, dict) {
  if (name.includes('/')) {
    const parts = name.split('/').map((p) => normalizeName(p)).filter(isPerson);
    if (parts.length > 1) return parts.flatMap((p) => resolveNames(p, dict));
  }
  const words = name.split(' ');
  if (words.length >= 3) {
    const own = dict.get(name) || 0;
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const left = words.slice(0, i).join(' ');
      const right = words.slice(i).join(' ');
      const l = dict.get(left) || 0;
      const r = dict.get(right) || 0;
      if (l >= MIN_PART && r >= MIN_PART && own < Math.min(l, r) && (!best || Math.min(l, r) > best.score)) {
        best = { left, right, score: Math.min(l, r) };
      }
    }
    if (best) return [best.left, ...resolveNames(best.right, dict)];
  }
  return [name];
}

// Re-derive every appearance's name from its raw text (after normaliser changes),
// split combined entries and re-apply the one-appearance-per-case rule.
function renormalize(db, { from, to } = {}) {
  const where = '(? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)';
  const range = [from ?? null, from ?? null, to ?? null, to ?? null];

  // Dictionary over the whole db (not just the range) so rare names still split well.
  const dict = new Map();
  for (const r of db.prepare('SELECT raw, COUNT(*) AS n FROM appearances GROUP BY raw').all()) {
    const n = normalizeName(r.raw);
    if (isPerson(n)) dict.set(n, (dict.get(n) || 0) + r.n);
  }

  const rows = db
    .prepare(`SELECT city, date, file, sno, case_no, side, raw FROM appearances WHERE ${where} ORDER BY city, file, sno`)
    .all(...range);
  const ins = db.prepare('INSERT INTO appearances VALUES (?,?,?,?,?,?,?,?)');
  let seen = new Set();
  let lastCase = null;
  let written = 0;

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM appearances WHERE ${where}`).run(...range);
    for (const r of rows) {
      const caseKey = `${r.city}|${r.file}|${r.sno}`;
      if (caseKey !== lastCase) {
        seen = new Set();
        lastCase = caseKey;
      }
      const base = normalizeName(r.raw);
      if (!isPerson(base)) continue;
      for (const name of resolveNames(base, dict)) {
        const key = `${r.side}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ins.run(r.city, r.date, r.file, r.sno, r.case_no, r.side, name, r.raw);
        written++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { before: rows.length, after: written, dict };
}

module.exports = { resolveNames, renormalize };
