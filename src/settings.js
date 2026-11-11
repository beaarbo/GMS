// Site settings an admin changes on the Settings page, stored as text in
// site_settings. Anything never saved keeps its default, so a new site behaves
// as before. Secrets (email keys, the session secret) stay environment variables.
const { DEFAULT_AGE_GROUPS, validateSetup, DEFAULT_BELT_GROUPS } = require('./divisions');
const { DEFAULT_POOMSAE_AGE_GROUPS, validatePoomsaeAgeGroups, POOMSAE_FORMATS, JUDGE_COUNTS, MAX_CUT } = require('./poomsae');

const DEFAULTS = {
  site_name: 'Game Management System',
  contact_email: '',
  footer_text: 'Taekwondo kyorugi and poomsae registration',
  time_zone: '',
  sender_name: '',
  require_document: '1',
  document_types: 'any',
  reminder_days: '3',
  coach_signup: '1',
  require_2fa_admins: '0',
  public_names: 'full',
  public_club_icons: '0',
  document_retention_days: '',
  backup_keep_daily: '7',
  backup_keep_manual: '10',
  offsite_backup_email: '',
  // Competition defaults. Age groups are JSON; blank means the built-in template.
  default_kyorugi_ages: '',
  default_poomsae_ages: '',
  default_age_basis: 'year',
  default_max_per_club: '',
  default_bout_courts: '2',
  default_bout_start: '09:00',
  default_bout_minutes: '10',
  default_bout_rest: '0',
  default_poomsae_format: 'score',
  default_poomsae_cut: '16',
  default_poomsae_judges: '1',
  default_poomsae_courts: '1',
  default_poomsae_start: '09:00',
  default_poomsae_minutes: '5',
  default_poomsae_rest: '0',
};

const DOCUMENT_TYPES = { any: 'Pictures or PDF', images: 'Pictures only (JPG, PNG, WebP)', pdf: 'PDF only' };
const PUBLIC_NAMES = { full: 'Full names', initials: 'First name and surname initial (Ana R.)' };

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) && value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

const int = (text) => (text === '' || text === null || text === undefined ? null : Number(text));

// Every setting, typed, with defaults filled in.
function loadSettings(db) {
  const raw = { ...DEFAULTS };
  db.prepare('SELECT key, value FROM site_settings').all().forEach((row) => {
    if (row.key in raw) raw[row.key] = row.value;
  });
  return {
    raw,
    siteName: raw.site_name || DEFAULTS.site_name,
    contactEmail: raw.contact_email,
    footerText: raw.footer_text,
    timeZone: raw.time_zone,
    senderName: raw.sender_name,
    requireDocument: raw.require_document === '1',
    documentTypes: DOCUMENT_TYPES[raw.document_types] ? raw.document_types : 'any',
    reminderDays: int(raw.reminder_days) || 3,
    coachSignup: raw.coach_signup === '1',
    require2faAdmins: raw.require_2fa_admins === '1',
    publicNames: PUBLIC_NAMES[raw.public_names] ? raw.public_names : 'full',
    publicClubIcons: raw.public_club_icons === '1',
    documentRetentionDays: int(raw.document_retention_days),
    backupKeep: { daily: int(raw.backup_keep_daily) || 7, manual: int(raw.backup_keep_manual) || 10 },
    offsiteBackupEmail: raw.offsite_backup_email,
    defaults: {
      kyorugiAgeGroups: parseJson(raw.default_kyorugi_ages, DEFAULT_AGE_GROUPS),
      poomsaeAgeGroups: parseJson(raw.default_poomsae_ages, DEFAULT_POOMSAE_AGE_GROUPS),
      competition: {
        age_basis: raw.default_age_basis === 'date' ? 'date' : 'year',
        max_per_club_division: int(raw.default_max_per_club),
        bout_courts: int(raw.default_bout_courts),
        bout_start: raw.default_bout_start,
        bout_minutes: int(raw.default_bout_minutes),
        bout_rest_minutes: int(raw.default_bout_rest),
        poomsae_format: raw.default_poomsae_format,
        poomsae_cut: int(raw.default_poomsae_cut),
        poomsae_judges: int(raw.default_poomsae_judges),
        poomsae_courts: int(raw.default_poomsae_courts),
        poomsae_start: raw.default_poomsae_start,
        poomsae_minutes: int(raw.default_poomsae_minutes),
        poomsae_rest_minutes: int(raw.default_poomsae_rest),
      },
    },
  };
}

