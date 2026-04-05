# ecourts-report

Automates downloading High Court causelist PDFs from eCourts and generates
a consolidated Excel report of practitioner and respondent appearances.

## Features

- Puppeteer-based automation (works with eCourts session logic)
- Bulk PDF download from causelist pages
- Robust PDF text extraction with error handling
- Aggregated Excel report per date
- Skips malformed or scanned PDFs safely

## Requirements

- Node.js 18.x
- Linux (Ubuntu tested)
- Chromium dependencies (for Puppeteer)

## Setup

```bash
npm install
``
