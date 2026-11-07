// A coach's account home, where they apply to join a club and follow the outcome.
const express = require('express');
const { applyToClub } = require('../services');
const { notifyAdminsOfApplication } = require('../notifications');
const { requireRole } = require('./helpers');

const router = express.Router();
router.use(requireRole('coach'));

router.get('/', (req, res) => {
  if (req.user.club_id) return res.redirect('/club');
  const { db } = req.app.locals;
  return res.render('coach/status', {
    title: 'Join a club',
    clubs: db.prepare('SELECT id, name, city FROM clubs ORDER BY name').all(),
    application: db
      .prepare(
        `SELECT a.*, c.name AS club_name FROM club_applications a JOIN clubs c ON c.id = a.club_id
         WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 1`
      )
      .get(req.user.id),
  });
});

router.post('/apply', (req, res) => {
  const clubId = Number(req.body.club_id);
  const result = applyToClub(req.app.locals.db, req.user.id, clubId);
  if (result.ok) {
    req.flash('success', 'Application sent. An admin will review it.');
    const club = req.app.locals.db.prepare('SELECT name FROM clubs WHERE id = ?').get(clubId);
    req.logActivity('coach.applied', `Applied to join ${club.name}`);
    notifyAdminsOfApplication(req.app.locals.notify, req.user.id, clubId);
  } else {
    req.flash('error', result.error);
  }
  return res.redirect('/coach');
});

router.post('/withdraw', (req, res) => {
  const { changes } = req.app.locals.db
    .prepare("DELETE FROM club_applications WHERE user_id = ? AND status = 'pending'")
    .run(req.user.id);
  if (changes > 0) {
    req.logActivity('coach.withdrew', 'Withdrew their club application');
    req.flash('success', 'Application withdrawn.');
  }
  return res.redirect('/coach');
});

module.exports = router;
