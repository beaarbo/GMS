// Every logged-in user's own account: details, email, password and, for
// coaches, their club.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { applyToClub } = require('../services');
const { notifyAdminsOfApplication, notifyAccountChange, EMAIL_KINDS } = require('../notifications');
const { newSecret, verifyCode, otpauthUrl, groupSecret, newRecoveryCodes, hashRecoveryCode } = require('../totp');
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

// The email kinds this person's role receives.
const kindsFor = (role) => Object.entries(EMAIL_KINDS).filter(([, kind]) => kind.roles.includes(role));

function render(req, res, status = 200, errors = {}, values = {}, extra = {}) {
  const { db } = req.app.locals;
  const user = db.prepare('SELECT id, email, full_name, phone, role, club_id, theme, email_opt_out, totp_secret IS NOT NULL AS two_step, totp_recovery FROM users WHERE id = ?').get(req.user.id);
  const setupSecret = !user.two_step && req.session.totpSetup;
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
    emailChoices: kindsFor(user.role),
    optedOut: JSON.parse(user.email_opt_out),
    recoveryLeft: JSON.parse(user.totp_recovery).length,
    twoStepSetup: setupSecret
      ? { key: groupSecret(setupSecret), link: otpauthUrl(setupSecret, user.email, req.site.siteName) }
      : null,
    recoveryCodes: null,
    ...extra,
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

// The theme follows the account onto every device. The top bar's theme button
// posts here in the background (ajax=1), and the Appearance form without JavaScript.
router.post('/theme', (req, res) => {
  const theme = ['auto', 'dark', 'light'].includes(req.body.theme) ? req.body.theme : 'auto';
  req.app.locals.db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.id);
  if (req.body.ajax === '1') return res.status(204).end();
  req.flash('success', 'Theme saved.');
  return res.redirect('/account#appearance');
});

router.post('/emails', (req, res) => {
  const chosen = new Set([].concat(req.body.kind || []));
  const optOut = kindsFor(req.user.role).map(([key]) => key).filter((key) => !chosen.has(key));
  req.app.locals.db.prepare('UPDATE users SET email_opt_out = ? WHERE id = ?').run(JSON.stringify(optOut), req.user.id);
  req.logActivity('account.emails', 'Changed which emails they get');
  req.flash('success', 'Notifications saved.');
  return res.redirect('/account#emails');
});

// Two-step login: a new key is kept in the session until a code from it is
// entered, so a mistyped key never locks anyone out.
router.post('/two-step/start', (req, res) => {
  if (req.user.two_step) return res.redirect('/account#two-step');
  req.session.totpSetup = newSecret();
  return res.redirect('/account#two-step');
});

router.post('/two-step/confirm', (req, res) => {
  const { db, notify } = req.app.locals;
  const secret = req.session.totpSetup;
  if (req.user.two_step || !secret) return res.redirect('/account#two-step');
  if (!verifyCode(secret, req.body.code)) {
    return render(req, res, 400, { twoStep: 'That code didn\'t match. Check the key was typed correctly and the phone\'s clock is right, then try the newest code.' });
  }
  const codes = newRecoveryCodes();
  db.prepare('UPDATE users SET totp_secret = ?, totp_recovery = ? WHERE id = ?').run(secret, JSON.stringify(codes.map(hashRecoveryCode)), req.user.id);
  delete req.session.totpSetup;
  req.user.two_step = 1;
  res.locals.user = req.user;
  req.logActivity('account.two_step_on', 'Turned on two-step login');
  notifyAccountChange(notify, req.user.email, 'Two-step login was turned on for your account.');
  // Shown this once only; just their hashes are kept.
  return render(req, res, 200, {}, {}, { recoveryCodes: codes });
});

router.post('/two-step/off', passwordCheckLimiter, wrap(async (req, res) => {
  const { db, notify } = req.app.locals;
  if (!req.user.two_step) return res.redirect('/account#two-step');
  if (!(await checkCurrentPassword(req, req.body.current_password))) {
    return render(req, res, 401, { twoStep: 'Your current password is incorrect.' });
  }
  db.prepare("UPDATE users SET totp_secret = NULL, totp_recovery = '[]' WHERE id = ?").run(req.user.id);
  req.logActivity('account.two_step_off', 'Turned off two-step login');
  notifyAccountChange(notify, req.user.email, 'Two-step login was turned off for your account.');
  req.flash('success', 'Two-step login is off. You log in with your password alone.');
  return res.redirect('/account#two-step');
}));

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
