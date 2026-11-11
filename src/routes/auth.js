const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { createCoachAccount, createPasswordReset, findPasswordReset, completePasswordReset } = require('../services');
const { sendPasswordReset } = require('../notifications');
const { logActivity } = require('../activity');
const { clean, wrap, homeFor, afterLogin, passwordError } = require('./helpers');
const { verifyCode, hashRecoveryCode } = require('../totp');

// How long the code page waits after the password was right.
const TWO_STEP_WINDOW_MS = 5 * 60 * 1000;

const router = express.Router();

// Compared against when an email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Only failures count, so coaches sharing venue Wi-Fi don't lock each other out.
  skipSuccessfulRequests: true,
  skip: (req) => req.method !== 'POST',
  handler: (req, res) => {
    res.status(429).render('error', {
      title: 'Too many attempts',
      message: 'Too many attempts from this connection. Please wait 15 minutes and try again.',
    });
  },
});

function startSession(req, userId, callback) {
  const { returnTo } = req.session;
  req.session.regenerate((error) => {
    if (error) return callback(error);
    req.session.userId = userId;
    if (returnTo) req.session.returnTo = returnTo;
    return req.session.save(callback);
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  return res.render('login', { title: 'Log in', email: '', error: null });
});

router.post(
  '/login',
  authLimiter,
  wrap(async (req, res, next) => {
    const email = clean(req.body.email).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = req.app.locals.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !valid) {
      return res.status(401).render('login', { title: 'Log in', email, error: 'Incorrect email or password.' });
    }
    if (user.totp_secret) {
      // Not logged in yet: the code page finishes it.
      const { returnTo } = req.session;
      return req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.twoStep = { userId: user.id, at: Date.now() };
        if (returnTo) req.session.returnTo = returnTo;
        return req.session.save((saveError) => (saveError ? next(saveError) : res.redirect('/login/code')));
      });
    }
    return startSession(req, user.id, (error) => (error ? next(error) : res.redirect(afterLogin(req, user))));
  })
);

function pendingTwoStep(req) {
  const pending = req.session.twoStep;
  return pending && Date.now() - pending.at < TWO_STEP_WINDOW_MS ? pending : null;
}

router.get('/login/code', (req, res) => {
  if (!pendingTwoStep(req)) return res.redirect('/login');
  return res.render('login_code', { title: 'Two-step login', error: null });
});

// Takes the authenticator's six digits or one of the recovery codes, which then stops working.
// shortcut: a code can be used twice within its 30 seconds; keep the last used step per user if that matters.
router.post('/login/code', authLimiter, (req, res, next) => {
  const pending = pendingTwoStep(req);
  if (!pending) {
    req.flash('error', 'That took too long. Please log in again.');
    return res.redirect('/login');
  }
  const { db } = req.app.locals;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.userId);
  const code = clean(req.body.code, 20);
  let ok = Boolean(user && user.totp_secret && verifyCode(user.totp_secret, code));
  if (user && !ok && /[a-f0-9]{5}-?[a-f0-9]{5}/i.test(code)) {
    const hashes = JSON.parse(user.totp_recovery);
    const left = hashes.filter((hash) => hash !== hashRecoveryCode(code));
    if (left.length < hashes.length) {
      db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(left), user.id);
      logActivity(db, { user, action: 'account.recovery_code', summary: `Logged in with a recovery code (${left.length} left)` });
      req.flash('info', `You used a recovery code. ${left.length} left. If you lost your phone, turn two-step login off and on again on My account for new ones.`);
      ok = true;
    }
  }
  if (!ok) return res.status(401).render('login_code', { title: 'Two-step login', error: 'That code is not right. Use the newest code from your authenticator app.' });
  return startSession(req, user.id, (error) => (error ? next(error) : res.redirect(afterLogin(req, user))));
});

