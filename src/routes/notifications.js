// Coaches' and admins' in-app notices: the newest first. Opening the page marks them read.
const express = require('express');
const { requireRole } = require('./helpers');
const { formatActivityTime } = require('../activity');
const { signalUsers, onUserNotice, eventStream } = require('../live');

const router = express.Router();
const staffAndCoaches = requireRole(['admin', 'coach']);

const unreadCount = (db, userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;

router.get('/', staffAndCoaches, (req, res) => {
  const { db } = req.app.locals;
  const notices = db
    .prepare('SELECT id, at, text, link, read_at IS NULL AS unread FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id);
  const marked = db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  // Their other open tabs drop the badge too.
  if (marked.changes > 0) signalUsers(db, [req.user.id]);
  req.user.unread = 0;
  res.render('notifications', { title: 'Notifications', notices, formatActivityTime });
});

// A server-sent event stream of the user's unread count: one "unread" event when
// it opens (so a reconnect catches up) and another whenever it changes, so the
// nav badge updates without a reload.
router.get('/events', staffAndCoaches, (req, res) => {
  const { db } = req.app.locals;
  const userId = req.user.id;
  const send = () => res.write(`event: unread\ndata: ${unreadCount(db, userId)}\n\n`);
  eventStream(req, res, (onChange) => onUserNotice(db, userId, onChange), send);
  send();
});

module.exports = router;