// Saves only known keys. Callers validate first.
function saveSettings(db, values) {
  const upsert = db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => Object.entries(values).forEach(([key, value]) => {
    if (key in DEFAULTS) upsert.run(key, String(value ?? ''));
  }))();
}

function validTimeZone(zone) {
  if (!zone) return true;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

// The server's own TZ, from before any saved setting replaced it.
const SERVER_TZ = process.env.TZ;

// The time zone deadlines and dates use. Node reads TZ again whenever it
// changes, so setting it applies at once. Blank goes back to the server's own.
function applyTimeZone(zone) {
  if (zone) process.env.TZ = zone;
  else if (SERVER_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = SERVER_TZ;
}

// How many backups to keep: the Settings page's counts once saved, else the
// server's start-up ones (BACKUP_KEEP_DAYS).
function backupKeep(db, fallback) {
  const saved = db.prepare("SELECT 1 FROM site_settings WHERE key = 'backup_keep_daily'").get();
  return saved || !fallback ? loadSettings(db).backupKeep : fallback;
}

// "Rossi Ana" becomes "Rossi A.", and a pair's "Ana Rossi, Mia Lee" becomes
// "Ana R., Mia L.": one name in full, the rest as initials.
function shortName(text) {
  return String(text).split(', ').map((person) => {
    const [first, ...rest] = person.trim().split(/\s+/);
    return [first, ...rest.map((word) => `${word[0]}.`)].join(' ');
  }).join(', ');
}

// Shortens every athlete name in a page's data, for visitors when the Settings
// page asks for it. Athletes are the objects with a club beside their name.
function shortenNames(value) {
  if (Array.isArray(value)) return value.map(shortenNames);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out = {};
  Object.entries(value).forEach(([key, item]) => { out[key] = shortenNames(item); });
  if (typeof value.name === 'string' && 'club' in value) out.name = shortName(value.name);
  return out;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const whole = (text, min, max) => /^\d{1,4}$/.test(String(text ?? '').trim()) && Number(text) >= min && Number(text) <= max;

// Checks the main Settings form. Returns { values, errors } with values as text keyed like DEFAULTS.
function readSiteSettings(body) {
  const text = (name, max = 200) => String(body[name] ?? '').trim().slice(0, max);
  const values = {
    site_name: text('site_name', 80),
    contact_email: text('contact_email', 200),
    footer_text: text('footer_text', 200),
    time_zone: text('time_zone', 60),
    sender_name: text('sender_name', 80),
    require_document: body.require_document === '1' ? '1' : '0',
    document_types: DOCUMENT_TYPES[body.document_types] ? body.document_types : 'any',
    reminder_days: text('reminder_days', 3),
    coach_signup: body.coach_signup === '1' ? '1' : '0',
    require_2fa_admins: body.require_2fa_admins === '1' ? '1' : '0',
    public_names: PUBLIC_NAMES[body.public_names] ? body.public_names : 'full',
    public_club_icons: body.public_club_icons === '1' ? '1' : '0',
    document_retention_days: text('document_retention_days', 4),
    backup_keep_daily: text('backup_keep_daily', 3),
    backup_keep_manual: text('backup_keep_manual', 3),
    offsite_backup_email: text('offsite_backup_email', 200).toLowerCase(),
  };
  const errors = [];
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!values.site_name) errors.push('Enter a site name.');
  if (values.contact_email && !email.test(values.contact_email)) errors.push('Enter a valid contact email, or leave it blank.');
  if (values.offsite_backup_email && !email.test(values.offsite_backup_email)) errors.push('Enter a valid email for the off-site backup, or leave it blank.');
  if (!validTimeZone(values.time_zone)) errors.push('That time zone is not recognised. Use a name like Asia/Singapore.');
  if (!whole(values.reminder_days, 1, 30)) errors.push('Send the deadline reminder from 1 to 30 days before.');
  if (values.document_retention_days && !whole(values.document_retention_days, 1, 3650)) errors.push('Keep documents from 1 to 3650 days after a competition, or leave it blank to keep them.');
  if (!whole(values.backup_keep_daily, 1, 365)) errors.push('Keep from 1 to 365 daily backups.');
  if (!whole(values.backup_keep_manual, 1, 100)) errors.push('Keep from 1 to 100 manual backups.');
  return { values, errors };
}

// Checks the Competition defaults form: the age groups (with the kyorugi weight
// classes) and the schedule and poomsae defaults for new competitions.
function readCompetitionDefaults(body, { kyorugiAges, poomsaeAges }) {
  const text = (name, max = 10) => String(body[name] ?? '').trim().slice(0, max);
  const values = {
    default_age_basis: body.default_age_basis === 'date' ? 'date' : 'year',
    default_max_per_club: text('default_max_per_club', 3),
    default_bout_courts: text('default_bout_courts', 3),
    default_bout_start: text('default_bout_start', 5),
    default_bout_minutes: text('default_bout_minutes', 3),
    default_bout_rest: text('default_bout_rest', 3),
    default_poomsae_format: POOMSAE_FORMATS[body.default_poomsae_format] ? body.default_poomsae_format : 'score',
    default_poomsae_cut: text('default_poomsae_cut', 3),
    default_poomsae_judges: text('default_poomsae_judges', 1),
    default_poomsae_courts: text('default_poomsae_courts', 3),
    default_poomsae_start: text('default_poomsae_start', 5),
    default_poomsae_minutes: text('default_poomsae_minutes', 3),
    default_poomsae_rest: text('default_poomsae_rest', 3),
    default_kyorugi_ages: JSON.stringify(kyorugiAges.map(({ name, min_age, max_age, male, female }) => ({ name, min_age, max_age, male, female }))),
    default_poomsae_ages: JSON.stringify(poomsaeAges.map(({ name, min_age, max_age }) => ({ name, min_age, max_age }))),
  };
  const errors = [
    ...validateSetup({ ageGroups: kyorugiAges, beltGroups: DEFAULT_BELT_GROUPS }),
    ...validatePoomsaeAgeGroups(poomsaeAges),
  ];
  if (values.default_max_per_club && !whole(values.default_max_per_club, 1, 50)) errors.push('Enter a club limit per division from 1 to 50, or leave it blank for no limit.');
  if (!whole(values.default_bout_courts, 1, 20)) errors.push('Enter from 1 to 20 kyorugi courts.');
  if (!TIME.test(values.default_bout_start)) errors.push('Enter a valid kyorugi start time.');
  if (!whole(values.default_bout_minutes, 1, 120)) errors.push('Enter from 1 to 120 minutes per kyorugi bout.');
  if (!whole(values.default_bout_rest, 0, 240)) errors.push('Enter a kyorugi rest from 0 to 240 minutes.');
  if (!whole(values.default_poomsae_cut, 2, MAX_CUT)) errors.push(`Enter a poomsae cut from 2 to ${MAX_CUT}.`);
  if (!JUDGE_COUNTS.includes(Number(values.default_poomsae_judges))) errors.push('Choose 1, 3, 5 or 7 poomsae judges.');
  if (!whole(values.default_poomsae_courts, 1, 20)) errors.push('Enter from 1 to 20 poomsae courts.');
  if (!TIME.test(values.default_poomsae_start)) errors.push('Enter a valid poomsae start time.');
  if (!whole(values.default_poomsae_minutes, 1, 60)) errors.push('Enter from 1 to 60 minutes per poomsae performance or bout.');
  if (!whole(values.default_poomsae_rest, 0, 120)) errors.push('Enter a poomsae rest from 0 to 120 minutes.');
  return { values, errors };
}

module.exports = {
  DEFAULTS,
  DOCUMENT_TYPES,
  PUBLIC_NAMES,
  loadSettings,
  saveSettings,
  readSiteSettings,
  readCompetitionDefaults,
  applyTimeZone,
  validTimeZone,
  backupKeep,
  shortName,
  shortenNames,
};
