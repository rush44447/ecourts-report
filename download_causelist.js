const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {

  const DOWNLOAD_DIR = path.join(__dirname, 'pdfs');
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();

  // ✅ Enable PDF downloads
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });

  console.log('Opening causelist page...');

  await page.goto(
    'https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/highcourt_causelist.php?state_cd=9&dist_cd=1&court_code=1&stateNm=Rajasthan',
    { waitUntil: 'domcontentloaded', timeout: 60000 }
  );

  const DATE = '02-04-2026';

  console.log('Setting date...');

  await page.waitForSelector('#causelist_dt', { timeout: 20000 });

  await page.evaluate((date) => {
    const input = document.querySelector('#causelist_dt');
    input.value = '';
    input.focus();
    input.value = date;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, DATE);

  console.log('Clicking GO button...');

  // ✅ Click GO using ID (correct for <input type="button">)
  await page.click('#go');

  console.log('Waiting for causelist table...');

  // ✅ AJAX load – no navigation
  await page.waitForSelector('table tbody tr', { timeout: 30000 });

  // ✅ Select all "View" links
  const links = await page.$$('a[target="_blank"]');
  console.log(`Found ${links.length} PDFs`);

for (let i = 0; i < links.length; i++) {
  console.log(`Downloading ${i + 1} / ${links.length}`);

  const pdfUrl = await page.evaluate(el => el.href, links[i]);

  const pdfBuffer = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: 'include'
    });
    const arrayBuffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(arrayBuffer));
  }, pdfUrl);

  const filePath = path.join(
    DOWNLOAD_DIR,
    `causelist_${i + 1}.pdf`
  );

  fs.writeFileSync(filePath, Buffer.from(pdfBuffer));
}
  console.log('✅ All PDFs downloaded');
  console.log(`📁 Saved to: ${DOWNLOAD_DIR}`);

  await browser.close();

})().catch(err => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
