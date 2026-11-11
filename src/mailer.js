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

// Email services that work over HTTPS, for hosts that block outgoing SMTP
// (Railway does on some plans). Each takes the sender as { name, email }, and
// attachments as [{ filename, content: Buffer }].
const base64 = (attachments) => attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') }));
const API_PROVIDERS = {
  brevo: {
    label: 'Brevo',
    host: 'api.brevo.com',
    request: ({ apiKey, sender, to, subject, text, attachments }) => ({
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: {
        sender, to: [{ email: to }], subject, textContent: text,
        ...(attachments && attachments.length ? { attachment: base64(attachments).map((a) => ({ name: a.filename, content: a.content })) } : {}),
      },
    }),
  },
  resend: {
    label: 'Resend',
    host: 'api.resend.com',
    request: ({ apiKey, sender, to, subject, text, attachments }) => ({
      url: 'https://api.resend.com/emails',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: {
        from: sender.name ? `${sender.name} <${sender.email}>` : sender.email, to: [to], subject, text,
        ...(attachments && attachments.length ? { attachments: base64(attachments) } : {}),
      },
    }),
  },
};

// "Game Management System <club@example.com>" becomes { name, email }.
function parseSender(from) {
  const match = String(from || '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].replace(/^"|"$/g, ''), email: match[2].trim() };
  return { name: '', email: String(from || '').trim() };
}

// Turns a failed test into advice an organiser can act on.
function explainMailError({ code, responseCode, status, provider, error = '' }) {
  const message = String(error);
  if (code === 'NOT_CONFIGURED') {
    return 'Email is not set up. On Railway, add BREVO_API_KEY (or RESEND_API_KEY) and MAIL_FROM to the service\'s Variables and redeploy. SMTP settings work on hosts that allow outgoing email.';
  }
  if (provider) {
    const name = API_PROVIDERS[provider] ? API_PROVIDERS[provider].label : 'The email service';
    const keyName = provider === 'resend' ? 'RESEND_API_KEY' : 'BREVO_API_KEY';
    if (status === 401) return `${name} refused the API key. Copy a fresh key from your ${name} account into ${keyName} and redeploy.`;
    if (/sender|from address|domain is not verified|verify a domain|not verified/i.test(message)) {
      return provider === 'resend'
        ? 'Resend only sends from an address on a domain you have verified in Resend (Domains). Until then it only delivers to your own Resend login address. Verify your domain, then use an address on it in MAIL_FROM.'
        : 'Brevo only sends from an address you have verified. In Brevo, open Senders, Domains & Dedicated IPs → Senders, add the address in MAIL_FROM, and click the link Brevo emails you.';
    }
    if (status === 403) return `${name} refused to send. The account may still need activating, or this kind of email may need enabling. Check your ${name} dashboard for a notice.`;
    if (status === 429) return `${name}'s sending limit was reached. Wait, or check the plan's daily limit.`;
    if (status === 400 || status === 422) return `${name} rejected the message. Check MAIL_FROM is a full address, for example Game Management System <you@example.com>.`;
  }
  if (code === 'EAUTH' || responseCode === 535 || /invalid login|authentication/i.test(message)) {
    return 'The mail server refused the username or password. With Gmail, use an App Password (Google account → Security → 2-Step Verification → App passwords), not your normal password. Check SMTP_USER and SMTP_PASS.';
  }
  // Nodemailer often reports these as ESOCKET, so the message is checked as well as the code.
  if (['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED'].includes(code) || /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return provider
      ? 'The server could not reach the email service. Try again in a minute; if it keeps failing, check the service\'s status page.'
      : 'The server could not reach the mail server. The host or port may be wrong, but most often the host blocks outgoing email (SMTP), as Railway does on some plans. Send through an email service over HTTPS instead: set BREVO_API_KEY (or RESEND_API_KEY) and MAIL_FROM, and redeploy.';
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

// Sends through an email service's HTTPS API. Returns { ok } or the failure.
async function sendViaApi(provider, apiKey, sender, { to, subject, text, attachments }, fetchImpl) {
  const { url, headers, body } = API_PROVIDERS[provider].request({ apiKey, sender, to, subject, text, attachments });
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (response.ok) return { ok: true };
    let detail = '';
    try {
      const data = await response.json();
      detail = data.message || data.error || JSON.stringify(data);
    } catch {
      detail = response.statusText;
    }
    return { ok: false, provider, status: response.status, code: `HTTP_${response.status}`, error: `${response.status} ${detail}`.trim() };
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    return { ok: false, provider, code: timedOut ? 'ETIMEDOUT' : error.code || (error.cause && error.cause.code) || 'ECONNECTION', error: timedOut ? 'Connection timeout' : error.message };
  }
}

// send() never rejects: a mail problem must not break the page the user is on.
// test() is for the admin's email check, so it reports what went wrong instead.
// An API key (Brevo or Resend) wins over SMTP settings when both are set.
// senderName(), when given, returns the name to send as (the Settings page),
// in place of the name in MAIL_FROM; the address always stays MAIL_FROM's.
function createMailer({
  host, port, user, pass, from, brevoApiKey, resendApiKey, production = false, logger = console, fetchImpl = globalThis.fetch, senderName = () => '',
} = {}) {
  const sender = from || 'Game Management System <no-reply@localhost>';
  const currentSender = () => {
    const parsed = parseSender(sender);
    const name = senderName();
    return name ? { ...parsed, name } : parsed;
  };
  // Nodemailer's form of the sender.
  const smtpFrom = () => {
    const { name, email } = currentSender();
    return name ? { name, address: email } : email;
  };

  const apiProvider = (brevoApiKey && 'brevo') || (resendApiKey && 'resend') || null;
  if (apiProvider) {
    const apiKey = apiProvider === 'brevo' ? brevoApiKey : resendApiKey;
    return {
      configured: true,
      details: () => ({
        configured: true, provider: API_PROVIDERS[apiProvider].label, host: API_PROVIDERS[apiProvider].host, port: 443, secure: true, user: '', from: sender,
      }),
      test: (message) => sendViaApi(apiProvider, apiKey, currentSender(), message, fetchImpl),
      async send(message) {
        const result = await sendViaApi(apiProvider, apiKey, currentSender(), message, fetchImpl);
        if (!result.ok) logger.error(`Email failed: "${message.subject}" to ${message.to}: ${result.error}`);
      },
    };
  }

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
        await transport.sendMail({ from: smtpFrom(), to, subject, text });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message, code: error.code, responseCode: error.responseCode };
      }
    },
    async send({ to, subject, text, attachments }) {
      try {
        await transport.sendMail({ from: smtpFrom(), to, subject, text, attachments });
      } catch (error) {
        logger.error(`Email failed: "${subject}" to ${to}: ${error.message}`);
      }
    },
  };
}

module.exports = { createMailer, explainMailError, maskUser, parseSender };
