// Cleans the legacy (2021-04 → 2026-04) counts that were produced by the old
// regex `([A-Z\s]+)-(P|R)` over plain PDF text. That regex swallowed the party
// lines printed just above the advocate, so keys look like
//
//   "O SHRI SANWAR MAL YADAV STATE OF RAJASTHAN VIGYAN SHAH"   (-> VIGYAN SHAH)
//   "KOTAK ENTERPRISES RUSHAB MODI"                             (-> RUSHAB MODI)
//
// The real advocate is always the *tail* of the key. We resolve each key to the
// longest tail that is a known clean advocate name:
//   1. names seen in the new, position-parsed data (most trusted)
//   2. legacy keys that already look clean (short, frequent, no party words)
// then fall back to "words after the last party marker" when that tail is short.
// Anything still unresolved is reported as unmatched rather than guessed.

const { normalizeName, isPerson } = require('./names');
const { resolveNames } = require('./resolve');

// Words that only occur in party names / descriptions, never in an advocate's name.
const PARTY_WORDS = new Set(
  (
    'STATE RAJASTHAN INDIA UNION XXXXX LTD LIMITED PVT PRIVATE BANK BOARD OF THE AND ORS ANR ' +
    'SON WIFE DAUGHTER LATE THROUGH SECRETARY OFFICER COMMISSIONER CORPORATION COMPANY DEPARTMENT ' +
    'COUNCIL UNIVERSITY INSTITUTE HOSPITAL NIGAM COLLECTOR DIRECTOR GOVT GOVERNMENT CENTRAL BUREAU ' +
    'INVESTIGATION INSURANCE MUNICIPAL PANCHAYAT SAMITI SOCIETY TRUST ENTERPRISES INDUSTRIES ' +
    'TRADERS DISTRICT CHAIRMAN MANAGER PRINCIPAL REGISTRAR AUTHORITY COMMISSION OTHERS ANOTHER ' +
    'EDUCATION SELECTION SERVICE PUBLIC POLICE STATION AJMER JAIPUR JODHPUR UDAIPUR KOTA BIKANER ' +
    'APPELLANT PETITIONER RESPONDENT VERSUS IN RE RAJ'
  ).split(/\s+/)
);
// "RAJ" is a party abbreviation ("STATE OF RAJ") but also a common name part
// ("INDER RAJ SAINI"), so it is a marker only when it follows "OF".
const isMarker = (words, i) => (words[i] === 'RAJ' ? words[i - 1] === 'OF' : PARTY_WORDS.has(words[i]));

function looksClean(name) {
  const w = name.split(' ');
  return w.length >= 1 && w.length <= 4 && w.every((_, i) => !isMarker(w, i));
}

// Old "S/O", "W/O" etc. lose the slash: "... S O NAME" / leading "O NAME".
function normalizeLegacyKey(key) {
  return normalizeName(key.replace(/\b([SWDC])\s*\/\s*O\b/g, ' SON '));
}

/**
 * @param legacy   { Practitioner: {key: count}, Respondent: {...} }
 * @param known    Map<name, count> of clean names from the new data (any city/side)
 * @returns { data: {Practitioner:{}, Respondent:{}}, stats }
 */
function cleanLegacy(legacy, known) {
  // Dictionary from the legacy file itself: keys that are already clean.
  const legacyClean = new Map();
  for (const side of Object.keys(legacy)) {
    for (const [key, count] of Object.entries(legacy[side])) {
      const n = normalizeLegacyKey(key);
      if (n && looksClean(n) && isPerson(n)) legacyClean.set(n, (legacyClean.get(n) || 0) + count);
    }
  }
  const trusted = (n) => known.has(n) || (legacyClean.get(n) || 0) >= 20;
  // Dictionary for splitting "A B C D" into two known advocates.
  const dict = new Map(legacyClean);
  for (const [n, c] of known) dict.set(n, (dict.get(n) || 0) + c);

  const data = { Practitioner: {}, Respondent: {} };
  const stats = { exact: 0, tail: 0, marker: 0, unmatched: 0, dropped: 0, unmatchedKeys: [] };

  for (const side of Object.keys(data)) {
    for (const [key, count] of Object.entries(legacy[side] || {})) {
      const n = normalizeLegacyKey(key);
      if (!n || !isPerson(n) || !/[AEIOU]/.test(n)) {
        stats.dropped += count; // "PP", "PPP", "AAG", empty
        continue;
      }
      const words = n.split(' ');
      let name = null;
      let how = null;

      // 1/2. longest trusted tail (prefer names seen in the new data). A one-word
      // tail ("SHARMA") is never trusted unless it is the whole key.
      for (const pool of [(t) => known.has(t), trusted]) {
        for (let i = 0; i < words.length && !name; i++) {
          if (i > 0 && i === words.length - 1) break;
          const tail = words.slice(i).join(' ');
          if (pool(tail) && looksClean(tail)) {
            name = tail;
            how = i === 0 ? 'exact' : 'tail';
          }
        }
        if (name) break;
      }
      // 3. words after the last party marker, if that leaves a plausible name
      if (!name) {
        let last = -1;
        words.forEach((_, i) => isMarker(words, i) && (last = i));
        const tail = words.slice(last + 1);
        if (last >= 0 && tail.length >= 2 && tail.length <= 4) {
          name = tail.join(' ');
          how = 'marker';
        } else if (last < 0 && words.length <= 4) {
          name = n; // short, no party words: keep as is
          how = 'exact';
        }
      }
      if (!name) {
        stats.unmatched += count;
        stats.unmatchedKeys.push([key, count]);
        continue;
      }
      stats[how] += count;
      for (const part of resolveNames(name, dict)) data[side][part] = (data[side][part] || 0) + count;
    }
    data[side] = Object.fromEntries(Object.entries(data[side]).sort((a, b) => b[1] - a[1]));
  }
  stats.unmatchedKeys.sort((a, b) => b[1] - a[1]);
  return { data, stats };
}

module.exports = { cleanLegacy, normalizeLegacyKey };
