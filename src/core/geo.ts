/**
 * Deterministic gazetteer for L1 location matching. It resolves free-text job
 * locations ("Bengaluru - BLR1", "Remote - US", "Austin, TX") and criteria terms
 * ("india", "europe", "bangalore") to place keys, then answers containment
 * questions ("does APAC include India?"). There are no LLM tokens and no network
 * calls here, only table lookups.
 *
 * Key scheme: a country is its lowercase ISO-3166 alpha-2 code ('in'). A
 * sub-national place extends its country with ':' ('in:ka' is Karnataka,
 * 'in:ka:bengaluru' a city in it), so containment is a key-prefix test. A region
 * is '@<id>' ('@apac') and contains its member countries.
 *
 * Ambiguous names are deliberately absent, so they produce no signal on their
 * own: 'georgia' (country or US state), 'jersey', 'cambridge', 'victoria',
 * 'punjab', bare 2-letter codes that double as words or US states ('in', 'ca',
 * 'de'). A missing signal is always the lenient outcome in L1.
 */

/** 'in' = country, 'in:ka:bengaluru' = sub-national place, '@apac' = region. */
export type PlaceKey = string;

interface CountrySpec {
  /** Display label. Defaults to the first name, title-cased. */
  label?: string;
  /** Names/aliases, matched case-insensitively as whole words. */
  names: string;
  /** Codes matched only when written in UPPERCASE in job text ("US", "IND"). In
   *  lowercase they are ordinary words ('us'), so free text can't trigger them.
   *  A criteria term that is exactly one of these codes resolves in any case. */
  codes?: string;
  /** Sub-national places: key suffix -> aliases. 'ka' is a state, 'ka:bengaluru'
   *  a city inside it (the prefix makes Karnataka contain Bengaluru). */
  subs?: Record<string, string>;
  /** Single-alias cities directly under the country (key = alias without spaces). */
  cities?: string;
  /** The 2-letter sub keys are postal codes, accepted in "City, ST" position. */
  postalCodes?: boolean;
}

