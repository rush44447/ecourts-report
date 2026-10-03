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

module.exports = { normalizeName, isPerson };
