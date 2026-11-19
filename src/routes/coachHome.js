// The coach's main page: their competitions (coming up, and finished in the last
// 30 days, each with the one thing to do next), their athletes, then news.
const express = require('express');
const { today, isRegistrationOpen, listNews, listCompetitionPhotos, competitionResults } = require('../services');
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
  // Coming up (the last day hasn't passed) and finished in the last 30 days, so results
  // stay a tap away after the event. Drafts stay hidden.
  const monthAgo = new Date(`${today()}T00:00:00Z`);
  monthAgo.setUTCDate(monthAgo.getUTCDate() - 30);
  const competitions = db
    .prepare(
      `SELECT c.*, (SELECT MAX(d.event_date) FROM competition_dates d WHERE d.competition_id = c.id) AS last_day
       FROM competitions c
       WHERE c.status IN ('open', 'closed') AND last_day >= ?
       ORDER BY last_day < ?, c.event_date, c.id`
    )
    .all(monthAgo.toISOString().slice(0, 10), today());

  const entries = new Map();
  if (clubId) {
    // Kyorugi registrations and poomsae entries count together.
    db.prepare(
      `SELECT competition_id, status, COUNT(*) AS n FROM registrations WHERE club_id = ? GROUP BY competition_id, status
       UNION ALL
       SELECT competition_id, status, COUNT(*) AS n FROM poomsae_entries WHERE club_id = ? GROUP BY competition_id, status`
    )
      .all(clubId, clubId)
      .forEach((row) => {
        const counts = entries.get(row.competition_id) || { pending: 0, approved: 0, rejected: 0 };
        counts[row.status] += row.n;
        entries.set(row.competition_id, counts);
      });
  }

  // The club's athletes, and how many still need a document before they can be entered.
  const athletes = clubId
    ? db.prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(NOT EXISTS (SELECT 1 FROM fighter_documents d WHERE d.fighter_id = f.id)), 0) AS missing
       FROM fighters f WHERE f.club_id = ?`
    ).get(clubId)
    : null;

  return res.render('coach/home', {
    title: 'Home',
    competitions: competitions.map((c) => {
      const finished = c.last_day < today();
      return {
        ...c,
        open: isRegistrationOpen(c),
        finished,
        hasResults: finished && competitionResults(db, c, { published: true }).divisions.length > 0,
        entries: entries.get(c.id) || { pending: 0, approved: 0, rejected: 0 },
        photos: finished ? [] : listCompetitionPhotos(db, c.id),
      };
    }),
    athletes,
    needDocument: req.site.requireDocument,
    news: listNews(db, { signedIn: true, limit: 10 }),
  });
});

module.exports = router;
