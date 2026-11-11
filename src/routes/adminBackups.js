// Admins make, list and download database backups.
const express = require('express');
const { listBackups, backupPath, createBackup, pruneBackups } = require('../backups');
const { backupKeep } = require('../settings');
const { requireRole, notFound, wrap } = require('./helpers');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const { db, backups: { dir, keep: startKeep } } = req.app.locals;
  const keep = backupKeep(db, startKeep);
  const backups = listBackups(dir);
  res.render('admin/backups', {
    title: 'Backups',
    configured: Boolean(dir),
    backups,
    totalSize: backups.reduce((sum, b) => sum + b.size, 0),
    keep,
  });
});

router.post('/', wrap(async (req, res) => {
  const { db, backups: { dir, keep: startKeep } } = req.app.locals;
  const keep = backupKeep(db, startKeep);
  if (!dir) {
    req.flash('error', 'Backups are not set up on this server.');
    return res.redirect('/admin/backups');
  }
  try {
    const backup = await createBackup(db, dir, { kind: 'manual' });
    pruneBackups(dir, keep);
    req.logActivity('backup.created', `Made a backup of the database (${backup.name})`);
    req.flash('success', `Backup made: ${backup.name}. Download it to keep a copy off the server.`);
  } catch (error) {
    console.error('Backup failed:', error);
    req.flash('error', `The backup failed: ${error.message}`);
  }
  return res.redirect('/admin/backups');
}));

// A backup holds everyone's personal data and password hashes, so each download is logged.
router.get('/:name', (req, res) => {
  const file = backupPath(req.app.locals.backups.dir, req.params.name);
  if (!file) return notFound(res);
  req.logActivity('backup.downloaded', `Downloaded the backup ${req.params.name}`);
  res.setHeader('Cache-Control', 'no-store');
  return res.download(file, req.params.name);
});

module.exports = router;
