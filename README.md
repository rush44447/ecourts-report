# ecourts-report

Collects Rajasthan High Court cause lists (Jodhpur and Jaipur benches) and
counts how often each advocate appears, split into:

- **Practitioner**: advocate for the petitioner (`-P` in the cause list)
- **Respondent**: advocate for the respondent (`-R`)

## How it works

1. **Source:** `https://hcraj.nic.in/quick-causelist-{jdp,jp}/`. It has no captcha and covers
   both benches. (The eCourts portal `hcservices.ecourts.gov.in` returns
   "CauseList is not available" for every Jodhpur PDF, even in a real browser.)
2. **Parsing:** `src/parser.js` reads each PDF by text position. Column
   boundaries come from each page's header row (`S.No. | Case Type/No |
   Title of The Case | Name of Advocate`), so both the daily and the
   supplementary layouts work. Only the advocate column is read, so party
   names like "STATE OF RAJASTHAN" or "KOTAK ENTERPRISES" can't merge into an
   advocate's name. The old regex over plain text caused exactly that.
3. **Names:** `src/names.js` normalises spelling: `S.S. RAGHAV` and `SS RAGHAV`
   become one name, `P L SAINI` becomes `PL SAINI`, and designations are stripped
   (`... AAG`, `(AAG)`, `DY GC`, `PP` at the end). Entries that aren't a person,
   such as `BY COURT ORDER` or a bare `AAG`, are dropped.
4. **Counting:** one appearance is one case listing. If an advocate is printed
   twice on the same side of the same case, it counts once.
5. **Storage:** `data/causelist.db` (SQLite via built-in `node:sqlite`). Every
   appearance is stored with its date, PDF and case number, so counts can be
   rebuilt for any date range and coverage is always known.

## Usage

Requires Node >= 22.13 (for `node:sqlite`).

```bash
npm install

# scrape a date range (resumable: done days/PDFs are skipped)
node scrape.js --from 2026-04-06 --to 2026-10-03
node scrape.js --from 2026-10-01 --city jodhpur      # one bench, up to today
node scrape.js --from 2026-09-30 --to 2026-09-30 --force --keep-pdfs

# build reports -> reports/<city>.json, <city>.meta.json, <city>.xlsx
node report.js
node report.js --from 2026-04-06 --to 2026-10-03

# debug the parser on a local PDF
node parse.js some_causelist.pdf
```

`reports/<city>.json` has the same shape the website API reads
(`{ "Practitioner": { "NAME": count }, "Respondent": { ... } }`).

Set `ECOURTS_DATA_DIR` to keep the database somewhere other than `./data`.