const COUNTRIES: Record<string, CountrySpec> = {
  in: {
    names: 'india|bharat',
    codes: 'IND',
    subs: {
      ka: 'karnataka',
      'ka:bengaluru':
        'bengaluru|bangalore|blr|whitefield|electronic city|koramangala|marathahalli|bellandur|hsr layout',
      'ka:mysuru': 'mysuru|mysore',
      'ka:mangaluru': 'mangaluru|mangalore',
      'ka:hubballi': 'hubballi|hubli',
      ts: 'telangana',
      'ts:hyderabad': 'hyderabad|secunderabad|madhapur|gachibowli|hitec city|hitech city|kondapur|cyberabad',
      mh: 'maharashtra',
      'mh:mumbai': 'mumbai|bombay|navi mumbai|thane|powai|andheri|mumbai metropolitan region',
      'mh:pune': 'pune|pimpri chinchwad|hinjewadi|hinjawadi|kharadi|magarpatta',
      'mh:nagpur': 'nagpur',
      'mh:nashik': 'nashik',
      tn: 'tamil nadu',
      'tn:chennai': 'chennai|madras|guindy|sholinganallur',
      'tn:coimbatore': 'coimbatore',
      'tn:madurai': 'madurai',
      // The Delhi job market spans three states, so NCR stands in for the state
      // level. Bare "ncr"/"national capital region" are dropped (not just
      // "delhi ncr") — "NCR" collides with the Philippines' National Capital
      // Region (Metro Manila), e.g. "Makati City, NCR, Philippines".
      ncr: 'delhi ncr',
      'ncr:delhi': 'delhi|new delhi',
      'ncr:gurugram': 'gurugram|gurgaon',
      'ncr:noida': 'noida|greater noida',
      'ncr:faridabad': 'faridabad',
      'ncr:ghaziabad': 'ghaziabad',
      hr: 'haryana',
      up: 'uttar pradesh',
      'up:lucknow': 'lucknow',
      'up:kanpur': 'kanpur',
      wb: 'west bengal',
      'wb:kolkata': 'kolkata|calcutta',
      gj: 'gujarat',
      'gj:ahmedabad': 'ahmedabad',
      'gj:gandhinagar': 'gandhinagar|gift city',
      'gj:vadodara': 'vadodara|baroda',
      'gj:surat': 'surat',
      kl: 'kerala',
      'kl:kochi': 'kochi|cochin|ernakulam|kakkanad|infopark',
      'kl:thiruvananthapuram': 'thiruvananthapuram|trivandrum|technopark',
      rj: 'rajasthan',
      'rj:jaipur': 'jaipur',
      ch: 'chandigarh|mohali|panchkula',
      mp: 'madhya pradesh',
      'mp:indore': 'indore',
      'mp:bhopal': 'bhopal',
      ap: 'andhra pradesh',
      'ap:visakhapatnam': 'visakhapatnam|vishakhapatnam|vizag',
      'ap:vijayawada': 'vijayawada',
      od: 'odisha|orissa',
      'od:bhubaneswar': 'bhubaneswar|bhubaneshwar',
      ga: 'goa',
      uk: 'uttarakhand',
      'uk:dehradun': 'dehradun',
      as: 'assam',
      'as:guwahati': 'guwahati',
      br: 'bihar',
      'br:patna': 'patna',
      jh: 'jharkhand',
      'jh:ranchi': 'ranchi',
      pb: '', // 'punjab' is also a Pakistani province
      'pb:ludhiana': 'ludhiana',
      'pb:amritsar': 'amritsar',
    },
  },
  us: {
    names: 'united states|united states of america|usa|u.s.|u.s.a.|washington|new england|continental us',
    codes: 'US|USA',
    postalCodes: true,
    subs: {
      al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
      co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida',
      ga: '', // 'georgia' is also a country
      hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas',
      ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts',
      mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
      ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
      ny: 'new york|new york state', nc: 'north carolina', nd: 'north dakota', oh: 'ohio',
      ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island',
      sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah',
      vt: 'vermont', va: 'virginia', wa: 'washington state', wv: 'west virginia',
      wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia|washington dc|washington d.c.',
      'az:phoenix': 'phoenix|scottsdale|tempe',
      'ca:bayarea':
        'san francisco|bay area|sf bay area|silicon valley|san jose|palo alto|mountain view|sunnyvale|menlo park|cupertino|santa clara|redwood city|san mateo|oakland|berkeley|emeryville|south san francisco',
      'ca:la': 'los angeles|santa monica|culver city|pasadena|playa vista',
      'ca:oc': 'irvine|orange county|costa mesa',
      'ca:sandiego': 'san diego',
      'ca:sacramento': 'sacramento',
      'co:denver': 'denver|boulder',
      'fl:miami': 'miami',
      'fl:tampa': 'tampa',
      'fl:orlando': 'orlando',
      'ga:atlanta': 'atlanta',
      'id:boise': 'boise',
      'il:chicago': 'chicago',
      'in:indianapolis': 'indianapolis',
      'md:baltimore': 'baltimore',
      'ma:boston': 'boston',
      'mi:detroit': 'detroit|ann arbor',
      'mn:minneapolis': 'minneapolis|st paul|saint paul',
      'mo:stlouis': 'st louis|saint louis',
      'mo:kansascity': 'kansas city',
      'nv:lasvegas': 'las vegas',
      'nj:jerseycity': 'jersey city|hoboken|newark',
      'ny:nyc': 'new york city|nyc|manhattan|brooklyn',
      'nc:raleigh': 'raleigh|research triangle|chapel hill',
      'nc:charlotte': 'charlotte',
      'oh:columbus': 'columbus',
      'oh:cleveland': 'cleveland',
      'oh:cincinnati': 'cincinnati',
      'or:portland': 'portland',
      'pa:philadelphia': 'philadelphia',
      'pa:pittsburgh': 'pittsburgh',
      'tn:nashville': 'nashville',
      'tx:austin': 'austin',
      'tx:dallas': 'dallas|plano|irving|frisco|fort worth',
      'tx:houston': 'houston',
      'tx:sanantonio': 'san antonio',
      'ut:saltlake': 'salt lake city|lehi|provo',
      'wa:seattle': 'seattle|bellevue|redmond|kirkland',
      'wi:milwaukee': 'milwaukee',
    },
  },
  ca: {
    names: 'canada',
    codes: 'CAN',
    postalCodes: true,
    subs: {
      on: 'ontario', bc: 'british columbia', ab: 'alberta', qc: 'quebec', ns: 'nova scotia',
      mb: 'manitoba', sk: 'saskatchewan', nb: 'new brunswick',
      nl: 'newfoundland|newfoundland and labrador', pe: 'prince edward island',
      nt: 'northwest territories', nu: 'nunavut', yt: 'yukon',
      'on:toronto': 'toronto|greater toronto area|gta|mississauga|markham|north york',
      'on:ottawa': 'ottawa',
      'on:waterloo': 'waterloo|kitchener',
      'bc:vancouver': 'vancouver|burnaby',
      'ab:calgary': 'calgary',
      'ab:edmonton': 'edmonton',
      'qc:montreal': 'montreal',
      'qc:quebeccity': 'quebec city',
      'mb:winnipeg': 'winnipeg',
    },
  },
  mx: {
    names: 'mexico',
    codes: 'MX|MEX',
    subs: { cdmx: 'mexico city|cdmx|ciudad de mexico' },
    cities: 'guadalajara|monterrey|queretaro|tijuana|puebla',
  },
  br: {
    names: 'brazil|brasil',
    codes: 'BR|BRA',
    cities:
      'sao paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|florianopolis|recife|brasilia|campinas',
  },
  ar: { names: 'argentina', codes: 'ARG', cities: 'buenos aires|cordoba|rosario|mendoza' },
  co: { names: 'colombia', codes: 'COL', cities: 'bogota|medellin|cali|barranquilla' },
  cl: { names: 'chile', codes: 'CL|CHL', cities: 'santiago|valparaiso' },
  pe: { names: 'peru', codes: 'PER', cities: 'lima' },
  uy: { names: 'uruguay', codes: 'UY|URY', cities: 'montevideo' },
  ec: { names: 'ecuador', codes: 'ECU', cities: 'quito|guayaquil' },
  cr: { names: 'costa rica', codes: 'CRI' }, // its San José would collide with the Bay Area one
  // Registered so "Port of Spain" resolves here (a 3-token alias, matched before
  // the bare "spain" 1-token alias) instead of falsely landing on Spain.
  tt: { names: 'trinidad and tobago|trinidad', codes: 'TT|TTO', cities: 'port of spain|san fernando' },

  gb: {
    names:
      'united kingdom|great britain|britain|england|scotland|wales|northern ireland|uk|u.k.',
    codes: 'UK|GB|GBR',
    subs: {
      london: 'london|greater london|city of london',
      manchester: 'manchester|greater manchester',
    },
    cities:
      'edinburgh|glasgow|bristol|leeds|belfast|cardiff|oxford|liverpool|brighton|nottingham|sheffield|milton keynes',
  },
  ie: {
    names: 'ireland|republic of ireland|eire',
    codes: 'IE|IRL',
    cities: 'dublin|cork|galway|limerick',
  },
  de: {
    names: 'germany|deutschland',
    codes: 'DEU',
    subs: {
      be: 'berlin',
      hh: 'hamburg',
      hb: 'bremen',
      by: 'bavaria|bayern',
      'by:munich': 'munich|munchen|muenchen',
      'by:nuremberg': 'nuremberg|nurnberg|nuernberg',
      he: 'hesse|hessen',
      'he:frankfurt': 'frankfurt|frankfurt am main',
      nw: 'north rhine westphalia|nordrhein westfalen|nrw',
      'nw:cologne': 'cologne|koln|koeln',
      'nw:dusseldorf': 'dusseldorf|duesseldorf',
      'nw:dortmund': 'dortmund',
      'nw:bonn': 'bonn',
      bw: 'baden wurttemberg|baden wuerttemberg',
      'bw:stuttgart': 'stuttgart',
      'bw:karlsruhe': 'karlsruhe',
      'bw:heidelberg': 'heidelberg',
      'bw:mannheim': 'mannheim',
      sn: 'saxony|sachsen',
      'sn:leipzig': 'leipzig',
      'sn:dresden': 'dresden',
      ni: 'lower saxony|niedersachsen',
      'ni:hanover': 'hanover|hannover',
    },
  },
  fr: {
    names: 'france',
    codes: 'FR|FRA',
    subs: { paris: 'paris|ile de france|la defense' },
    cities:
      'lyon|marseille|toulouse|bordeaux|lille|nantes|montpellier|grenoble|rennes|strasbourg|sophia antipolis',
  },
  nl: {
    names: 'netherlands|the netherlands|holland|nederland',
    codes: 'NL|NLD',
    subs: { thehague: 'the hague|den haag' },
    cities: 'amsterdam|rotterdam|utrecht|eindhoven|delft|leiden|groningen',
  },
  be: {
    names: 'belgium|belgique|belgie|belgien',
    codes: 'BEL',
    subs: {
      brussels: 'brussels|bruxelles|brussel',
      antwerp: 'antwerp|antwerpen',
      ghent: 'ghent|gent',
    },
    cities: 'leuven|liege',
  },
  lu: { names: 'luxembourg', codes: 'LU|LUX' },
  es: {
    names: 'spain|espana',
    codes: 'ESP',
    subs: { seville: 'seville|sevilla' },
    cities: 'madrid|barcelona|valencia|malaga|bilbao|zaragoza',
  },
  pt: {
    names: 'portugal',
    codes: 'PRT',
    subs: { lisbon: 'lisbon|lisboa', porto: 'porto|oporto' },
    cities: 'braga|coimbra|aveiro',
  },
  it: {
    names: 'italy|italia',
    codes: 'ITA',
    subs: {
      milan: 'milan|milano',
      rome: 'rome|roma',
      turin: 'turin|torino',
      florence: 'florence|firenze',
      naples: 'naples|napoli',
    },
    cities: 'bologna',
  },
  ch: {
    names: 'switzerland|schweiz|suisse|svizzera',
    codes: 'CH|CHE',
    subs: { geneva: 'geneva|geneve|genf', bern: 'bern|berne' },
    cities: 'zurich|basel|lausanne|zug|lugano',
  },
  at: {
    names: 'austria|osterreich|oesterreich',
    codes: 'AUT',
    subs: { vienna: 'vienna|wien' },
    cities: 'graz|linz|salzburg|innsbruck',
  },
  pl: {
    names: 'poland|polska',
    codes: 'PL|POL',
    subs: { warsaw: 'warsaw|warszawa', krakow: 'krakow|cracow' },
    cities: 'wroclaw|gdansk|gdynia|poznan|lodz|katowice',
  },
  cz: {
    names: 'czechia|czech republic',
    codes: 'CZ|CZE',
    subs: { prague: 'prague|praha' },
    cities: 'brno|ostrava',
  },
  sk: { names: 'slovakia', codes: 'SVK', cities: 'bratislava|kosice' },
  hu: { names: 'hungary', codes: 'HU|HUN', cities: 'budapest' },
  ro: {
    names: 'romania',
    codes: 'RO|ROU',
    subs: { bucharest: 'bucharest|bucuresti', cluj: 'cluj|cluj napoca' },
    cities: 'iasi|timisoara|brasov',
  },
  bg: { names: 'bulgaria', codes: 'BG|BGR', cities: 'sofia|plovdiv|varna' },
  ua: {
    names: 'ukraine',
    codes: 'UA|UKR',
    subs: { kyiv: 'kyiv|kiev', kharkiv: 'kharkiv|kharkov' },
    cities: 'lviv|odesa|dnipro',
  },
  se: {
    names: 'sweden|sverige',
    codes: 'SWE',
    subs: { gothenburg: 'gothenburg|goteborg' },
    cities: 'stockholm|malmo|uppsala|lund',
  },
  dk: {
    names: 'denmark|danmark',
    codes: 'DK|DNK',
    subs: { copenhagen: 'copenhagen|kobenhavn', aarhus: 'aarhus|arhus' },
    cities: 'odense',
  },
  no: { names: 'norway|norge', codes: 'NOR', cities: 'oslo|bergen|trondheim|stavanger' },
  fi: { names: 'finland|suomi', codes: 'FI|FIN', cities: 'helsinki|espoo|tampere|oulu|turku' },
  is: { names: 'iceland', codes: 'ISL', cities: 'reykjavik' },
  ee: { names: 'estonia', codes: 'EE', cities: 'tallinn|tartu' },
  lv: { names: 'latvia', codes: 'LV|LVA', cities: 'riga' },
  lt: { names: 'lithuania', codes: 'LT|LTU', cities: 'vilnius|kaunas' },
  gr: { names: 'greece|hellas', codes: 'GR|GRC', cities: 'athens|thessaloniki' },
  cy: { names: 'cyprus', codes: 'CY|CYP', cities: 'limassol|nicosia|larnaca|paphos' },
  mt: { names: 'malta', codes: 'MLT', cities: 'valletta' },
  si: { names: 'slovenia', codes: 'SVN', cities: 'ljubljana' },
  hr: { names: 'croatia|hrvatska', codes: 'HRV', cities: 'zagreb' },
  rs: {
    names: 'serbia',
    codes: 'SRB',
    subs: { belgrade: 'belgrade|beograd' },
    cities: 'novi sad',
  },
  ge: { label: 'Georgia', names: 'sakartvelo', cities: 'tbilisi|batumi' },

  il: {
    names: 'israel',
    codes: 'ISR',
    subs: {
      telaviv: 'tel aviv|tel aviv yafo|tel aviv jaffa',
      petahtikva: 'petah tikva|petach tikva',
      raanana: 'raanana|ra anana',
      beersheba: 'beersheba|beer sheva',
    },
    cities: 'jerusalem|haifa|herzliya|ramat gan|netanya',
  },
  tr: { names: 'turkey|turkiye', codes: 'TR|TUR', cities: 'istanbul|ankara|izmir' },
  ae: {
    names: 'united arab emirates|uae|u.a.e.|emirates',
    codes: 'AE|ARE|UAE',
    cities: 'dubai|abu dhabi|sharjah',
  },
  sa: {
    names: 'saudi arabia|kingdom of saudi arabia|saudi|ksa',
    codes: 'SAU|KSA',
    subs: { khobar: 'khobar|al khobar' },
    cities: 'riyadh|jeddah|dammam|neom',
  },
  qa: { names: 'qatar', codes: 'QA|QAT', cities: 'doha' },
  bh: { names: 'bahrain', codes: 'BHR', cities: 'manama' },
  jo: { label: 'Jordan', names: '', codes: 'JOR', cities: 'amman' }, // 'jordan' is a common name
  eg: { names: 'egypt', codes: 'EG|EGY', cities: 'cairo|giza' },
  ma: { names: 'morocco', cities: 'casablanca|rabat' },
  ng: { names: 'nigeria', codes: 'NG|NGA', cities: 'lagos|abuja' },
  ke: { names: 'kenya', codes: 'KE|KEN', cities: 'nairobi|mombasa' },
  gh: { names: 'ghana', codes: 'GH|GHA', cities: 'accra' },
  et: { names: 'ethiopia', cities: 'addis ababa' },
  ug: { names: 'uganda', cities: 'kampala' },
  rw: { names: 'rwanda', cities: 'kigali' },
  tz: { names: 'tanzania', cities: 'dar es salaam' },
  za: {
    names: 'south africa|rsa',
    codes: 'ZA|ZAF',
    subs: { johannesburg: 'johannesburg|joburg|sandton' },
    cities: 'cape town|durban|pretoria',
  },

  sg: { names: 'singapore', codes: 'SG|SGP' },
  jp: { names: 'japan', codes: 'JP|JPN', cities: 'tokyo|osaka|kyoto|yokohama|fukuoka|nagoya' },
  kr: {
    names: 'south korea|korea|republic of korea',
    codes: 'KR|KOR',
    cities: 'seoul|busan|pangyo|incheon',
  },
  cn: {
    names: 'china|mainland china|prc',
    codes: 'CN|CHN',
    cities: 'beijing|shanghai|shenzhen|guangzhou|hangzhou|chengdu|suzhou|nanjing|wuhan',
  },
  hk: { names: 'hong kong|hongkong|hong kong sar', codes: 'HK|HKG' },
  tw: { names: 'taiwan', codes: 'TW|TWN', cities: 'taipei|hsinchu|taichung|kaohsiung' },
  ph: {
    names: 'philippines',
    codes: 'PH|PHL',
    subs: {
      manila: 'manila|metro manila|makati|taguig|bgc|pasig|quezon city|ortigas',
    },
    cities: 'cebu',
  },
  id: { names: 'indonesia', codes: 'IDN', cities: 'jakarta|bandung|surabaya|bali|yogyakarta' },
  vn: {
    names: 'vietnam|viet nam',
    codes: 'VN|VNM',
    subs: {
      hcmc: 'ho chi minh city|ho chi minh|hcmc|saigon',
      hanoi: 'hanoi|ha noi',
      danang: 'da nang|danang',
    },
  },
  my: {
    names: 'malaysia',
    codes: 'MYS',
    cities: 'kuala lumpur|penang|cyberjaya|petaling jaya|johor bahru',
  },
  th: { names: 'thailand', codes: 'TH|THA', cities: 'bangkok|chiang mai|phuket' },
  pk: {
    names: 'pakistan',
    codes: 'PK|PAK',
    cities: 'karachi|lahore|islamabad|rawalpindi|faisalabad|peshawar',
  },
  bd: {
    names: 'bangladesh',
    codes: 'BD|BGD',
    subs: { chittagong: 'chittagong|chattogram' },
    cities: 'dhaka',
  },
  lk: { names: 'sri lanka', codes: 'LK|LKA', cities: 'colombo|kandy' },
  np: { names: 'nepal', codes: 'NP|NPL', cities: 'kathmandu|lalitpur|pokhara' },
  au: {
    names: 'australia',
    codes: 'AU|AUS',
    subs: {
      nsw: 'new south wales|nsw', vic: '', // 'victoria' is also a Canadian city
      qld: 'queensland|qld', wa: 'western australia', sa: 'south australia',
      act: 'australian capital territory', tas: 'tasmania', nt: 'northern territory',
      'nsw:sydney': 'sydney',
      'vic:melbourne': 'melbourne',
      'qld:brisbane': 'brisbane',
      'qld:goldcoast': 'gold coast',
      'wa:perth': 'perth',
      'sa:adelaide': 'adelaide',
      'act:canberra': 'canberra',
      'tas:hobart': 'hobart',
      'nt:darwin': 'darwin',
    },
  },
  nz: {
    names: 'new zealand|aotearoa',
    codes: 'NZ|NZL',
    cities: 'auckland|wellington|christchurch',
  },
};

