const express = require('express');
const { loadDivisionSetup } = require('../services');
const { notFound } = require('./helpers');

const router = express.Router();

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  const competitions = db
    .prepare("SELECT * FROM competitions WHERE status IN ('open', 'closed') ORDER BY status = 'closed', event_date")
    .all();
  res.render('home', { title: 'Competitions', competitions });
});

// Public pages show the rules only. Fighter data (minors included) stays private.
router.get('/competitions/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!competition) return notFound(res);
  if (competition.status === 'draft' && !(req.user && req.user.role === 'admin')) return notFound(res);
  return res.render('competition', {
    title: competition.name,
    competition,
    setup: loadDivisionSetup(db, competition.id),
  });
});

module.exports = router;
