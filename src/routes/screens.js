// Court screens: a page per court and day for a TV or tablet at the mat, showing
// what's on now, what's next and recent results, for kyorugi courts and poomsae
// courts. Anyone can open them, like the public bout list: visitors and coaches
// see only what has been published (the kyorugi bout list, each poomsae stage),
// with short names when the organiser chose them, and photos are for staff only.
const express = require('express');
const { listBouts, getEventDates, poomsaeCourtItems, poomsaeCourtQueue, listBoutCalls, calledBouts, calledDivision, callTime, callText, courtList } = require('../services');
const { formatDay } = require('../divisions');
const { hasPoomsae } = require('../poomsae');
const { forVisitor } = require('../settings');
const { eventStream } = require('../live');
const { notFound } = require('./helpers');

const router = express.Router();
const REFRESH_SECONDS = 15;

// Visitors (no account) see screens like coaches: published stages only, never photos.
const isStaff = (user) => Boolean(user) && ['admin', 'official'].includes(user.role);
const kyorugiVisible = (user, c) => isStaff(user) || Boolean(c.bouts_published_at);
const poomsaeVisible = (user, c) => hasPoomsae(c) && (isStaff(user) || Boolean(c.poomsae_published_at || c.poomsae_brackets_published_at));

// kind: 'any' for the screens list, or the event a screen belongs to.
function screenCompetition(kind) {
  return (req, res, next) => {
    const competition = req.app.locals.db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
    const allowed = competition && competition.status === 'closed' && (
      kind === 'kyorugi' ? kyorugiVisible(req.user, competition)
        : kind === 'poomsae' ? poomsaeVisible(req.user, competition)
          : kyorugiVisible(req.user, competition) || poomsaeVisible(req.user, competition)
    );
    if (!allowed) return notFound(res);
    req.competition = competition;
    return next();
  };
}

// Photos of the athletes on now, as { url, name } (url null: no photo yet). Staff
// screens only: coaches can open screens too, and must not see other clubs'
// athletes' photos. Kyorugi sides are registrations; poomsae sides are entries,
// with one photo per athlete in a pair or team.
function sidePhotos(db, competitionId, kind, id) {
  if (!id) return null;
  const sql = kind === 'kyorugi'
    ? 'SELECT f.id, f.first_name, f.last_name, p.uploaded_at FROM registrations r JOIN fighters f ON f.id = r.fighter_id LEFT JOIN fighter_photos p ON p.fighter_id = f.id WHERE r.id = ?'
    : 'SELECT f.id, f.first_name, f.last_name, p.uploaded_at FROM poomsae_members m JOIN fighters f ON f.id = m.fighter_id LEFT JOIN fighter_photos p ON p.fighter_id = f.id WHERE m.entry_id = ? ORDER BY f.last_name, f.first_name';
  return db.prepare(sql).all(id).map((f) => ({
    name: `${f.first_name} ${f.last_name}`,
    url: f.uploaded_at ? `/admin/competitions/${competitionId}/athletes/${f.id}/photo?v=${encodeURIComponent(f.uploaded_at)}` : null,
  }));
}

function nowPhotos(req, kind, now) {
  if (!now || !isStaff(req.user)) return null;
  const { db } = req.app.locals;
  if (now.kind === 'perform') return { performer: sidePhotos(db, req.competition.id, 'poomsae', now.id) };
  return {
    blue: sidePhotos(db, req.competition.id, kind, now.blue && now.blue.registrationId),
    red: sidePhotos(db, req.competition.id, kind, now.red && now.red.registrationId),
  };
}

// A call as a screen shows it: its text and time, and the bouts or, for a poomsae
// division, the people it names. Those stay hidden from coaches and visitors
// until that poomsae stage is published.
function callForScreen(req, call) {
  if (!call) return null;
  const { db } = req.app.locals;
  const competition = req.competition;
  const shown = { ...call, at: callTime(call), text: callText(call), bouts: calledBouts(db, competition, call), division: null };
  if (call.division_key) {
    const published = call.stage === 'list' ? competition.poomsae_published_at : competition.poomsae_brackets_published_at;
    if (isStaff(req.user) || published) shown.division = calledDivision(db, competition, call);
  }
  if (!isStaff(req.user) && !competition.bouts_published_at) shown.bouts = shown.bouts.filter((b) => b.event !== 'Kyorugi');
  if (!isStaff(req.user) && !competition.poomsae_brackets_published_at) shown.bouts = shown.bouts.filter((b) => b.event !== 'Poomsae');
  return shown;
}

const dayLabelOf = (dates, day) => (dates[day - 1] ? `Day ${day} · ${formatDay(dates[day - 1])}` : `Day ${day}`);
const updatedAt = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

router.get('/:id(\\d+)', screenCompetition('any'), (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  const days = courtList(db, competition, {
    kyorugi: kyorugiVisible(req.user, competition),
    poomsae: poomsaeVisible(req.user, competition),
    published: !isStaff(req.user),
  });
  res.render('screens/index', { title: 'Court screens', competition, days });
});