const EUROPE =
  'gb ie de fr nl be lu es pt it ch at pl cz sk hu ro bg ua se dk no fi is ee lv lt gr cy mt si hr rs tr ge';
const EU = 'de fr nl be lu es pt it at pl cz sk hu ro bg se dk fi ee lv lt gr cy mt si hr ie';
const MIDDLE_EAST = 'ae sa il tr eg qa bh jo ma';
const AFRICA = 'eg ng ke za gh ma et ug rw tz';
const SOUTH_ASIA = 'in pk bd lk np';
const SOUTHEAST_ASIA = 'sg ph id vn my th';
const EAST_ASIA = 'jp kr cn hk tw';
const ASIA = `${SOUTH_ASIA} ${SOUTHEAST_ASIA} ${EAST_ASIA}`;
const OCEANIA = 'au nz';
const LATAM = 'mx br ar co cl pe uy ec cr';
const NORTH_AMERICA = 'us ca mx';

const REGIONS: Record<string, { label: string; names: string; members: string }> = {
  apac: { label: 'APAC', names: 'apac|asia pacific|asiapac|asia pac|apj|apjc', members: `${ASIA} ${OCEANIA}` },
  asia: { label: 'Asia', names: 'asia', members: ASIA },
  'south-asia': { label: 'South Asia', names: 'south asia|indian subcontinent', members: SOUTH_ASIA },
  'southeast-asia': { label: 'Southeast Asia', names: 'southeast asia|south east asia|asean', members: SOUTHEAST_ASIA },
  'east-asia': { label: 'East Asia', names: 'east asia', members: EAST_ASIA },
  emea: { label: 'EMEA', names: 'emea', members: `${EUROPE} ${MIDDLE_EAST} ${AFRICA}` },
  europe: { label: 'Europe', names: 'europe|european|western europe', members: EUROPE },
  eu: { label: 'EU', names: 'eu|european union|eea|european economic area', members: EU },
  cee: {
    label: 'CEE',
    names: 'cee|central europe|eastern europe|central and eastern europe',
    members: 'pl cz sk hu ro bg ua ee lv lt si hr rs',
  },
  nordics: { label: 'Nordics', names: 'nordics|nordic|nordic countries|scandinavia', members: 'se dk no fi is' },
  dach: { label: 'DACH', names: 'dach', members: 'de at ch' },
  benelux: { label: 'Benelux', names: 'benelux', members: 'be nl lu' },
  'middle-east': { label: 'Middle East', names: 'middle east|mena|gcc', members: MIDDLE_EAST },
  africa: { label: 'Africa', names: 'africa', members: AFRICA },
  latam: { label: 'LATAM', names: 'latam|latin america|central america', members: LATAM },
  'south-america': { label: 'South America', names: 'south america', members: 'br ar co cl pe uy ec' },
  'north-america': { label: 'North America', names: 'north america|noram', members: NORTH_AMERICA },
  americas: { label: 'Americas', names: 'americas|amer', members: `${NORTH_AMERICA} ${LATAM}` },
  oceania: { label: 'Oceania', names: 'oceania|anz|australasia', members: OCEANIA },
};

