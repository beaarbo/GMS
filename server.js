require('dotenv').config();

const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createMailer } = require('./src/mailer');
const { ensureAdmin } = require('./src/services');
const { sendDeadlineReminders } = require('./src/notifications');
const { defaultBackupDir, runDailyBackup, restoreBackup, DEFAULT_KEEP } = require('./src/backups');

const PLACEHOLDER = /^replace-with/;
const REMINDER_CHECK_MS = 3600000;
const BACKUP_CHECK_MS = 3600000;

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

  const databasePath = process.env.DATABASE_PATH || './data/gms.sqlite';

  // A snapshot each day beside the database, keeping the newest BACKUP_KEEP_DAYS.
  const keepDays = Number(process.env.BACKUP_KEEP_DAYS);
  const backups = {
    dir: process.env.BACKUP_DIR || defaultBackupDir(databasePath),
    keep: { ...DEFAULT_KEEP, daily: Number.isInteger(keepDays) && keepDays > 0 ? keepDays : DEFAULT_KEEP.daily },
  };

  // RESTORE_BACKUP=<backup file name> swaps that backup in before the database opens.
  if (process.env.RESTORE_BACKUP) {
    const result = await restoreBackup(databasePath, backups.dir, process.env.RESTORE_BACKUP.trim());
    if (result.restored) {
      console.log(`Restored ${process.env.RESTORE_BACKUP}. The database from before is saved as ${result.safety || '(there was none)'}. Remove RESTORE_BACKUP now.`);
    } else {
      console.warn(`RESTORE_BACKUP ignored: ${result.reason}`);
    }
  }

  const db = openDb(databasePath);
  const checkBackups = () => {
    runDailyBackup(db, backups.dir, { keep: backups.keep })
      .then((made) => made && console.log(`Daily backup saved: ${made.name}`))
      .catch((error) => console.error('Daily backup failed:', error.message));
  };
  checkBackups();
  setInterval(checkBackups, BACKUP_CHECK_MS).unref();

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

  createApp({ db, sessionSecret, production, mailer, publicUrl, backups }).listen(port, () => {
    console.log(`Game Management System running on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
