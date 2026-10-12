// Cause lists from the Rajasthan High Court "quick causelist" pages.
// No captcha, and unlike hcservices.ecourts.gov.in it serves Jodhpur PDFs too.

const CITIES = {
  jodhpur: 'https://hcraj.nic.in/quick-causelist-jdp/',
  jaipur: 'https://hcraj.nic.in/quick-causelist-jp/',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${label}: ${err.message}`);
      const wait = 5000 * attempt;
      console.warn(`   ${label} failed (${err.message}); retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

// -> [{ path (base64 server path), file: '30092026_2039_1001.pdf' }]
async function listPdfs(city, date /* 'YYYY-MM-DD' */) {
  const [year, month, day] = date.split('-');
  return withRetry(`list ${city} ${date}`, async () => {
    const res = await fetch(CITIES[city], {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ day, month, year }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const paths = [...new Set([...html.matchAll(/data-pdfpath='([^']+)'/g)].map((m) => m[1]))];
    return paths.map((path) => ({
      path,
      file: Buffer.from(path, 'base64').toString('utf8').split('/').pop(),
    }));
  });
}

// -> Buffer, or null when the site says the list is not available
async function downloadPdf(city, path) {
  return withRetry(`pdf ${city}`, async () => {
    const url = `${CITIES[city]}?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, 5).toString() === '%PDF-' ? buf : null;
  });
}

module.exports = { CITIES, listPdfs, downloadPdf, sleep };
