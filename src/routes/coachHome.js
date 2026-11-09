// The coach's main page: upcoming competitions first, then news.
const express = require('express');
const { today, isRegistrationOpen, listNews } = require('../services');
const { homeFor } = require('./helpers');

const router = express.Router();

router.get('/', (req, res) => {
  if (!req.user) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
  }
  if (req.user.role !== 'coach') return res.redirect(homeFor(req.user));

  const { db } = req.app.locals;
  const clubId = req.user.club_id;
  // Upcoming means the competition's last day hasn't passed. Drafts stay hidden.
  const competitions = db
    .prepare(
      `SELECT c.* FROM competitions c
       WHERE c.status IN ('open', 'closed')
         AND (SELECT MAX(d.event_date) FROM competition_dates d WHERE d.competition_id = c.id) >= ?
       ORDER BY c.event_date, c.id`
    )
    .all(today());

  const entries = new Map();
  if (clubId) {
    db.prepare('SELECT competition_id, status, COUNT(*) AS n FROM registrations WHERE club_id = ? GROUP BY competition_id, status')
      .all(clubId)
      .forEach((row) => {
        const counts = entries.get(row.competition_id) || { pending: 0, approved: 0, rejected: 0 };
        counts[row.status] = row.n;
        entries.set(row.competition_id, counts);
      });
  }

  return res.render('coach/home', {
    title: 'Home',
    competitions: competitions.map((c) => ({
      ...c,
      open: isRegistrationOpen(c),
      entries: entries.get(c.id) || { pending: 0, approved: 0, rejected: 0 },
    })),
    news: listNews(db, { signedIn: true, limit: 10 }),
  });
});

module.exports = router;
