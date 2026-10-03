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

const { normalizeName, isPerson } = require('./names');

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

// Returns [{ sno, caseNo, advocates: [{ name, side, raw }] }]
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
        .map((i) => ({ page: p, x: i.transform[4], y: height - i.transform[5], str: i.str }));

      const col = pageColumns(items);
      if (!col) continue; // notices / cover page

      // Footer line: "dd/mm/yyyy  hh:mm:ssPM  Page x of y  Bench Id : n"
      const footer = items.find((i) => /^Page \d+ of \d+/.test(i.str.trim()) && i.y > col.top);
      const bottom = footer ? footer.y - 5 : height;
      const body = items.filter((i) => i.y > col.top && i.y < bottom);

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
            _items: { P: [], R: [] },
          };
          cases.push(current);
        }
        if (!current) continue;
        for (const i of row) {
          if (i.x < col.advMinX) continue;
          current._items[i.x < col.splitX ? 'P' : 'R'].push(i);
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
    delete c._items;
  }
  return cases;
}

module.exports = { parsePdf, splitEntries };
