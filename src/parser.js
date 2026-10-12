// Parses a Rajasthan High Court cause-list PDF using text positions.
//
// Every list is a TCPDF table with the header row
//
//   S.No. | Case Type/No | Title of The Case | Name of Advocate
//
// The advocate column is split in two: petitioner-side advocates on the left,
// respondent-side on the right, each name ending in "-P" / "-R" and possibly
// wrapping over several lines. Reading that column by position means party
// names ("STATE OF RAJASTHAN", "KOTAK ENTERPRISES") can never get glued onto an
// advocate's name, which is what the old regex-over-plain-text approach did.
//
// There are (at least) two layouts with different x offsets, e.g.
//   daily:          S.No x~55, case x~78, parties x~178, adv P x~345, R x~473
//   supplementary:  S.No x~22, case x~52, parties x~157, adv P x~332, R x~466
// so column boundaries are derived from each page's own header row. All cell
// text is left-aligned, so every line of a column starts at the same x.

const { normalizeName, isPerson, normalizeParty } = require('./names');

let pdfjsPromise;
function pdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

// "A B-P C D-P E" -> [['A B','P'], ['C D','P'], ['E', fallbackSide]]
function splitEntries(text, fallbackSide) {
  const out = [];
  const re = /-\s*([PR])(?=\s|$)/g;
  let pos = 0;
  let m;
  while ((m = re.exec(text))) {
    const name = text.slice(pos, m.index).trim();
    if (name) out.push([name, m[1]]);
    pos = m.index + m[0].length;
  }
  const tail = text.slice(pos).trim();
  if (tail) out.push([tail, fallbackSide]);
  return out;
}

function columnText(items) {
  return items
    .sort((a, b) => a.page - b.page || Math.round(a.y) - Math.round(b.y) || a.x - b.x)
    .map((i) => i.str.trim())
    .join(' ');
}

// The parties cell is "petitioner lines, (department note), respondent lines,
// (department note)" with no separator, and long names wrap. A department note
// between two names ends the petitioner. Otherwise the boundary is the line
// break that best looks like a new name rather than a wrap.
const JOINS_NEXT = /(?:\b(?:OF|S\/O|D\/O|W\/O|H\/O|C\/O|SON|SHRI|SH|SMT|LATE|AND|THROUGH|THR|M\/S)|[&\-\/@])$/;
const CONTINUES = /^(?:S\/O|D\/O|W\/O|H\/O|C\/O|SON\b|DAUGHTER\b|WIFE\b|HUSBAND\b|THROUGH\b|PVT\b|PRIVATE\b|LTD\b|LIMITED\b|LLP\b|&|AND\b|OF\b|@)/;
const STARTS_PARTY = /^(?:THE\b|STATE OF\b|UNION OF\b|M\s*\/\s*S\b|MESSRS\b)/;

function boundaryScore(a, b, maxWidth) {
  const as = a.str.trim().toUpperCase();
  const bs = b.str.trim().toUpperCase();
  if (JOINS_NEXT.test(as) || CONTINUES.test(bs)) return -10;
  let score = STARTS_PARTY.test(bs) ? 5 : 0;
  // Would b's first word have fitted on a's line? Then a didn't wrap.
  const need = a.width + (b.width / bs.length) * (bs.split(/\s+/)[0].length + 1);
  if (need < maxWidth - 4) score += 3;
  else if (need > maxWidth + 4) score -= 2;
  return score;
}

// -> [petitioner, respondent?] as raw text
function splitParties(lines, maxWidth) {
  const runs = [[]]; // name lines, split wherever a "( ... )" note sits
  let depth = 0;
  for (const l of lines) {
    const s = l.str.trim();
    if (depth > 0 || s.startsWith('(')) {
      for (const ch of s) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
      depth = Math.max(depth, 0);
      if (runs[runs.length - 1].length) runs.push([]);
      continue;
    }
    if (/^IN RE-?$/i.test(s)) continue;
    runs[runs.length - 1].push(l);
  }
  const named = runs.filter((r) => r.length);
  const text = (r) => r.map((l) => l.str.trim()).join(' ');
  if (named.length >= 2) return [text(named[0]), text(named[1])];
  const run = named[0] || [];
  if (run.length < 2) return run.length ? [text(run)] : [];
  let best = null;
  for (let k = 1; k < run.length; k++) {
    const score = boundaryScore(run[k - 1], run[k], maxWidth);
    if (score > -10 && (!best || score > best.score)) best = { k, score };
  }
  return best ? [text(run.slice(0, best.k)), text(run.slice(best.k))] : [text(run)];
}

