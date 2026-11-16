// Coaches' and admins' in-app notices: the newest first. Opening the page marks them read.
const express = require('express');
const { requireRole } = require('./helpers');
const { formatActivityTime } = require('../activity');

const router = express.Router();

router.get('/', requireRole(['admin', 'coach']), (req, res) => {
  const { db } = req.app.locals;
  const notices = db
    .prepare('SELECT id, at, text, link, read_at IS NULL AS unread FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id);
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  req.user.unread = 0;
  res.render('notifications', { title: 'Notifications', notices, formatActivityTime });
});

// The unread count, for public/app.js to keep the nav's badge current without a reload.
router.get('/count', requireRole(['admin', 'coach']), (req, res) => res.json({ unread: req.user.unread }));

module.exports = router;
