function clean(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/login');
    }
    if (req.user.role !== role) {
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
  return user.club_id ? '/club' : '/coach';
}

function notFound(res) {
  return res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { clean, toArray, requireRole, homeFor, passwordError, notFound, wrap };