// Letters NFD can't decompose into ASCII + a combining mark.
const FOLD: Record<string, string> = { 'ł': 'l', 'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'đ': 'd', 'ı': 'i', 'œ': 'oe' };

/** Lowercase, strip diacritics ("São Paulo", "Zürich", "Łódź"), split on anything
 *  that isn't a letter or digit ("Pune/Pimpri-Chinchwad" -> pune pimpri chinchwad). */
function foldTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[łøæßđıœ]/g, (ch) => FOLD[ch])
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const ALIASES = new Map<string, PlaceKey>();
const CODES = new Map<string, PlaceKey>(); // exact-case token -> country
const TERM_CODES = new Map<string, PlaceKey>(); // lowercased code -> country (whole criteria term only)
const POSTAL_CODES = new Map<string, PlaceKey>(); // 'TX' -> 'us:tx', 'ON' -> 'ca:on'
const REGION_MEMBERS = new Map<PlaceKey, ReadonlySet<string>>();
const LABELS = new Map<PlaceKey, string>();
let maxAliasTokens = 1;

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

function addAliases(key: PlaceKey, names: string): void {
  for (const raw of names.split('|')) {
    const alias = foldTokens(raw).join(' ');
    if (!alias) continue;
    const prev = ALIASES.get(alias);
    // A data bug, not a runtime condition — fail loudly at load (tests import this).
    if (prev && prev !== key) throw new Error(`geo: alias "${alias}" maps to both ${prev} and ${key}`);
    ALIASES.set(alias, key);
    maxAliasTokens = Math.max(maxAliasTokens, alias.split(' ').length);
    if (!LABELS.has(key)) LABELS.set(key, titleCase(alias));
  }
}

