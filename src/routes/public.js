const express = require('express');
const {
  loadDivisionSetup, listNews, getNews, getCompetitionLogo, listCompetitionFiles, getCompetitionFile,
  loadBoutList, poomsaeBoutList, getEventDates,
} = require('../services');
const { formatEventDates } = require('../divisions');
const { hasPoomsae } = require('../poomsae');
const { layoutBracket, computeMedals } = require('../bracket');
const { writeBoutListPdf } = require('../boutlistPdf');
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

// Public pages show the rules and, once the organiser publishes them, the bout
// lists: athlete names and clubs only. Ages, birth dates, documents and contact
// details stay private, because many athletes are minors.
router.get('/competitions/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const competition = visibleCompetition(req);
  if (!competition) return notFound(res);
  return res.render('competition', {
    title: competition.name,
    competition,
    setup: loadDivisionSetup(db, competition.id),
    files: listCompetitionFiles(db, competition.id),
    poomsaePublished: hasPoomsae(competition) && poomsaeBoutList(db, competition, { published: true }).length > 0,
  });
});

const dateLabel = (db, competition) => formatEventDates(getEventDates(db, competition.id));

function pdfHeaders(res, name, competition) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-competition-${competition.id}.pdf"`);
}

// The published kyorugi bout list, for anyone. A coach's own club is highlighted.
function publishedKyorugi(req) {
  const competition = visibleCompetition(req);
  return competition && competition.bouts_published_at ? competition : null;
}

router.get('/competitions/:id(\\d+)/bouts', (req, res) => {
  const competition = publishedKyorugi(req);
  if (!competition) return notFound(res);
  const divisions = loadBoutList(req.app.locals.db, competition.id);
  return res.render('bouts_public', {
    title: `${competition.name}: bout list`,
    competition,
    divisions: divisions.map((division) => ({ ...division, layout: layoutBracket(division.bouts, { slotHeight: 30, top: 4 }) })),
    medals: computeMedals(divisions),
    highlightClubId: (req.user && req.user.club_id) || null,
  });
});

router.get('/competitions/:id(\\d+)/bouts.pdf', (req, res) => {
  const competition = publishedKyorugi(req);
  if (!competition) return notFound(res);
  const { db } = req.app.locals;
  pdfHeaders(res, 'bout-list', competition);
  return writeBoutListPdf(res, { competition, divisions: loadBoutList(db, competition.id), dateLabel: dateLabel(db, competition) });
});

// The published poomsae stages (performance order, brackets), for anyone.
function publishedPoomsae(req) {
  const competition = visibleCompetition(req);
  if (!competition || !hasPoomsae(competition)) return null;
  const pages = poomsaeBoutList(req.app.locals.db, competition, { published: true });
  return pages.length > 0 ? { competition, pages } : null;
}

router.get('/competitions/:id(\\d+)/poomsae', (req, res) => {
  const found = publishedPoomsae(req);
  if (!found) return notFound(res);
  return res.render('poomsae_public', {
    title: `${found.competition.name}: poomsae`,
    competition: found.competition,
    pages: found.pages,
    highlightClubId: (req.user && req.user.club_id) || null,
  });
});

router.get('/competitions/:id(\\d+)/poomsae.pdf', (req, res) => {
  const found = publishedPoomsae(req);
  if (!found) return notFound(res);
  pdfHeaders(res, 'poomsae-list', found.competition);
  return writeBoutListPdf(res, { competition: found.competition, divisions: found.pages, dateLabel: dateLabel(req.app.locals.db, found.competition) });
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
