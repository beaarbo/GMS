// Coaches' and admins' in-app notices: the newest first. Opening the page marks them read.
const express = require('express');
const { requireRole } = require('./helpers');
const { formatActivityTime } = require('../activity');
const { signalUsers, onUserNotice } = require('../noticeSignals');

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
  if (marked.changes > 0) signalUsers([req.user.id]);
  req.user.unread = 0;
  res.render('notifications', { title: 'Notifications', notices, formatActivityTime });
});

// The unread count, for pages without a live stream to check now and then.
router.get('/count', staffAndCoaches, (req, res) => res.json({ unread: req.user.unread }));

const HEARTBEAT_MS = 25000;
const COALESCE_MS = 300;

// A server-sent event stream of the user's unread count: one "unread" event when
// it opens and another whenever it changes, so the nav badge updates without a
// reload. Comments keep the connection open through proxies, and the browser
// reconnects on its own.
router.get('/events', staffAndCoaches, (req, res) => {
  const { db } = req.app.locals;
  const userId = req.user.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = () => res.write(`event: unread\ndata: ${unreadCount(db, userId)}\n\n`);
  res.write('retry: 5000\n\n');
  send();

  // A burst of notices (one per club in a review) becomes one update.
  let pending = null;
  const unsubscribe = onUserNotice(userId, () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      send();
    }, COALESCE_MS);
  });
  const heartbeat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(pending);
    unsubscribe();
  });
});

module.exports = router;
