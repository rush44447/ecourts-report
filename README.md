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
5. **Parties:** the "Title of The Case" column gives the first-named petitioner
   and respondent of each case (`parties` table). The cell has no separator, so
   `splitParties` uses the `(Department-State-R1)` notes, connector words (`S/O`,
   `SON OF`, `PVT LTD`) and new-name starters (`THE`, `STATE OF`, `M/S`) to find
   the boundary. Names lose relations and "through ..." tails (`SONU S/O RAMNIVAS`
   → `SONU`), and masked parties (`XXXXX`) are dropped. One matter = one case listing.
6. **Storage:** `data/causelist.db` (SQLite via built-in `node:sqlite`). Every
   appearance is stored with its date, PDF and case number, so counts can be
   rebuilt for any date range and coverage is always known.

## Old data (6 Apr 2021 → 5 Apr 2026)

hcraj.nic.in only keeps cause lists from early 2025, so the older period
can't be downloaded again. Instead, `import-legacy.js` cleans the website's
old undated JSON (`data1.json` Jodhpur, `data2.json` Jaipur). The old regex
put party text **in front of** the advocate, so each dirty key ends with the
real name:

```
O SHRI SANWAR MAL YADAV STATE OF RAJASTHAN VIGYAN SHAH   ->  VIGYAN SHAH
KOTAK ENTERPRISES RUSHAB MODI                             ->  RUSHAB MODI
```

Each key resolves to the longest clean advocate name at its end. Clean names
come from the new data, plus old keys that already look clean. A one-word ending
like "SHARMA" is never trusted. About 99.5% of old appearances resolve. The rest
are listed in `data/legacy/<city>.unmatched.json` and are not stored. Old
counts have no dates, and they counted every mention, not one per case.

```bash
node import-legacy.js --city jodhpur --file data/legacy/jodhpur.json
node import-legacy.js --city jaipur  --file data/legacy/jaipur.json
```

## MongoDB

`node sync-mongo.js [--from YYYY-MM]` pushes to the `ecourts` database
(`MONGODB_URI` in `.env`):

- `monthly_counts`: `{ city, month, side, name, count }`
- `coverage`: which days/PDFs each month covers
- `party_daily_counts` / `party_monthly_counts`: `{ city, date|month, side, name, count }`,
  parties with 2+ matters only
- `legacy_counts`: cleaned old totals with their period

## Usage

Requires Node >= 22.13 (for `node:sqlite`).

```bash
npm install

# scrape a date range (resumable: done days/PDFs are skipped)
node scrape.js --from 2026-04-06 --to 2026-10-03
node scrape.js --from 2026-10-01 --city jodhpur      # one bench, up to today
node scrape.js --from 2026-09-30 --to 2026-09-30 --force --keep-pdfs
node scrape.js --from 2026-04-06 --parties-only      # add parties to already scraped PDFs

# build reports -> reports/<city>.json, <city>.meta.json, <city>.xlsx
node report.js                       # all time (legacy + scraped)
node report.js --from 2026-04-06 --to 2026-10-03

# debug the parser on a local PDF
node parse.js some_causelist.pdf
```

`reports/<city>.parties.json` (`{ days, months, all }`, rows `[name, side, count]`)
is what the website's `/api/parties` reads, as `ecourts/parties-<city>.json`.

`reports/<city>.json` has the same shape the website API reads
(`{ "Practitioner": { "NAME": count }, "Respondent": { ... } }`).

Set `ECOURTS_DATA_DIR` to keep the database somewhere other than `./data`.
