const { DEFAULT_BELT_GROUPS } = require('../divisions');

function clean(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Takes one role or a list, for example requireRole(['admin', 'official']).
function requireRole(role) {
  const allowed = Array.isArray(role) ? role : [role];
  return (req, res, next) => {
    if (!req.user) {
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/login');
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).render('error', {
        title: 'Not allowed',
        message: 'Your account does not have access to this page.',
      });
    }
    return next();
  };
}

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 72;

// Returns an error message, or null if the password is acceptable.
function passwordError(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

function homeFor(user) {
  if (user.role === 'admin') return '/admin';
  if (user.role === 'official') return '/official';
  return user.club_id ? '/home' : '/coach';
}

function notFound(res) {
  return res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// The age group rows of a division setup form (kyorugi with weight limits, and
// poomsae), used by a competition's setup and the Settings page's defaults.
function readSetup(body) {
  const names = toArray(body.age_name);
  const ageGroups = names
    .map((_, i) => ({
      name: clean(names[i], 60),
      min_age: Number(toArray(body.age_min)[i]),
      max_age: Number(toArray(body.age_max)[i]),
      minRaw: clean(toArray(body.age_min)[i]),
      maxRaw: clean(toArray(body.age_max)[i]),
      male: clean(toArray(body.age_male)[i], 500),
      female: clean(toArray(body.age_female)[i], 500),
    }))
    .filter((g) => g.name || g.minRaw || g.maxRaw || g.male || g.female);

  // Belt groups are fixed: Blue, Red and Black.
  return { ageGroups, beltGroups: DEFAULT_BELT_GROUPS };
}

// Poomsae age group rows from the form. Rows left blank are dropped.
function readPoomsaeAges(body) {
  const names = toArray(body.poomsae_name);
  return names
    .map((_, i) => ({
      name: clean(names[i], 60),
      minRaw: clean(toArray(body.poomsae_min)[i]),
      maxRaw: clean(toArray(body.poomsae_max)[i]),
    }))
    .filter((g) => g.name || g.minRaw || g.maxRaw)
    .map((g) => ({ ...g, min_age: g.minRaw === '' ? NaN : Number(g.minRaw), max_age: g.maxRaw === '' ? NaN : Number(g.maxRaw) }));
}

module.exports = { clean, toArray, requireRole, homeFor, passwordError, notFound, wrap, readSetup, readPoomsaeAges };
