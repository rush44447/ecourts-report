// Rule-based company/individual classifier for court party names.
// Usage: node rules.js eval    -> compare with DeepSeek labels in results*.json
//        node rules.js apply   -> label every unlabelled party in ecourts.party_types (env MONGODB_URI)
const fs = require('fs');

// Whole words that mark an organisation, government body or official post.
const COMPANY_WORDS = `
LTD LIMITED LIMTED LIMIT LTDA LID PVT PVTLTD PRIVATE CO COMPANY COMPNY CORPORATION CORPN CORP LLP INC FIRM
BANK BANKS INSURANCE ASSURANCE FINANCE FINANCIAL FINANCIERS FINVEST FINCORP CAPITAL LEASING INVESTMENTS HOLDINGS CREDIT
INDUSTRIES INDUSTRY INDS ENTERPRISES ENTERPRISE TRADERS TRADING TRADE TRADERS AGENCY AGENCIES BROTHERS BROS SONS ASSOCIATES
MOTORS AUTOMOBILES TRANSPORT TRANSPORTS TRAVELS LOGISTICS ROADWAYS CARRIERS CONSTRUCTION CONSTRUCTIONS BUILDERS DEVELOPERS
BUILDCON BUILDTECH INFRA INFRASTRUCTURE INFRATECH PROJECTS ESTATE ESTATES REALTORS PROPERTIES HOUSING COLONIZERS
MINERALS MINES MINING MARBLES MARBLE GRANITES STONE STEEL STEELS CEMENT CEMENTS IRON METALS ALLOYS TEXTILES TEXTILE FABRICS
SAREES SAREE SILK HANDICRAFTS HANDLOOM PRODUCTS MILLS MILL UDYOG UDHYOG UDYOGH PLASTICS POLYMERS PACKAGING CHEMICALS PHARMA
PHARMACEUTICALS DRUGS FOODS FOOD AGRO DAIRY OILS SPICES BEVERAGES BREWERIES DISTILLERIES FERTILIZERS FERTILISERS SEEDS GAS ENERGY
POWER SOLAR ELECTRICALS ELECTRONICS TECHNOLOGIES TECHNOLOGY TECH SYSTEMS SOLUTIONS SERVICES SERVICE SOFTWARE INFOTECH TELECOM
COMMUNICATIONS EXPORTS EXPORT IMPORTS EXPORTERS OVERSEAS INTERNATIONAL GLOBAL INDUSTRIAL HOTEL HOTELS RESORT RESORTS RESTAURANT
JEWELLERS JEWELLERY GEMS STORES STORE MART EMPORIUM SHOWROOM CENTRE CENTER MEDICOS MEDICALS DISTRIBUTORS SUPPLIERS SUPPLY
CONTRACTORS ENGINEERS ENGINEERING WORKS WAREHOUSE WAREHOUSING CORPORATE GROUP VENTURES PETROLEUM FUELS FILLING
SOCIETY SOCIETIES SAMITI SAMITEE SANSTHAN SANSTHA TRUST FOUNDATION ASSOCIATION ASSOCIATIONS SANGH SANGATHAN UNION FEDERATION
COOPERATIVE COOP COOPRATIVE SAHAKARI CLUB MANDALI PARISHAD COUNCIL COMMITTEE BOARD COMMISSION AUTHORITY AUTHROITY PRADHIKARAN NIGAM
GOVT GOVERNMENT DEPARTMENT DEPTT DEPT MINISTRY DIRECTORATE DIRECTOR DIRECTORS SECRETARY COLLECTOR COMMISSIONER COMMR OFFICER
OFFICERS OFFICE MANAGER CHAIRMAN CHAIRPERSON PRESIDENT PRINCIPAL REGISTRAR SUPERINTENDENT INSPECTOR TEHSILDAR TAHSILDAR
SDO SDM ADM SHO SP DSP CEO MD GM AGM DGM ENGINEER INCHARGE IN-CHARGE CONTROLLER COMMANDANT WARDEN HEADMASTER VICE-CHANCELLOR
MUNICIPAL MUNICIPALITY NIGAM PALIKA PANCHAYAT PANCHAYATS ZILA CORPORATION UNIVERSITY VISHWAVIDYALAYA COLLEGE COLLEGES SCHOOL
SCHOOLS VIDYALAYA VIDYAPEETH VIDHYALAYA ACADEMY INSTITUTE INSTITUTION INSTITUTIONS EDUCATION EDUCATIONAL HOSPITAL HOSPITALS CLINIC
NURSING MEDICAL POLICE STATION THANA TRIBUNAL COURT CUSTOMS EXCISE GST TAX TAXES REVENUE CBI NHAI BSNL RSRTC RIICO JVVNL AVVNL
JDVVNL RVPNL RRVPNL RSEB LIC SBI ICICI HDFC IDBI UCO PNB BOB NABARD SEBI RBI UIT JDA RHB RPSC RSMSSB TEMPLE MANDIR MASJID
GAUSHALA GOSHALA ASHRAM DHARAMSHALA CHURCH WAKF DEVASTHAN MATH MISSION RAILWAY RAILWAYS INDIAN AIRPORT AIRLINES PORT
SALES BRICKS IMPEX GARMENTS CONSULTANTS CONSULTANCY MEDICOSE ALUMINIUM PRESS PRINTING PRINTERS JEWELS JEWELERS BOREWELL CONSUMERS
MARKETING DISCOM CONSERVATOR PALACE PLAZA FARM POULTRY HOUSE SABHA SANGTHAN SANGHATHAN MEMORIAL VILLAGERS FORCE VILLA CARPETS
ROADLINES FURNITURE MATERIAL INSTRUMENTS HUF ORGANISATION ORGANIZATION ROYALTIES KENDRA FACTORY MAHAVIDHYALAYA MAHAVIDYALAYA
MADARSA MADRASA DARGAH YATIMKHANA ANJUMAN BHAWAN SADAN COMPLEX GALLERIA GALLERY PLANNERS CAPFIN BUILD BUILDSTRUCTURE CRAFT
CRAFTS GOSEVASHARM STHAN SAMOOH PIGMENT PIGMENTS PHOSPHATES COPPER INDANE ENVIROCARE SURVEILLANCE POSTMASTER MINISTERIAL
CHIKITSA ENGNIEER NARCOTICS PROVIDENT STAMPS REGISTRATION ADMINISTRATOR ADMINISTRATION COORDINATOR ABHIYAN TAILORS
DISPOSAL LUBE LUBRICANTS FIXTURES ITC PRODUCT PROD PROCESS JUDGE ADJ ACJM CJM ADDL ADDITIONAL ASSISTANT ASSTT ASSIT EXECUTIVE
CHIEF REGIONAL DISTRICT DIVISIONAL CENTRAL NATIONAL DEVELOPMENT DIVISION CIRCLE ZONE ZONAL ESTATE CONSTRUCTIONS OPTICS OPTICALS
ELECTRIC AUTO AUTOS TYRES PAINTS TRADELINK WINES LIQUORS BAR MARKET BAZAR TRADERS UTSAV TOURS TOURISM DEPOT
`.split(/\s+/).filter(Boolean);
const COMPANY_SET = new Set(COMPANY_WORDS);
const ACRONYMS = new Set('BSNL CIT ACIT ITO UIT JDA RFC AVVNL JVVNL JDVVNL RVPNL ADJ LIC SBI HDFC ICICI IDBI RSRTC RIICO NHAI CBI PNB UCO RPSC ONGC NTPC BHEL GAIL IOCL HPCL BPCL'.split(' '));
// Phrases checked against the space-normalised name.
const COMPANY_PHRASES = [
  'STATE OF', 'UNION OF INDIA', 'AAM JANTA', 'POST MASTER', 'NAGAR NIGAM', 'NAGAR PARISHAD', 'NAGAR VIKAS', 'GOVT OF', 'GOVERNMENT OF', 'H D F C', 'S B I', 'L I C', 'I C I C I', 'M/S', 'M/ S', '& CO',
  '& SONS', 'AND SONS', 'AND CO', '(P)', 'P LTD', 'INCOME TAX', 'NAGAR NIGAM', 'NAGAR PALIKA', 'GRAM PANCHAYAT',
];
// A person who appears with a role in the name, e.g. "LRS OF RAMESH", stays an individual.
const INDIVIDUAL_PHRASES = [' @ ', '@', ' ALIAS ', ' S/O ', ' D/O ', ' W/O ', 'LRS OF', 'LR OF', 'LEGAL REP'];