for (const [cc, spec] of Object.entries(COUNTRIES)) {
  if (spec.label) LABELS.set(cc, spec.label);
  addAliases(cc, spec.names);
  for (const code of spec.codes?.split('|') ?? []) {
    CODES.set(code, cc);
    TERM_CODES.set(code.toLowerCase(), cc);
  }
  for (const [sub, names] of Object.entries(spec.subs ?? {})) {
    const key = `${cc}:${sub}`;
    addAliases(key, names);
    // A postal code that is also a country key here (CA, DE, IN, IL, ...) is
    // ambiguous — "Pune, IN" is not Indiana — so it never acts as a state code.
    if (spec.postalCodes && /^[a-z]{2}$/.test(sub) && !(sub in COUNTRIES)) {
      POSTAL_CODES.set(sub.toUpperCase(), key);
    }
  }
  for (const city of spec.cities?.split('|') ?? []) {
    addAliases(`${cc}:${city.replace(/ /g, '')}`, city);
  }
}
for (const [id, spec] of Object.entries(REGIONS)) {
  const key = `@${id}`;
  LABELS.set(key, spec.label);
  REGION_MEMBERS.set(key, new Set(spec.members.split(' ')));
  addAliases(key, spec.names);
}

/** Greedy longest-alias scan over the folded tokens. */
function addNamedPlaces(tokens: string[], out: Set<PlaceKey>): void {
  for (let i = 0; i < tokens.length; ) {
    let used = 1;
    for (let n = Math.min(maxAliasTokens, tokens.length - i); n >= 1; n--) {
      const key = ALIASES.get(n === 1 ? tokens[i] : tokens.slice(i, i + n).join(' '));
      if (key) {
        out.add(key);
        used = n;
        break;
      }
    }
    i += used;
  }
}

