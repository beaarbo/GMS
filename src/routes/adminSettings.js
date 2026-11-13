// The admin Settings page: the organisation, email, backups, registration
// rules, privacy, and the defaults new competitions start from.
const express = require('express');
const { loadSettings, saveSettings, readSiteSettings, readCompetitionDefaults, applyTimeZone, DOCUMENT_TYPES, PUBLIC_NAMES } = require('../settings');
const { detectIconType } = require('../documents');
const { listBackups } = require('../backups');
const { emailBackup, MAX_EMAILED_BACKUP_BYTES } = require('../notifications');
const { cleanUpDocuments } = require('../services');
const { requireRole, readSetup, readPoomsaeAges, wrap } = require('./helpers');

const router = express.Router();
router.use(requireRole('admin'));

function settingsPage(req, res, { status = 200, values, errors = [] } = {}) {
  const { db, backups } = req.app.locals;
  return res.status(status).render('admin/settings', {
    title: 'Settings',
    values: values || req.site.raw,
    errors,
    DOCUMENT_TYPES,
    PUBLIC_NAMES,
    timeZones: Intl.supportedValuesOf('timeZone'),
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    backupsConfigured: Boolean(backups && backups.dir),
    mailConfigured: req.app.locals.notify.mailer.configured,
    maxEmailedMb: MAX_EMAILED_BACKUP_BYTES / 1024 / 1024,
    hasLogo: Boolean(db.prepare('SELECT 1 FROM site_logo WHERE id = 1').get()),
  });
}

router.get('/', (req, res) => settingsPage(req, res));

router.post('/', (req, res) => {
  const { db } = req.app.locals;
  const { values, errors } = readSiteSettings(req.body);
  // Only the main admin changes these; for anyone else they stay as they are.
  if (!req.user.owner) {
    values.require_2fa_admins = req.site.raw.require_2fa_admins;
    values.offsite_backup_email = req.site.raw.offsite_backup_email;
  }
  if (values.require_2fa_admins === '1' && !req.user.two_step && req.user.owner) {
    errors.push('Set up two-step login on My account first, so requiring it can\'t lock you out.');
  }
  if (errors.length > 0) return settingsPage(req, res, { status: 400, values, errors });
  saveSettings(db, values);
  applyTimeZone(values.time_zone);
  req.logActivity('settings.saved', 'Changed the site settings');
  req.flash('success', 'Settings saved.');
  return res.redirect('/admin/settings');
});

router.post('/logo', (req, res) => {
  const { db } = req.app.locals;
  if (req.uploadError) {
    req.flash('error', req.uploadError);
    return res.redirect('/admin/settings');
  }
  const type = req.file && detectIconType(req.file.buffer);
  if (!type) {
    req.flash('error', req.file ? 'The logo must be a JPG, PNG or WebP picture.' : 'Choose a picture to upload.');
    return res.redirect('/admin/settings');
  }
  db.prepare(
    `INSERT INTO site_logo (id, content_type, data, uploaded_at) VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, uploaded_at = excluded.uploaded_at`
  ).run(type.contentType, req.file.buffer);
  req.logActivity('settings.logo', 'Changed the organiser logo');
  req.flash('success', 'Logo saved. It shows in the top bar of every page.');
  return res.redirect('/admin/settings');
});

router.post('/logo/delete', (req, res) => {
  const { changes } = req.app.locals.db.prepare('DELETE FROM site_logo WHERE id = 1').run();
  if (changes > 0) {
    req.logActivity('settings.logo', 'Removed the organiser logo');
    req.flash('success', 'Logo removed.');
  }
  return res.redirect('/admin/settings');
});

// Sends the newest backup to the off-site address now, to check it arrives.
router.post('/offsite-test', wrap(async (req, res) => {
  const { notify, backups } = req.app.locals;
  const [newest] = listBackups(backups && backups.dir);
  if (!newest) {
    req.flash('error', 'There is no backup to send yet. Make one on the Backups page first.');
    return res.redirect('/admin/settings');
  }
  const result = await emailBackup(notify, backups.dir, newest);
  if (result.sent) {
    req.logActivity('backup.emailed', `Emailed the backup ${newest.name} off-site`);
    req.flash('success', `${newest.name} was sent to ${req.site.offsiteBackupEmail}. Check it arrived.`);
  } else {
    req.flash('error', `Not sent: ${result.reason}`);
  }
  return res.redirect('/admin/settings');
}));

// Deletes old athlete documents now, the same as the daily clean-up.
router.post('/documents/clean-up', (req, res) => {
  const days = req.site.documentRetentionDays;
  if (!days) {
    req.flash('error', 'Set how long to keep documents first.');
    return res.redirect('/admin/settings');
  }
  const removed = cleanUpDocuments(req.app.locals.db, days);
  if (removed > 0) req.logActivity('documents.cleaned', `Deleted ${removed} athlete document${removed === 1 ? '' : 's'} older than ${days} days`);
  req.flash('success', removed > 0 ? `Deleted ${removed} old document${removed === 1 ? '' : 's'}.` : 'No documents were old enough to delete.');
  return res.redirect('/admin/settings');
});

function defaultsPage(req, res, { status = 200, values, ageRows, poomsaeRows, errors = [] } = {}) {
  const site = loadSettings(req.app.locals.db);
  return res.status(status).render('admin/settings_defaults', {
    title: 'Competition defaults',
    values: values || site.raw,
    ageRows: ageRows || site.defaults.kyorugiAgeGroups,
    poomsaeRows: poomsaeRows || site.defaults.poomsaeAgeGroups,
    errors,
  });
}

router.get('/defaults', (req, res) => defaultsPage(req, res));

router.post('/defaults', (req, res) => {
  const { ageGroups: kyorugiAges } = readSetup(req.body);
  const poomsaeAges = readPoomsaeAges(req.body);
  const { values, errors } = readCompetitionDefaults(req.body, { kyorugiAges, poomsaeAges });
  if (errors.length > 0) {
    return defaultsPage(req, res, {
      status: 400,
      values,
      errors,
      ageRows: kyorugiAges.map((g) => ({ ...g, min_age: g.minRaw, max_age: g.maxRaw })),
      poomsaeRows: poomsaeAges.map((g) => ({ ...g, min_age: g.minRaw, max_age: g.maxRaw })),
    });
  }
  saveSettings(req.app.locals.db, values);
  req.logActivity('settings.defaults', 'Changed the defaults for new competitions');
  req.flash('success', 'Defaults saved. New competitions start from them; existing ones keep their own.');
  return res.redirect('/admin/settings/defaults');
});

module.exports = router;
