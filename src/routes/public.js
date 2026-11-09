const express = require('express');
const { loadDivisionSetup, listNews, getNews } = require('../services');
const { notFound } = require('./helpers');

const router = express.Router();

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  const competitions = db
    .prepare("SELECT * FROM competitions WHERE status IN ('open', 'closed') ORDER BY status = 'closed', event_date")
    .all();
  res.render('home', { title: 'Competitions', competitions, news: listNews(db, { signedIn: Boolean(req.user), limit: 3 }) });
});

// Members-only posts look like they don't exist to visitors.
router.get('/news', (req, res) => {
  res.render('news', { title: 'News', posts: listNews(req.app.locals.db, { signedIn: Boolean(req.user), limit: 100 }) });
});

router.get('/news/:id(\\d+)', (req, res) => {
  const post = getNews(req.app.locals.db, req.params.id, { signedIn: Boolean(req.user) });
  if (!post) return notFound(res);
  return res.render('news_post', { title: post.title, post });
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