const isRegion = (key: PlaceKey) => key.startsWith('@');
const countryOf = (key: PlaceKey) => {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
};

// ", TX" / ", ON" after a place name. Uppercase only: ", or hybrid" is not Oregon.
const POSTAL_RE = /,\s*([A-Z]{2})(?![A-Za-z0-9])/g;

function addPostalPlaces(text: string, out: Set<PlaceKey>): void {
  for (const m of text.matchAll(POSTAL_RE)) {
    const key = POSTAL_CODES.get(m[1]);
    if (!key) continue;
    // "Chennai, TN" / "Perth, WA": the code belongs to the named city's country
    // (Tamil Nadu, Western Australia), not to a US state — skip it.
    const segment = text.slice(0, m.index).split(/[,;|()\/\n]/).pop() ?? '';
    const named = new Set<PlaceKey>();
    addNamedPlaces(foldTokens(segment), named);
    const country = countryOf(key);
    if ([...named].some((p) => !isRegion(p) && countryOf(p) !== country)) continue;
    out.add(key);
  }
}

/** Drop a place when a more specific place inside it was also named: in
 *  "Manchester, UK" the UK only qualifies Manchester, so the job is not "anywhere
 *  in the UK" (which would wrongly overlap a London-only criteria). */
function mostSpecific(keys: Set<PlaceKey>): Set<PlaceKey> {
  if (keys.size < 2) return keys;
  const all = [...keys];
  return new Set(all.filter((k) => !all.some((o) => o !== k && o.startsWith(k + ':'))));
}