router.get('/:id(\\d+)/:day(\\d+)/:court(\\d+)', screenCompetition('kyorugi'), (req, res) => {
  const { db } = req.app.locals;
  const day = Number(req.params.day);
  const court = Number(req.params.court);
  const bouts = listBouts(db, req.competition.id).filter((b) => b.day === day && b.court === court);
  if (bouts.length === 0) return notFound(res);
  const waiting = bouts.filter((b) => !b.winner && !b.noContest);
  // On now: the first unfinished bout whose two athletes are known.
  const now = waiting.find((b) => b.blue && b.red) || null;
  const next = waiting.filter((b) => b !== now).slice(0, 3);
  const recent = bouts.filter((b) => b.winner).slice(-3).reverse();
  res.render('screens/court', forVisitor(req, {
    title: `Court ${court}`,
    competition: req.competition,
    court,
    day,
    dayLabel: dayLabelOf(getEventDates(db, req.competition.id), day),
    now,
    photos: nowPhotos(req, 'kyorugi', now),
    next,
    recent,
    done: bouts.length - waiting.length,
    total: bouts.length,
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: updatedAt(),
  }));
});

// What a court is doing: the first unfinished item that can start (a bout once
// both sides are known, a performer any time) and the one after it. done: a
// winner, no contest, or a score.
function courtState(items) {
  const isDone = (i) => (i.kind === 'perform' ? i.done : Boolean(i.winner || i.noContest));
  const waiting = items.filter((i) => !isDone(i));
  const now = waiting.find((i) => i.kind === 'perform' || (i.blue && i.red)) || null;
  return { now, next: waiting.find((i) => i !== now) || null, done: items.length - waiting.length, total: items.length };
}

// The main screen: every court of one day side by side, kyorugi then poomsae,
// each with what's on now and next, and the latest bout call along the bottom.
// For a big screen in the hall; live like the court screens.
router.get('/:id(\\d+)/main/:day(\\d+)', screenCompetition('any'), (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  const day = Number(req.params.day);
  // Kyorugi and poomsae share the courts: one tile per court, its items in the
  // order the court runs them (the competition's court_order, each in time order).
  const kyorugi = kyorugiVisible(req.user, competition) ? listBouts(db, competition.id).filter((b) => b.day === day && b.court) : [];
  const poomsae = poomsaeVisible(req.user, competition)
    ? poomsaeCourtItems(db, competition, { published: !isStaff(req.user) }).filter((i) => i.day === day && i.court)
    : [];
  const courts = [...new Set([...kyorugi, ...poomsae].map((i) => i.court))].sort((a, b) => a - b).map((court) => {
    const parts = [kyorugi.filter((b) => b.court === court), poomsae.filter((i) => i.court === court)];
    const items = competition.court_order === 'poomsae' ? [...parts[1], ...parts[0]] : [...parts[0], ...parts[1]];
    return { court, label: `Court ${court}`, ...courtState(items) };
  });
  if (courts.length === 0) return notFound(res);
  const [current] = listBoutCalls(db, competition.id, day, 1);
  res.render('screens/main', forVisitor(req, {
    title: 'Main screen',
    competition,
    day,
    dayLabel: dayLabelOf(getEventDates(db, competition.id), day),
    courts,
    call: callForScreen(req, current),
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: updatedAt(),
  }));
});

// The call screen: the bouts staff last called for one day, for the warm-up
// area, with the call before it. Live like the court screens.
router.get('/:id(\\d+)/calls/:day(\\d+)', screenCompetition('any'), (req, res) => {
  const { db } = req.app.locals;
  const day = Number(req.params.day);
  if (day < 1 || day > getEventDates(db, req.competition.id).length) return notFound(res);
  const [first, second] = listBoutCalls(db, req.competition.id, day, 2);
  const current = callForScreen(req, first);
  const previous = callForScreen(req, second);
  const bouts = current ? current.bouts : [];
  res.render('screens/calls', forVisitor(req, {
    title: 'Now calling',
    competition: req.competition,
    day,
    dayLabel: dayLabelOf(getEventDates(db, req.competition.id), day),
    current: current || null,
    previous: previous || null,
    courts: [...new Set(bouts.map((b) => b.court))].map((court) => ({ court, bouts: bouts.filter((b) => b.court === court) })),
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: updatedAt(),
  }));
});

router.get('/:id(\\d+)/poomsae/:day(\\d+)/:court(\\d+)', screenCompetition('poomsae'), (req, res) => {
  const { db } = req.app.locals;
  const day = Number(req.params.day);
  const court = Number(req.params.court);
  const queue = poomsaeCourtQueue(db, req.competition, day, court, { published: !isStaff(req.user) });
  if (queue.items.length === 0) return notFound(res);
  res.render('screens/poomsae_court', forVisitor(req, {
    title: `Court ${court} · Poomsae`,
    competition: req.competition,
    court,
    day,
    dayLabel: dayLabelOf(getEventDates(db, req.competition.id), day),
    ...queue,
    photos: nowPhotos(req, 'poomsae', queue.now),
    total: queue.items.length,
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: updatedAt(),
  }));
});

// A server-sent event stream for one screen: "change" whenever the competition
// changes (a result and the bout it fills become one), and the page then fetches
// its new content.
function changeStream(req, res) {
  const { live } = req.app.locals;
  eventStream(req, res, (onChange) => live.subscribe(req.competition.id, onChange), () => res.write(`event: change\ndata: ${Date.now()}\n\n`));
}

router.get('/:id(\\d+)/:day(\\d+)/:court(\\d+)/events', screenCompetition('kyorugi'), changeStream);
router.get('/:id(\\d+)/poomsae/:day(\\d+)/:court(\\d+)/events', screenCompetition('poomsae'), changeStream);
router.get('/:id(\\d+)/calls/:day(\\d+)/events', screenCompetition('any'), changeStream);
router.get('/:id(\\d+)/main/:day(\\d+)/events', screenCompetition('any'), changeStream);

module.exports = router;
