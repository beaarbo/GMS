require('dotenv').config();

const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createMailer } = require('./src/mailer');
const { ensureAdmin } = require('./src/services');
const { sendDeadlineReminders } = require('./src/notifications');

const PLACEHOLDER = /^replace-with/;
const REMINDER_CHECK_MS = 3600000;

function required(name) {
  const value = process.env[name];
  if (!value || PLACEHOLDER.test(value)) {
    console.error(`Missing environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const production = process.env.NODE_ENV === 'production';
  const sessionSecret = production ? required('SESSION_SECRET') : process.env.SESSION_SECRET || 'local-development-only';
  if (production && sessionSecret.length < 32) {
    console.error('SESSION_SECRET must be at least 32 characters.');
    process.exit(1);
  }

  const port = Number(process.env.PORT) || 3000;
  const publicUrl = production ? required('PUBLIC_URL') : process.env.PUBLIC_URL || `http://localhost:${port}`;

  const db = openDb(process.env.DATABASE_PATH || './data/gms.sqlite');

  const adminExists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!adminExists) {
    const email = required('ADMIN_EMAIL').toLowerCase();
    const password = required('ADMIN_PASSWORD');
    if (password.length < 10) {
      console.error('ADMIN_PASSWORD must be at least 10 characters.');
      process.exit(1);
    }
    await ensureAdmin(db, email, password);
    console.log(`Created admin account ${email}.`);
  }

  const mailer = createMailer({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM,
    production,
  });
  if (!mailer.configured) {
    console.warn('SMTP_HOST is not set, so no emails will be sent. Password reset will not work without it.');
  }

  const checkReminders = () => {
    sendDeadlineReminders({ db, mailer, publicUrl }).catch((error) => console.error('Deadline reminders failed:', error.message));
  };
  checkReminders();
  setInterval(checkReminders, REMINDER_CHECK_MS).unref();

  createApp({ db, sessionSecret, production, mailer, publicUrl }).listen(port, () => {
    console.log(`Game Management System running on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
