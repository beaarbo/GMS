const express = require('express');
const { loadDivisionSetup, listNews, getNews, getCompetitionLogo, listCompetitionFiles, getCompetitionFile } = require('../services');
const { sendAttachment } = require('../documents');
const { notFound } = require('./helpers');

const router = express.Router();

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  const competitions = db
    .prepare("SELECT * FROM competitions WHERE status IN ('open', 'closed') ORDER BY status = 'closed', event_date")
    .all();
  res.render('home', { title: 'Competitions', competitions });
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

// Drafts are only visible to admins, along with their logo and files.
function visibleCompetition(req) {
  const competition = req.app.locals.db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!competition) return null;
  if (competition.status === 'draft' && !(req.user && req.user.role === 'admin')) return null;
  return competition;
}

// Public pages show the rules only. Fighter data (minors included) stays private.
router.get('/competitions/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const competition = visibleCompetition(req);
  if (!competition) return notFound(res);
  return res.render('competition', {
    title: competition.name,
    competition,
    setup: loadDivisionSetup(db, competition.id),
    files: listCompetitionFiles(db, competition.id),
  });
});

// The link carries the upload time, so a new logo gets a new address.
router.get('/competitions/:id(\\d+)/logo', (req, res) => {
  const competition = visibleCompetition(req);
  const logo = competition && getCompetitionLogo(req.app.locals.db, competition.id);
  if (!logo) return notFound(res);
  res.setHeader('Content-Type', logo.content_type);
  res.setHeader('Cache-Control', `${competition.status === 'draft' ? 'private' : 'public'}, max-age=31536000, immutable`);
  return res.send(logo.data);
});

router.get('/competitions/:id(\\d+)/files/:fileId(\\d+)', (req, res) => {
  const competition = visibleCompetition(req);
  const file = competition && getCompetitionFile(req.app.locals.db, competition.id, req.params.fileId);
  if (!file) return notFound(res);
  return sendAttachment(res, file);
});

module.exports = router;
