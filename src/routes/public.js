const express = require('express');
const {
  loadDivisionSetup, listNews, getNews, today, listCompetitionPhotos, getCompetitionPhoto, getCompetitionLogo, listCompetitionFiles, getCompetitionFile,
  getEventDates, competitionResults, competitionProgramme,
} = require('../services');
const { formatEventDates } = require('../divisions');
const { hasKyorugi, hasPoomsae } = require('../poomsae');
const { writeBoutListPdf } = require('../boutlistPdf');
const { shortenNames } = require('../settings');

// Visitors without an account see shortened names when the Settings page says so.
const forVisitor = (req, data) => (!req.user && req.site.publicNames === 'initials' ? shortenNames(data) : data);
const { sendAttachment } = require('../documents');
const { notFound } = require('./helpers');

const router = express.Router();
const HOME_NEWS = 5;

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  // Upcoming until the competition's last day has passed, as on the coach Home page.
  const lastDay = '(SELECT MAX(d.event_date) FROM competition_dates d WHERE d.competition_id = c.id)';
  const competitions = db
    .prepare(`SELECT c.* FROM competitions c WHERE c.status IN ('open', 'closed') AND ${lastDay} >= ? ORDER BY c.status = 'closed', c.event_date`)
    .all(today())
    .map((c) => ({ ...c, photos: listCompetitionPhotos(db, c.id) }));
  // Finished ones, newest first, each with a link to its results once any are published.
  const past = db
    .prepare(`SELECT c.* FROM competitions c WHERE c.status IN ('open', 'closed') AND ${lastDay} < ? ORDER BY ${lastDay} DESC, c.id DESC`)
    .all(today())
    .map((c) => ({ ...c, hasResults: competitionResults(db, c, { published: true }).divisions.length > 0 }));
  // The latest news below the competitions; the News page keeps the rest.
  const news = listNews(db, { signedIn: Boolean(req.user), limit: HOME_NEWS + 1 });
  res.render('home', { title: 'Competitions', competitions, past, news: news.slice(0, HOME_NEWS), moreNews: news.length > HOME_NEWS });
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
    photos: listCompetitionPhotos(db, competition.id),
    hasBoutList: competitionProgramme(db, competition, { published: true }).length > 0,
    hasResults: competitionResults(db, competition, { published: true }).divisions.length > 0,
  });
});

const dateLabel = (db, competition) => formatEventDates(getEventDates(db, competition.id));

function pdfHeaders(res, name, competition) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-competition-${competition.id}.pdf"`);
}

// The bout list and results share their filters: one event (?event=kyorugi or
// poomsae), and for a coach, only their club's divisions (?club=mine).
function programmeFilters(req, competition) {
  const event = ['kyorugi', 'poomsae'].includes(req.query.event) && hasKyorugi(competition) && hasPoomsae(competition) ? req.query.event : null;
  const clubId = req.query.club === 'mine' && req.user && req.user.club_id ? req.user.club_id : null;
  return { event, clubId };
}

function programmeLocals(req, competition, filters, page) {
  return {
    competition,
    filters,
    page,
    bothEvents: hasKyorugi(competition) && hasPoomsae(competition),
    ownClubId: (req.user && req.user.club_id) || null,
    highlightClubId: (req.user && req.user.club_id) || null,
  };
}

// Final results: each division's medallists and one club medal table for both
// events. Visitors and coaches see only published events; admins and officials see all.
router.get('/competitions/:id(\\d+)/results', (req, res) => {
  const competition = visibleCompetition(req);
  if (!competition) return notFound(res);
  const { db } = req.app.locals;
  const staff = Boolean(req.user && ['admin', 'official'].includes(req.user.role));
  const filters = programmeFilters(req, competition);
  if (!staff && competitionResults(db, competition, { published: true }).divisions.length === 0) return notFound(res);
  const results = forVisitor(req, competitionResults(db, competition, { published: !staff, event: filters.event }));
  const mine = (d) => ['gold', 'silver', 'bronze'].some((medal) => d[medal].some((m) => m.clubId === filters.clubId));
  return res.render('results_public', {
    title: `${competition.name}: results`,
    ...programmeLocals(req, competition, filters, 'results'),
    table: results.table,
    divisions: filters.clubId ? results.divisions.filter(mine) : results.divisions,
    staff,
  });
});

// The bout list: kyorugi divisions and poomsae lists and brackets together, in
// running order, once each is published. Anyone can see it; a coach's club is highlighted.
router.get('/competitions/:id(\\d+)/bouts', (req, res) => {
  const competition = visibleCompetition(req);
  if (!competition) return notFound(res);
  const { db } = req.app.locals;
  if (competitionProgramme(db, competition, { published: true }).length === 0) return notFound(res);
  const filters = programmeFilters(req, competition);
  return res.render('programme', {
    title: `${competition.name}: bout list`,
    ...programmeLocals(req, competition, filters, 'bouts'),
    parts: forVisitor(req, competitionProgramme(db, competition, { published: true, ...filters })),
  });
});

router.get('/competitions/:id(\\d+)/bouts.pdf', (req, res) => {
  const competition = visibleCompetition(req);
  if (!competition) return notFound(res);
  const { db } = req.app.locals;
  const parts = forVisitor(req, competitionProgramme(db, competition, { published: true, ...programmeFilters(req, competition) }));
  if (parts.length === 0) return notFound(res);
  pdfHeaders(res, 'bout-list', competition);
  return writeBoutListPdf(res, { competition, divisions: parts, dateLabel: dateLabel(db, competition) });
});

// The old poomsae addresses, kept for links already shared.
router.get('/competitions/:id(\\d+)/poomsae', (req, res) => res.redirect(301, `/competitions/${req.params.id}/bouts?event=poomsae`));
router.get('/competitions/:id(\\d+)/poomsae.pdf', (req, res) => res.redirect(301, `/competitions/${req.params.id}/bouts.pdf?event=poomsae`));

router.get('/competitions/:id(\\d+)/logo', (req, res) => {
  const competition = visibleCompetition(req);
  const logo = competition && getCompetitionLogo(req.app.locals.db, competition.id);
  if (!logo) return notFound(res);
  res.setHeader('Content-Type', logo.content_type);
  res.setHeader('Cache-Control', `${competition.status === 'draft' ? 'private' : 'public'}, max-age=31536000, immutable`);
  return res.send(logo.data);
});

// A competition's photo, shown like its logo: only while the competition is visible.
router.get('/competitions/:id(\\d+)/photos/:photoId(\\d+)', (req, res) => {
  const competition = visibleCompetition(req);
  const photo = competition && getCompetitionPhoto(req.app.locals.db, competition.id, Number(req.params.photoId));
  if (!photo) return notFound(res);
  res.setHeader('Content-Type', photo.content_type);
  res.setHeader('Cache-Control', `${competition.status === 'draft' ? 'private' : 'public'}, max-age=31536000, immutable`);
  return res.send(photo.data);
});

router.get('/competitions/:id(\\d+)/files/:fileId(\\d+)', (req, res) => {
  const competition = visibleCompetition(req);
  const file = competition && getCompetitionFile(req.app.locals.db, competition.id, req.params.fileId);
  if (!file) return notFound(res);
  return sendAttachment(res, file);
});

module.exports = router;
