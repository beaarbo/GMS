// An official's start page: competitions past registration, with their
// weigh-in, results and court screens.
const express = require('express');
const { today, weighInCounts, hasBoutList, courtList, getEventDates } = require('../services');
const { requireRole, homeFor } = require('./helpers');

const router = express.Router();

router.get('/', requireRole(['admin', 'official']), (req, res) => {
  if (req.user.role !== 'official') return res.redirect(homeFor(req.user));
  const { db } = req.app.locals;
  // Closed competitions that haven't finished more than a week ago, soonest first.
  const weekAgo = new Date(`${today()}T00:00:00Z`);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const competitions = db
    .prepare(
      `SELECT c.* FROM competitions c
       WHERE c.status = 'closed'
         AND (SELECT MAX(d.event_date) FROM competition_dates d WHERE d.competition_id = c.id) >= ?
       ORDER BY c.event_date, c.id`
    )
    .all(weekAgo.toISOString().slice(0, 10))
    .map((c) => {
      const bouts = db.prepare('SELECT COUNT(*) AS total, SUM(winner_registration_id IS NOT NULL OR no_contest = 1) AS done FROM bouts WHERE competition_id = ? AND is_bye = 0').get(c.id);
      // Every court of every day, so an official taps straight to their mat; today's marked.
      const dates = getEventDates(db, c.id);
      const days = courtList(db, c).map((d) => ({ ...d, isToday: dates[d.day - 1] === today() }));
      return { ...c, weighIn: weighInCounts(db, c.id), hasBouts: hasBoutList(db, c.id), bouts: { total: bouts.total, done: bouts.done || 0 }, days };
    });
  res.render('official/home', { title: 'Competition day', competitions });
});

module.exports = router;
