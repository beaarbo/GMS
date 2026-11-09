// Admins check that the site can send email, and see why when it can't.
const express = require('express');
const { explainMailError } = require('../mailer');
const { clean, requireRole, wrap } = require('./helpers');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const { mailer, publicUrl } = req.app.locals.notify;
  const details = typeof mailer.details === 'function' ? mailer.details() : { configured: Boolean(mailer.configured) };
  // The last test's result, shown once.
  const result = req.session.emailTest || null;
  delete req.session.emailTest;
  res.render('admin/email', {
    title: 'Email',
    details,
    publicUrl,
    publicUrlWarning: /localhost|127\.0\.0\.1/.test(publicUrl)
      ? 'PUBLIC_URL points at this computer, so links in emails won\'t work for anyone else. Set it to the site\'s address.'
      : !publicUrl.startsWith('https://') ? 'PUBLIC_URL should start with https:// on a live site.' : null,
    result,
  });
});

router.post('/test', wrap(async (req, res) => {
  const { mailer, publicUrl } = req.app.locals.notify;
  const to = clean(req.body.to, 200).toLowerCase() || req.user.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    req.flash('error', 'Enter a valid email address.');
    return res.redirect('/admin/email');
  }
  const message = {
    to,
    subject: 'Test email from Game Management System',
    text: `This is a test email from the Game Management System.\n\nIf you're reading it, the site can send email, including password reset links.\n\nLinks in emails point to: ${publicUrl}\n`,
  };
  let result;
  if (typeof mailer.test === 'function') {
    result = await mailer.test(message);
  } else {
    await mailer.send(message);
    result = { ok: true };
  }
  req.session.emailTest = {
    to,
    ok: result.ok,
    error: result.ok ? null : result.error,
    code: result.ok ? null : result.code || null,
    advice: result.ok ? null : explainMailError(result),
  };
  req.logActivity('account.email_test', `Sent a test email to ${to}: ${result.ok ? 'it worked' : `it failed (${result.code || 'error'})`}`);
  return res.redirect('/admin/email');
}));

module.exports = router;