/** Un-post-processed place matches for one piece of text — shared by placesIn
 *  and its segment-level mismatched-country check below (which must scan
 *  individual comma segments without recursing into that same check). */
function rawPlacesIn(text: string): Set<PlaceKey> {
  const out = new Set<PlaceKey>();
  addNamedPlaces(foldTokens(text), out);
  for (const token of text.normalize('NFD').split(/[^A-Za-z0-9]+/)) {
    const cc = CODES.get(token);
    if (cc) out.add(cc);
  }
  addPostalPlaces(text, out);
  return out;
}

/** "City, Region, Country" formatted strings: when the LAST comma/semicolon
 *  segment names exactly one plain country, a SUB-national place matched from
 *  an earlier segment that belongs to a DIFFERENT country is almost always a
 *  same-named place in that other country colliding with ours (Hyderabad is a
 *  city in both India and Pakistan; "Surat Thani" is a Thai province, not
 *  India's Surat) — drop it. Scoped tightly: only sub-national (':'-suffixed)
 *  matches are ever dropped, so a deliberate list of countries ("Australia,
 *  Canada, India, United Kingdom, United States") is untouched — each of those
 *  is already a plain top-level country match, never eligible for dropping. */
function dropMismatchedCountrySegments(text: string, out: Set<PlaceKey>): void {
  const segments = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return;
  const lastPlaces = [...rawPlacesIn(segments[segments.length - 1]!)];
  if (lastPlaces.length !== 1) return;
  const [explicitCountry] = lastPlaces;
  if (explicitCountry!.includes(':') || isRegion(explicitCountry!)) return;
  for (const seg of segments.slice(0, -1)) {
    for (const p of rawPlacesIn(seg)) {
      if (p.includes(':') && countryOf(p) !== explicitCountry) out.delete(p);
    }
  }
}