// Column boundaries from the header row, or null if this page has no table.
function pageColumns(items) {
  const find = (re) => items.find((i) => re.test(i.str.trim()));
  const sno = find(/^S\.?\s*No\.?$/i);
  const kase = find(/^Case Type/i);
  const title = find(/^Title of The Case/i);
  const adv = find(/^Name of Advocate/i);
  if (!sno || !kase || !title || !adv) return null;
  return {
    top: Math.max(sno.y, kase.y, title.y, adv.y) + 2,
    snoMaxX: sno.x + 18, //            S.No content sits a few pt right of its header
    caseMaxX: kase.x + 10, //          case-no content sits ~15pt left of its header
    advMinX: title.x + 60, //          parties start left of their header, advocates far right
    splitX: adv.x, //                  P sub-column starts left of the header, R right of it
  };
}

// Returns [{ sno, caseNo, advocates: [{ name, side, raw }], parties: [{ name, side, raw }] }]
// parties holds the first-named petitioner (P) and respondent (R).
async function parsePdf(buffer) {
  const { getDocument } = await pdfjs();
  const task = getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  const doc = await task.promise;
  const cases = [];
  let current = null; // a case row can continue onto the next page

  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const height = page.getViewport({ scale: 1 }).height;
      const { items: raw } = await page.getTextContent();
      const items = raw
        .filter((i) => i.str && i.str.trim())
        .map((i) => ({ page: p, x: i.transform[4], y: height - i.transform[5], width: i.width, str: i.str }));

      const col = pageColumns(items);
      if (!col) continue; // notices / cover page

      // Footer line: "dd/mm/yyyy  hh:mm:ssPM  Page x of y  Bench Id : n"
      const footer = items.find((i) => /^Page \d+ of \d+/.test(i.str.trim()) && i.y > col.top);
      const bottom = footer ? footer.y - 5 : height;
      const body = items.filter((i) => i.y > col.top && i.y < bottom);
      // Widest a parties line can be: from its left edge to the advocate column.
      const titleX = Math.min(...body.filter((i) => i.x >= col.caseMaxX && i.x < col.advMinX).map((i) => i.x));
      const advX = Math.min(...body.filter((i) => i.x >= col.advMinX).map((i) => i.x));
      const partyWidth = advX - titleX - 3;

      const starts = body
        .filter((i) => i.x < col.snoMaxX && /^\d+$/.test(i.str.trim()))
        .sort((a, b) => a.y - b.y);

      // Row r spans [start_r, start_r+1). The slice above the first S.No on a page
      // belongs to the case carried over from the previous page.
      const bounds = [{ y: -Infinity, sno: null }, ...starts.map((s) => ({ y: s.y, sno: s.str.trim() }))];
      for (let r = 0; r < bounds.length; r++) {
        const yFrom = bounds[r].y - 3;
        const yTo = r + 1 < bounds.length ? bounds[r + 1].y - 3 : Infinity;
        const row = body.filter((i) => i.y >= yFrom && i.y < yTo);

        if (bounds[r].sno !== null) {
          const caseLines = row
            .filter((i) => i.x >= col.snoMaxX && i.x < col.caseMaxX)
            .sort((a, b) => a.y - b.y)
            .map((i) => i.str.trim());
          const urn = caseLines.findIndex((s) => /^URN/i.test(s));
          current = {
            sno: bounds[r].sno,
            caseNo: caseLines.slice(0, urn === -1 ? 1 : urn).join(' '),
            advocates: [],
            parties: [],
            _partyWidth: partyWidth,
            _items: { P: [], R: [], T: [] },
          };
          cases.push(current);
        }
        if (!current) continue;
        for (const i of row) {
          if (i.x >= col.advMinX) current._items[i.x < col.splitX ? 'P' : 'R'].push(i);
          else if (i.x >= col.caseMaxX) current._items.T.push(i);
        }
      }
    }
  } finally {
    await task.destroy();
  }

  for (const c of cases) {
    for (const side of ['P', 'R']) {
      for (const [raw, s] of splitEntries(columnText(c._items[side]), side)) {
        const name = normalizeName(raw);
        if (isPerson(name)) c.advocates.push({ name, side: s, raw });
      }
    }
    const lines = c._items.T.sort((a, b) => a.page - b.page || a.y - b.y);
    const [pet, res] = splitParties(lines, c._partyWidth);
    for (const [raw, side] of [[pet, 'P'], [res, 'R']]) {
      const name = raw && normalizeParty(raw);
      if (name) c.parties.push({ name, side, raw });
    }
    delete c._items;
    delete c._partyWidth;
  }
  return cases;
}

module.exports = { parsePdf, splitEntries, splitParties };