function classify(raw) {
  const name = ` ${raw.toUpperCase().replace(/\s+/g, ' ').trim()} `;
  const words = name.replace(/[^A-Z0-9&/@-]+/g, ' ').trim().split(' ');
  const initials = name.replace(/[^A-Z ]+/g, ' ').match(/\b(?:[A-Z] ){2,}[A-Z]\b/g) || [];
  const hit = words.find(w => COMPANY_SET.has(w) || /^DEP(AR|TT|T$)/.test(w))
    || initials.map(m => m.replace(/ /g, '')).find(a => ACRONYMS.has(a))
    || COMPANY_PHRASES.find(p => name.includes(p))
    || (/^ STATE /.test(name) && 'STATE');
  if (hit && !INDIVIDUAL_PHRASES.some(p => name.includes(p))) return { type: 'company', rule: hit };
  return { type: 'individual', rule: hit ? 'individual-marker' : 'default' };
}

function loadLabels() {
  const out = new Map();
  for (const f of fs.readdirSync('.').filter(f => /^results.*\.json$/.test(f))) {
    for (const r of JSON.parse(fs.readFileSync(f, 'utf-8'))) if (r.type) out.set(r.name, r.type);
  }
  return out;
}

async function apply() {
  const { MongoClient } = require('mongodb');
  const names = new Set();
  for (const city of ['jaipur', 'jodhpur']) {
    const data = JSON.parse(fs.readFileSync(`/var/www/email-warmup/ecourts/parties-${city}.json`, 'utf-8'));
    for (const [name] of data.all) names.add(name);
  }
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const col = client.db('ecourts').collection('party_types');
  const done = new Set(await col.distinct('name'));
  const todo = [...names].filter(n => !done.has(n));
  const now = new Date();
  const counts = {};
  for (let i = 0; i < todo.length; i += 1000) {
    const ops = todo.slice(i, i + 1000).map(name => {
      const { type, rule } = classify(name);
      counts[type] = (counts[type] || 0) + 1;
      return { updateOne: { filter: { name }, update: { $set: { name, type, rule, model: 'rules', classified_at: now } }, upsert: true } };
    });
    await col.bulkWrite(ops, { ordered: false });
  }
  console.log(`labelled ${todo.length}`, counts, `party_types now: ${await col.countDocuments()}`);
  await client.close();
}

module.exports = { classify };

if (require.main !== module) {
  // used as a library (build-lawsuits.js)
} else if (process.argv[2] === 'apply') apply();
else {
  const labels = loadLabels();
  let agree = 0;
  const miss = { company_as_individual: [], individual_as_company: [] };
  for (const [name, want] of labels) {
    const got = classify(name);
    if (got.type === want) agree++;
    else if (want === 'company') miss.company_as_individual.push(name);
    else miss.individual_as_company.push(`${name}  [${got.rule}]`);
  }
  console.log(`agree ${agree}/${labels.size} = ${(100 * agree / labels.size).toFixed(1)}%`);
  for (const [k, v] of Object.entries(miss)) console.log(`\n${k} (${v.length}):\n` + v.join('\n'));
}
