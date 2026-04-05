const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const XLSX = require('xlsx');

const PDF_DIR = path.join(__dirname, 'pdfs');
const OUTPUT_DIR = path.join(__dirname, 'reports');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 📅 CHANGE THIS DATE
const REPORT_DATE = '2026-04-02';

const NAME_REGEX = /([A-Z\s]+)-(P|R)/g;

async function generateReport() {
  const pCounts = {};
  const rCounts = {};

  const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));
  console.log(`Processing ${files.length} PDFs`);

  let processed = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(PDF_DIR, file);

    try {
      const buffer = fs.readFileSync(filePath);

      const data = await pdf(buffer, {
        max: 0 // disable object limit (important for court PDFs)
      });

      const matches = data.text.match(NAME_REGEX) || [];

      matches.forEach(entry => {
        const m = entry.match(/([A-Z\s]+)-(P|R)/);
        if (!m) return;

        const name = m[1].trim();
        const type = m[2];

        if (type === 'P') {
          pCounts[name] = (pCounts[name] || 0) + 1;
        } else {
          rCounts[name] = (rCounts[name] || 0) + 1;
        }
      });

      processed++;
    } catch (err) {
      skipped++;
      console.warn(`⚠️ Skipping malformed PDF: ${file}`);
    }
  }

  console.log(`✔ Parsed PDFs: ${processed}`);
  console.log(`⚠ Skipped PDFs: ${skipped}`);

  // Prepare rows
  const pRows = Object.entries(pCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const rRows = Object.entries(rCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const max = Math.max(pRows.length, rRows.length);
  const rows = [];

  for (let i = 0; i < max; i++) {
    rows.push({
      'Practitioner Name': pRows[i]?.name || '',
      'Practitioner Count': pRows[i]?.count || '',
      'Respondent Name': rRows[i]?.name || '',
      'Respondent Count': rRows[i]?.count || ''
    });
  }

  // Write Excel
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, REPORT_DATE);

  const out = path.join(OUTPUT_DIR, `${REPORT_DATE}.xlsx`);
  XLSX.writeFile(wb, out);

  console.log(`✅ Report created: ${out}`);
}

generateReport().catch(err => {
  console.error('❌ Fatal error:', err);
});