// Sign-up can be closed on the Settings page; admins then add coaches themselves.
function signupOpen(req, res, next) {
  if (req.site.coachSignup) return next();
  return res.status(403).render('error', {
    title: 'Sign-up is closed',
    message: `Coach accounts are made by the organiser.${req.site.contactEmail ? ` Ask them at ${req.site.contactEmail}.` : ' Ask them for one.'}`,
  });
}

router.get('/register', signupOpen, (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  return res.render('register', { title: 'Create a coach account', values: {}, errors: [] });
});

router.post(
  '/register',
  signupOpen,
  authLimiter,
  wrap(async (req, res, next) => {
    const { db } = req.app.locals;
    const values = {
      full_name: clean(req.body.full_name),
      phone: clean(req.body.phone, 40),
      email: clean(req.body.email).toLowerCase(),
    };
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    const errors = [];
    if (!values.full_name) errors.push('Enter your full name.');
    if (!values.phone) errors.push('Enter a contact number.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('Enter a valid email address.');
    if (passwordError(password)) errors.push(passwordError(password));
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) errors.push('An account with this email already exists.');

    if (errors.length > 0) {
      return res.status(400).render('register', { title: 'Create a coach account', values, errors });
    }

    const userId = await createCoachAccount(db, { ...values, password });
    logActivity(db, {
      user: { id: userId, email: values.email, full_name: values.full_name },
      action: 'account.created',
      summary: `Created a coach account`,
    });
    return startSession(req, userId, (error) => {
      if (error) return next(error);
      req.flash('success', `Welcome, ${values.full_name}. Apply to your club to get started.`);
      return res.redirect('/coach');
    });
  })
);

// Every request counts here, because these always "succeed" and each could send an email.
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
  handler: (req, res) => {
    res.status(429).render('error', {
      title: 'Too many attempts',
      message: 'Too many attempts from this connection. Please wait 15 minutes and try again.',
    });
  },
});

function renderResetProblem(res) {
  return res.status(400).render('error', {
    title: 'Link not valid',
    message: 'This reset link has expired or was already used. Please ask for a new one from the login page.',
  });
}

router.get('/forgot-password', (req, res) => {
  res.render('forgot', { title: 'Forgot password', sent: false });
});

// The reply is the same whether or not the email exists, so this page can't be
// used to find out who has an account. The email sends in the background for the
// same reason: a reply that waits for sending would be slower for real accounts.
router.post('/forgot-password', forgotLimiter, (req, res) => {
  const { notify } = req.app.locals;
  const email = clean(req.body.email).toLowerCase();
  const user = notify.db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (user) {
    const token = createPasswordReset(notify.db, user.id);
    if (token) sendPasswordReset(notify, user.email, token);
  }
  res.render('forgot', { title: 'Forgot password', sent: true });
});

router.get('/reset-password/:token([0-9a-f]{64})', (req, res) => {
  if (!findPasswordReset(req.app.locals.db, req.params.token)) return renderResetProblem(res);
  return res.render('reset', { title: 'Choose a new password', token: req.params.token, error: null });
});

router.post(
  '/reset-password/:token([0-9a-f]{64})',
  forgotLimiter,
  wrap(async (req, res) => {
    const { db } = req.app.locals;
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!findPasswordReset(db, req.params.token)) return renderResetProblem(res);
    const error = passwordError(password);
    if (error) return res.status(400).render('reset', { title: 'Choose a new password', token: req.params.token, error });
    const account = db
      .prepare('SELECT u.id, u.email, u.full_name FROM users u JOIN password_resets p ON p.user_id = u.id WHERE p.id = ?')
      .get(findPasswordReset(db, req.params.token).id);
    if (!(await completePasswordReset(db, req.params.token, password))) return renderResetProblem(res);
    logActivity(db, { user: account, action: 'account.password_reset', summary: 'Reset their password using an emailed link' });
    req.flash('success', 'Password changed. Please log in with your new password.');
    return res.redirect('/login');
  })
);

router.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('gms.sid');
    return res.redirect('/');
  });
});

module.exports = router;
