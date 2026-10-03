#!/usr/bin/env node
// Debug: print what the parser extracts from local PDF file(s).
//   node parse.js some.pdf [more.pdf ...]
const fs = require('fs');
const { parsePdf } = require('./src/parser');

(async () => {
  for (const file of process.argv.slice(2)) {
    const cases = await parsePdf(fs.readFileSync(file));
    console.log(`== ${file}: ${cases.length} cases`);
    for (const c of cases) {
      console.log(`${c.sno}\t${c.caseNo}\t${c.advocates.map((a) => `${a.name} [${a.side}]`).join(' | ')}`);
    }
  }
})();
