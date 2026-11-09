const nodemailer = require('nodemailer');

// Short limits, so an unreachable mail server fails in seconds instead of
// holding a page (or a test) open for minutes.
const TIMEOUTS = { connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 };

// "marvin@gmail.com" becomes "ma***@gmail.com", so settings can be shown safely.
function maskUser(user) {
  if (!user) return '';
  const [name, domain] = String(user).split('@');
  return domain ? `${name.slice(0, 2)}***@${domain}` : `${name.slice(0, 2)}***`;
}

// Turns a failed test into advice an organiser can act on.
function explainMailError({ code, responseCode, error = '' }) {
  const message = String(error);
  if (code === 'NOT_CONFIGURED') return 'Email is not set up. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM to the server\'s settings (on Railway, the service\'s Variables) and redeploy.';
  if (code === 'EAUTH' || responseCode === 535 || /invalid login|authentication/i.test(message)) {
    return 'The mail server refused the username or password. With Gmail, use an App Password (Google account → Security → 2-Step Verification → App passwords), not your normal password. Check SMTP_USER and SMTP_PASS.';
  }
  // Nodemailer often reports these as ESOCKET, so the message is checked as well as the code.
  if (['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED'].includes(code) || /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return 'The server could not reach the mail server. The host or port may be wrong, or the hosting provider may block outgoing email ports. On Railway this can depend on your plan; an email service that works over HTTPS (such as Resend, Postmark or SendGrid) avoids it.';
  }
  if (code === 'EDNS' || /ENOTFOUND|getaddrinfo/i.test(message)) return 'The mail server\'s name could not be found. Check SMTP_HOST for typos, for example smtp.gmail.com.';
  if (code === 'ESOCKET' || /ssl|tls|wrong version number/i.test(message)) {
    return 'The secure connection failed. Use SMTP_PORT 587 (or 465 for providers that ask for it), not 25.';
  }
  if (code === 'EENVELOPE' || responseCode === 550 || responseCode === 553) {
    return 'The mail server would not send from or to that address. Check MAIL_FROM uses an address your provider lets you send from.';
  }
  return 'The mail server returned an error. The message above says why; check it against your provider\'s SMTP settings.';
}

// send() never rejects: a mail problem must not break the page the user is on.
// test() is for the admin's email check, so it reports what went wrong instead.
function createMailer({ host, port, user, pass, from, production = false, logger = console } = {}) {
  const sender = from || 'Game Management System <no-reply@localhost>';

  if (!host) {
    return {
      configured: false,
      details: () => ({ configured: false, host: '', port: '', secure: false, user: '', from: sender }),
      async test() {
        return { ok: false, code: 'NOT_CONFIGURED', error: 'SMTP_HOST is not set.' };
      },
      async send({ to, subject, text }) {
        // Messages can hold password reset links, so bodies are only shown in development.
        if (production) logger.warn(`Email not sent (SMTP_HOST is not set): "${subject}" to ${to}`);
        else logger.log(`\n--- Email (not sent, SMTP_HOST is not set) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---\n`);
      },
    };
  }

  const smtpPort = Number(port) || 587;
  const secure = smtpPort === 465;
  const transport = nodemailer.createTransport({
    host,
    port: smtpPort,
    secure,
    auth: user ? { user, pass } : undefined,
    ...TIMEOUTS,
  });

  return {
    configured: true,
    details: () => ({ configured: true, host, port: smtpPort, secure, user: maskUser(user), from: sender }),
    async test({ to, subject, text }) {
      try {
        await transport.verify();
        await transport.sendMail({ from: sender, to, subject, text });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message, code: error.code, responseCode: error.responseCode };
      }
    },
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from: sender, to, subject, text });
      } catch (error) {
        logger.error(`Email failed: "${subject}" to ${to}: ${error.message}`);
      }
    },
  };
}

module.exports = { createMailer, explainMailError, maskUser };
