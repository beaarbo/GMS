const nodemailer = require('nodemailer');

// send() never rejects: a mail problem must not break the page the user is on.
function createMailer({ host, port, user, pass, from, production = false, logger = console } = {}) {
  const sender = from || 'Game Management System <no-reply@localhost>';

  if (!host) {
    return {
      configured: false,
      async send({ to, subject, text }) {
        // Messages can hold password reset links, so bodies are only shown in development.
        if (production) logger.warn(`Email not sent (SMTP_HOST is not set): "${subject}" to ${to}`);
        else logger.log(`\n--- Email (not sent, SMTP_HOST is not set) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---\n`);
      },
    };
  }

  const smtpPort = Number(port) || 587;
  const transport = nodemailer.createTransport({
    host,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: user ? { user, pass } : undefined,
  });

  return {
    configured: true,
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from: sender, to, subject, text });
      } catch (error) {
        logger.error(`Email failed: "${subject}" to ${to}: ${error.message}`);
      }
    },
  };
}

module.exports = { createMailer };
