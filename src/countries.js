// Countries a club can belong to, by the three-letter codes taekwondo results use
// (World Taekwondo and the Olympics: SGP for Singapore, MAS for Malaysia). A club's
// athletes show its code on bout lists and results. No database or web imports.
const COUNTRIES = {
  AFG: 'Afghanistan', ALB: 'Albania', ALG: 'Algeria', ARG: 'Argentina', ARM: 'Armenia', AUS: 'Australia', AUT: 'Austria',
  AZE: 'Azerbaijan', BAH: 'Bahamas', BRN: 'Bahrain', BAN: 'Bangladesh', BLR: 'Belarus', BEL: 'Belgium', BEN: 'Benin',
  BHU: 'Bhutan', BOL: 'Bolivia', BIH: 'Bosnia and Herzegovina', BOT: 'Botswana', BRA: 'Brazil', BRU: 'Brunei',
  BUL: 'Bulgaria', BUR: 'Burkina Faso', CAM: 'Cambodia', CMR: 'Cameroon', CAN: 'Canada', CHI: 'Chile', CHN: 'China',
  TPE: 'Chinese Taipei', COL: 'Colombia', CRC: 'Costa Rica', CIV: 'Côte d’Ivoire', CRO: 'Croatia', CUB: 'Cuba',
  CYP: 'Cyprus', CZE: 'Czechia', DEN: 'Denmark', DOM: 'Dominican Republic', ECU: 'Ecuador', EGY: 'Egypt',
  ESA: 'El Salvador', EST: 'Estonia', ETH: 'Ethiopia', FIJ: 'Fiji', FIN: 'Finland', FRA: 'France', GAB: 'Gabon',
  GEO: 'Georgia', GER: 'Germany', GHA: 'Ghana', GBR: 'Great Britain', GRE: 'Greece', GUA: 'Guatemala', HAI: 'Haiti',
  HON: 'Honduras', HKG: 'Hong Kong, China', HUN: 'Hungary', ISL: 'Iceland', IND: 'India', INA: 'Indonesia', IRI: 'Iran',
  IRQ: 'Iraq', IRL: 'Ireland', ISR: 'Israel', ITA: 'Italy', JAM: 'Jamaica', JPN: 'Japan', JOR: 'Jordan',
  KAZ: 'Kazakhstan', KEN: 'Kenya', KOR: 'Korea', KOS: 'Kosovo', KUW: 'Kuwait', KGZ: 'Kyrgyzstan', LAO: 'Laos',
  LAT: 'Latvia', LBN: 'Lebanon', LBA: 'Libya', LTU: 'Lithuania', LUX: 'Luxembourg', MAC: 'Macao, China',
  MAD: 'Madagascar', MAS: 'Malaysia', MDV: 'Maldives', MLI: 'Mali', MLT: 'Malta', MRI: 'Mauritius', MEX: 'Mexico',
  MDA: 'Moldova', MGL: 'Mongolia', MNE: 'Montenegro', MAR: 'Morocco', MOZ: 'Mozambique', MYA: 'Myanmar', NAM: 'Namibia',
  NEP: 'Nepal', NED: 'Netherlands', NZL: 'New Zealand', NCA: 'Nicaragua', NIG: 'Niger', NGR: 'Nigeria',
  MKD: 'North Macedonia', NOR: 'Norway', OMA: 'Oman', PAK: 'Pakistan', PLE: 'Palestine', PAN: 'Panama',
  PNG: 'Papua New Guinea', PAR: 'Paraguay', PER: 'Peru', PHI: 'Philippines', POL: 'Poland', POR: 'Portugal',
  PUR: 'Puerto Rico', QAT: 'Qatar', ROU: 'Romania', RWA: 'Rwanda', SAM: 'Samoa', KSA: 'Saudi Arabia', SEN: 'Senegal',
  SRB: 'Serbia', SGP: 'Singapore', SVK: 'Slovakia', SLO: 'Slovenia', RSA: 'South Africa', ESP: 'Spain', SRI: 'Sri Lanka',
  SUD: 'Sudan', SWE: 'Sweden', SUI: 'Switzerland', SYR: 'Syria', TJK: 'Tajikistan', TAN: 'Tanzania', THA: 'Thailand',
  TLS: 'Timor-Leste', TGA: 'Tonga', TTO: 'Trinidad and Tobago', TUN: 'Tunisia', TUR: 'Türkiye', TKM: 'Turkmenistan',
  UGA: 'Uganda', UKR: 'Ukraine', UAE: 'United Arab Emirates', USA: 'United States', URU: 'Uruguay', UZB: 'Uzbekistan',
  VAN: 'Vanuatu', VEN: 'Venezuela', VIE: 'Vietnam', YEM: 'Yemen', ZAM: 'Zambia', ZIM: 'Zimbabwe',
};

// The list for a form's select, sorted by name.
const COUNTRY_OPTIONS = Object.entries(COUNTRIES).sort((a, b) => a[1].localeCompare(b[1], 'en'));

// A form's value, kept only when it's a known code. Blank means none.
function readCountry(value) {
  const code = String(value || '').trim().toUpperCase();
  return COUNTRIES[code] ? code : '';
}

module.exports = { COUNTRIES, COUNTRY_OPTIONS, readCountry };
