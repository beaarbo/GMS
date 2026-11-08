// Every logged-in user's own account: details, email, password and, for
// coaches, their club.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { applyToClub } = require('../services');
const { notifyAdminsOfApplication, notifyAccountChange } = require('../notifications');
const { clean, passwordError, wrap } = require('./helpers');

const router = express.Router();

router.use((req, res, next) => {
  if (req.user) return next();
  req.flash('error', 'Please log in to continue.');
  return res.redirect('/login');
});

// Wrong current passwords count against this, so it can't be used to guess one.
const passwordCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).render('error', {
      title: 'Too many attempts',
      message: 'Too many attempts. Please wait 15 minutes and try again.',
    });
  },
});

function render(req, res, status = 200, errors = {}, values = {}) {
  const { db } = req.app.locals;
  const user = db.prepare('SELECT id, email, full_name, phone, role, club_id FROM users WHERE id = ?').get(req.user.id);
  const pending =
    db
      .prepare(
        `SELECT a.id, c.name AS club FROM club_applications a JOIN clubs c ON c.id = a.club_id
         WHERE a.user_id = ? AND a.status = 'pending'`
      )
      .get(user.id) || null;
  return res.status(status).render('account', {
    title: 'My account',
    account: user,
    clubName: user.club_id ? db.prepare('SELECT name FROM clubs WHERE id = ?').get(user.club_id).name : null,
    pending,
    clubs: db.prepare('SELECT id, name, city FROM clubs ORDER BY name').all(),
    errors,
    values,
  });
}

// Fails when the current password is wrong. Resolves to true when it's right.
async function checkCurrentPassword(req, password) {
  const { password_hash: hash } = req.app.locals.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  return bcrypt.compare(typeof password === 'string' ? password : '', hash);
}

router.get('/', (req, res) => render(req, res));

router.post('/details', (req, res) => {
  const fullName = clean(req.body.full_name);
  const phone = clean(req.body.phone, 40);
  const errors = {};
  if (!fullName) errors.details = 'Enter your name.';
  else if (req.user.role === 'coach' && !phone) errors.details = 'Enter a contact number.';
  if (errors.details) return render(req, res, 400, errors, { full_name: fullName, phone });

  req.app.locals.db.prepare('UPDATE users SET full_name = ?, phone = ? WHERE id = ?').run(fullName, phone, req.user.id);
  req.logActivity('account.updated', 'Updated their name or contact number');
  req.flash('success', 'Details saved.');
  return res.redirect('/account');
});

router.post(
  '/email',
  passwordCheckLimiter,
  wrap(async (req, res) => {
    const { db, notify } = req.app.locals;
    const email = clean(req.body.email).toLowerCase();
    const values = { email };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return render(req, res, 400, { email: 'Enter a valid email address.' }, values);
    if (email === req.user.email.toLowerCase()) return render(req, res, 400, { email: 'That is already your email.' }, values);
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) {
      return render(req, res, 400, { email: 'An account with this email already exists.' }, values);
    }
    if (!(await checkCurrentPassword(req, req.body.current_password))) {
      return render(req, res, 401, { email: 'Your current password is incorrect.' }, values);
    }

    const oldEmail = req.user.email;
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    req.logActivity('account.email_changed', `Changed their email from ${oldEmail} to ${email}`);
    // Tells the old address, so someone who took over the account can't hide it.
    notifyAccountChange(notify, oldEmail, `The email address for your account was changed to ${email}.`);
    req.flash('success', `Email changed. Use ${email} to log in from now on.`);
    return res.redirect('/account');
  })
);

router.post(
  '/password',
  passwordCheckLimiter,
  wrap(async (req, res) => {
    const { db, notify } = req.app.locals;
    const password = typeof req.body.new_password === 'string' ? req.body.new_password : '';
    const problem =
      passwordError(password) || (password !== req.body.confirm_password ? 'The new passwords do not match.' : null);
    if (problem) return render(req, res, 400, { password: problem });
    if (!(await checkCurrentPassword(req, req.body.current_password))) {
      return render(req, res, 401, { password: 'Your current password is incorrect.' });
    }

    const hash = await bcrypt.hash(password, 12);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
      // Logs out every other device, in case the old password was known to someone.
      db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid != ?").run(req.user.id, req.sessionID);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(req.user.id);
    })();
    req.logActivity('account.password_changed', 'Changed their password');
    notifyAccountChange(notify, req.user.email, 'The password for your account was changed.');
    req.flash('success', 'Password changed. Any other devices have been logged out.');
    return res.redirect('/account');
  })
);

function requireCoach(req, res, next) {
  if (req.user.role === 'coach') return next();
  return res.status(403).render('error', { title: 'Not allowed', message: 'Only coaches belong to a club.' });
}

router.post('/club', requireCoach, (req, res) => {
  const { db, notify } = req.app.locals;
  const clubId = Number(req.body.club_id);
  const result = applyToClub(db, req.user.id, clubId);
  if (!result.ok) return render(req, res, 400, { club: result.error });
  const club = db.prepare('SELECT name FROM clubs WHERE id = ?').get(clubId);
  req.logActivity(
    'coach.applied',
    req.user.club_id ? `Asked to move from ${req.user.club_name} to ${club.name}` : `Applied to join ${club.name}`
  );
  notifyAdminsOfApplication(notify, req.user.id, clubId);
  req.flash('success', `Request sent. An admin will review it.${req.user.club_id ? ` You stay in ${req.user.club_name} until then.` : ''}`);
  return res.redirect('/account');
});

router.post('/club/withdraw', requireCoach, (req, res) => {
  const { changes } = req.app.locals.db
    .prepare("DELETE FROM club_applications WHERE user_id = ? AND status = 'pending'")
    .run(req.user.id);
  if (changes > 0) {
    req.logActivity('coach.withdrew', 'Withdrew their club request');
    req.flash('success', 'Request withdrawn.');
  }
  return res.redirect('/account');
});

// The club keeps its athletes and registrations.
router.post('/club/leave', requireCoach, (req, res) => {
  const { db } = req.app.locals;
  if (!req.user.club_id) return res.redirect('/account');
  db.transaction(() => {
    db.prepare('UPDATE users SET club_id = NULL WHERE id = ?').run(req.user.id);
    db.prepare(
      "UPDATE club_applications SET status = 'removed', reviewed_at = datetime('now') WHERE user_id = ? AND status = 'approved'"
    ).run(req.user.id);
  })();
  req.logActivity('coach.left', `Left ${req.user.club_name}`);
  req.flash('success', `You left ${req.user.club_name}. Its athletes stay with the club.`);
  return res.redirect('/account');
});

module.exports = router;
