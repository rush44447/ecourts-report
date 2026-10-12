// Advocate-name normalisation, so the same person is counted under one key.

// Things that appear in the advocate column but are not a person.
const NOT_A_NAME = new RegExp(
  '^(BY COURT ORDER|COURT ORDER|IN PERSON|PARTY IN PERSON|NONE|NIL|NA|N A|' +
  'NOTICE|SELF|CAVEAT|CAVEATOR|AMICUS CURIAE|ADVOCATE|ADV)$'
);

// Government-counsel designations: "SS LADRECHA AAG", "NARUKA (AAG)",
// "ROHIT CHOUDHARY DY GC". Stripped from the end of a name.
const DESIG =
  '(?:A{1,3}G|A\\s*G\\s*C|ADDL?|DY\\s*A\\s*G|ADDL\\s*A\\s*G|DY\\s*G\\s*C|G\\s*C|G\\s*A|A\\s*G\\s*A|P\\s*P|' +
  'A\\s*P\\s*P|ADDL\\s*P\\s*P|S\\s*P\\s*P|A\\s*S\\s*G|S\\s*G|D\\s*G\\s*C|C\\s*G\\s*C|' +
  'PUBLIC\\s+PROSECUTOR|GOVT\\s+ADV(?:OCATE)?|G\\s*A\\s*CUM\\s*A+G)';
const DESIG_SUFFIX = new RegExp(`(?:^|\\s|-)${DESIG}$`);
// At the start only strip forms that can't be initials ("P P SHARMA" is a person).
const DESIG_PREFIX = /^(?:AAG|AAAG|ADDL\s+AG|DY\s+AG|DY\s+GC|GC|PUBLIC\s+PROSECUTOR|GOVT\s+ADV(?:OCATE)?)(?:\s|-|$)/;

function normalizeName(raw) {
  let s = raw.toUpperCase().replace(/[’`]/g, "'").trim();
  // Titles. "MS"/"SH"/"KU" are also initials ("MS PUROHIT"), so only strip them with a dot.
  s = s.replace(/^(?:(?:MR|MRS|MS|MISS|SH|SHRI|SMT|KU)\.|(?:MR|MRS|MISS|SHRI|SMT)\s)\s*/, '');
  s = s.replace(/^DR\.?\s*/, 'DR ');
  s = s.replace(/[.,;:]+/g, ' '); // S.S. -> S S
  s = s.replace(/[^A-Z0-9'&/@ -]/g, ' '); // drops brackets too
  s = s.replace(/\s+/g, ' ').trim().replace(/^[\s-]+|[\s-]+$/g, '');

  // collapse runs of single-letter initials: "P L SAINI" -> "PL SAINI", "A A G" -> "AAG"
  s = s.replace(/\b([A-Z])\s+(?=[A-Z]\b)/g, '$1');

  let prev;
  do {
    prev = s;
    s = s.replace(DESIG_SUFFIX, '').trim();
    s = s.replace(DESIG_PREFIX, '').trim();
  } while (s !== prev);
  return s.replace(/^[\s-]+|[\s-]+$/g, '');
}

function isPerson(name) {
  return name.length >= 3 && /[A-Z]/.test(name) && !NOT_A_NAME.test(name);
}

// Party names, so "THE STATE OF RAJASTHAN" and "STATE OF RAJASTHAN" count together.
// Relations and "through ..." tails are dropped: "SONU S/O RAMNIVAS" -> "SONU",
// "UNION OF INDIA THROUGH NIA" -> "UNION OF INDIA".
const PARTY_CUT =
  /\s(?:S\/O|D\/O|W\/O|H\/O|C\/O|SON OF|DAUGHTER OF|WIFE OF|HUSBAND OF|THROUGH|THR|THRU|AND ORS|& ORS|AND OTHERS|& OTHERS|AND ANR|& ANR|AND ANOTHER|& ANOTHER)(?:\s|$).*$/;

function normalizeParty(raw) {
  let s = ` ${raw.toUpperCase().replace(/[’`]/g, "'")} `;
  s = s.replace(/[.,;:]+/g, ' ').replace(/\s+/g, ' ');
  s = s.replace(PARTY_CUT, '').replace(/\([^()]*\)\s*$/, '').trim();
  s = s.replace(/^(?:THE|M\s*\/\s*S|MESSRS)\s+/, '');
  s = s.replace(/^(?:(?:MR|MRS|MS|MISS|SHRI|SMT|KU|KUMARI|SH)\s)+/, '');
  s = s.replace(/\bLIMITED\b/g, 'LTD').replace(/\bPRIVATE\b/g, 'PVT').replace(/\bCOMPANY\b/g, 'CO');
  s = s.replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '');
  if (s === 'STATE' || s === 'STATE OF RAJ' || s === 'STATE OF RAJASTHAN RAJASTHAN') s = 'STATE OF RAJASTHAN';
  // "XXXXX" is how the list masks parties in confidential cases.
  return s.length >= 3 && /[A-Z]{2}/.test(s) && !/^X+$/.test(s) ? s : null;
}

module.exports = { normalizeName, isPerson, normalizeParty };