/** Places named in free text (a job's location string). */
export function placesIn(text: string | null | undefined): Set<PlaceKey> {
  if (!text) return new Set();
  const out = rawPlacesIn(text);
  dropMismatchedCountrySegments(text, out);
  return mostSpecific(out);
}

/** Places a criteria term denotes. A term that is exactly a country code resolves
 *  in any case ("us", "uk"), since the whole term leaves no room for the English
 *  word reading; anything else is read like free text. */
export function placesForTerm(term: string): Set<PlaceKey> {
  const cc = TERM_CODES.get(foldTokens(term).join(' '));
  return cc ? new Set([cc]) : placesIn(term);
}

/** a ⊆ b or b ⊆ a (or two regions sharing a member country). */
function related(a: PlaceKey, b: PlaceKey): boolean {
  if (a === b) return true;
  const ra = REGION_MEMBERS.get(a);
  const rb = REGION_MEMBERS.get(b);
  if (ra && rb) {
    for (const m of ra) if (rb.has(m)) return true;
    return false;
  }
  if (ra) return ra.has(countryOf(b));
  if (rb) return rb.has(countryOf(a));
  return a.startsWith(b + ':') || b.startsWith(a + ':');
}

/** a ⊆ b. */
function within(a: PlaceKey, b: PlaceKey): boolean {
  if (a === b) return true;
  const ra = REGION_MEMBERS.get(a);
  const rb = REGION_MEMBERS.get(b);
  if (rb) {
    if (!ra) return rb.has(countryOf(a));
    for (const m of ra) if (!rb.has(m)) return false;
    return true;
  }
  if (ra) return false;
  return a.startsWith(b + ':');
}

/** True when some place in `a` and some place in `b` could be the same place —
 *  one contains the other (job "APAC" vs "india", job "Bangalore" vs "india",
 *  job "United Kingdom" vs "london"). */
export function placesOverlap(a: ReadonlySet<PlaceKey>, b: ReadonlySet<PlaceKey>): boolean {
  for (const x of a) for (const y of b) if (related(x, y)) return true;
  return false;
}

/** True when some place in `a` lies entirely inside some place in `b` ("Austin, TX"
 *  inside "united states"; "APAC" is NOT inside "india"). */
export function placesWithin(a: ReadonlySet<PlaceKey>, b: ReadonlySet<PlaceKey>): boolean {
  for (const x of a) for (const y of b) if (within(x, y)) return true;
  return false;
}

/** Lift sub-national places to their country; regions stay as they are. */
export function countryLevel(places: ReadonlySet<PlaceKey>): Set<PlaceKey> {
  return new Set([...places].map((k) => (isRegion(k) ? k : countryOf(k))));
}

/** Human-readable name for a key ("us" -> "United States", "@emea" -> "EMEA"). */
export function placeLabel(key: PlaceKey): string {
  return LABELS.get(key) ?? key;
}

// "worldwide"/"global"/etc are unconditional — nothing can narrow them. "anywhere"
// and "all locations" are NOT unconditional: "Anywhere, US", "Anywhere USA",
// "U.S. Anywhere", "Remote - US: All locations" all name a country right next to
// the word, scoping it to "anywhere within the US" rather than the whole world.
const WORLDWIDE_UNCONDITIONAL_RE =
  /(?:^| )(?:worldwide|world wide|global|globally|any location|everywhere)(?: |$)/;
const WORLDWIDE_CONDITIONAL_RE = /(?:^| )(?:anywhere|all locations)(?: |$)/;

/** "Remote - Worldwide", "Anywhere", "Global", "All locations". "Anywhere"/"all
 *  locations" only count as worldwide when the text names no country-level
 *  place alongside them — otherwise they scope to that place, not the globe. */
export function hasWorldwideMarker(text: string | null | undefined): boolean {
  if (!text) return false;
  const folded = foldTokens(text).join(' ');
  if (WORLDWIDE_UNCONDITIONAL_RE.test(folded)) return true;
  if (!WORLDWIDE_CONDITIONAL_RE.test(folded)) return false;
  for (const key of placesIn(text)) if (!isRegion(key)) return false;
  return true;
}
