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
      // After logging in they come back here, for example from a scanned athlete card.
      if (req.method === 'GET') req.session.returnTo = req.originalUrl;
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

// Only the site's owner (the main admin): adding and removing admins, backup
// downloads and the security settings.
function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'admin' && req.user.owner) return next();
  return res.status(403).render('error', { title: 'Not allowed', message: 'Only the main admin can do this.' });
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

// Where to go after logging in: the page that asked for it, if it's on this
// site, else the account's home. Read once.
function afterLogin(req, user) {
  const target = req.session.returnTo;
  delete req.session.returnTo;
  return typeof target === 'string' && /^\/(?![/\\])/.test(target) ? target : homeFor(user);
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

module.exports = { clean, toArray, requireRole, requireOwner, homeFor, afterLogin, passwordError, notFound, wrap, readSetup, readPoomsaeAges };
