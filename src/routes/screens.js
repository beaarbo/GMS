// Court screens: a page per court and day for a TV or tablet at the mat, showing
// what's on now, what's next and recent results, for kyorugi courts and poomsae
// courts. Logged-in users only, because they show athletes' names; coaches only
// see what has been published (the kyorugi bout list, each poomsae stage).
const express = require('express');
const { listBouts, getEventDates, poomsaeCourtItems, poomsaeCourtQueue, listBoutCalls, calledBouts, callTime, callText } = require('../services');
const { formatDay } = require('../divisions');
const { hasPoomsae } = require('../poomsae');
const { notFound } = require('./helpers');

const router = express.Router();
const REFRESH_SECONDS = 15;

const isStaff = (user) => ['admin', 'official'].includes(user.role);
const kyorugiVisible = (user, c) => isStaff(user) || Boolean(c.bouts_published_at);
const poomsaeVisible = (user, c) => hasPoomsae(c) && (isStaff(user) || Boolean(c.poomsae_published_at || c.poomsae_brackets_published_at));

// kind: 'any' for the screens list, or the event a screen belongs to.
function screenCompetition(kind) {
  return (req, res, next) => {
    if (!req.user) {
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/login');
    }
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

const dayLabelOf = (dates, day) => (dates[day - 1] ? `Day ${day} · ${formatDay(dates[day - 1])}` : `Day ${day}`);
const updatedAt = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

router.get('/:id(\\d+)', screenCompetition('any'), (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  const dates = getEventDates(db, competition.id);
  const courts = new Map();
  const count = (kind, item) => {
    const key = `${item.day}:${kind}:${item.court}`;
    const entry = courts.get(key) || { kind, day: item.day, court: item.court, total: 0, done: 0 };
    entry.total += 1;
    if (item.kind === 'perform' ? item.done : item.winner || item.noContest) entry.done += 1;
    courts.set(key, entry);
  };
  if (kyorugiVisible(req.user, competition)) listBouts(db, competition.id).forEach((b) => count('kyorugi', b));
  if (poomsaeVisible(req.user, competition)) {
    poomsaeCourtItems(db, competition, { published: !isStaff(req.user) }).forEach((item) => count('poomsae', item));
  }
  const days = [...new Set([...courts.values()].map((c) => c.day))].sort((a, b) => a - b).map((day) => ({
    day,
    label: dates[day - 1] ? `Day ${day} (${formatDay(dates[day - 1])})` : `Day ${day}`,
    courts: [...courts.values()].filter((c) => c.day === day).sort((a, b) => a.kind.localeCompare(b.kind) || a.court - b.court),
  }));
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
  res.render('screens/court', {
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
  });
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
  const courts = [];
  if (kyorugiVisible(req.user, competition)) {
    const bouts = listBouts(db, competition.id).filter((b) => b.day === day);
    [...new Set(bouts.map((b) => b.court))].sort((a, b) => a - b).forEach((court) => {
      courts.push({ kind: 'kyorugi', court, label: `Court ${court}`, ...courtState(bouts.filter((b) => b.court === court)) });
    });
  }
  if (poomsaeVisible(req.user, competition)) {
    const items = poomsaeCourtItems(db, competition, { published: !isStaff(req.user) }).filter((i) => i.day === day);
    [...new Set(items.map((i) => i.court))].sort((a, b) => a - b).forEach((court) => {
      courts.push({ kind: 'poomsae', court, label: `Poomsae court ${court}`, ...courtState(items.filter((i) => i.court === court)) });
    });
  }
  if (courts.length === 0) return notFound(res);
  const [current] = kyorugiVisible(req.user, competition) ? listBoutCalls(db, competition.id, day, 1) : [];
  res.render('screens/main', {
    title: 'Main screen',
    competition,
    day,
    dayLabel: dayLabelOf(getEventDates(db, competition.id), day),
    courts,
    call: current ? { ...current, at: callTime(current), text: callText(current), bouts: calledBouts(db, competition.id, current) } : null,
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: updatedAt(),
  });
});

// The call screen: the bouts staff last called for one day, for the warm-up
// area, with the call before it. Live like the court screens.
router.get('/:id(\\d+)/calls/:day(\\d+)', screenCompetition('kyorugi'), (req, res) => {
  const { db } = req.app.locals;
  const day = Number(req.params.day);
  if (!listBouts(db, req.competition.id).some((b) => b.day === day)) return notFound(res);
  const [current, previous] = listBoutCalls(db, req.competition.id, day, 2).map((call) => ({ ...call, at: callTime(call), text: callText(call) }));
  const bouts = current ? calledBouts(db, req.competition.id, current) : [];
  res.render('screens/calls', {
    title: 'Now calling',
    competition: req.competition,
    day,
    dayLabel: dayLabelOf(getEventDates(db, req.competition.id), day),
    current: current || null,
    previous: previous || null,
    courts: [...new Set(bouts.map((b) => b.court))].map((court) => ({ court, bouts: bouts.filter((b) => b.court === court) })),
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: updatedAt(),
  });
});

router.get('/:id(\\d+)/poomsae/:day(\\d+)/:court(\\d+)', screenCompetition('poomsae'), (req, res) => {
  const { db } = req.app.locals;
  const day = Number(req.params.day);
  const court = Number(req.params.court);
  const queue = poomsaeCourtQueue(db, req.competition, day, court, { published: !isStaff(req.user) });
  if (queue.items.length === 0) return notFound(res);
  res.render('screens/poomsae_court', {
    title: `Poomsae court ${court}`,
    competition: req.competition,
    court,
    day,
    dayLabel: dayLabelOf(getEventDates(db, req.competition.id), day),
    ...queue,
    photos: nowPhotos(req, 'poomsae', queue.now),
    total: queue.items.length,
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: updatedAt(),
  });
});

const HEARTBEAT_MS = 25000;
const COALESCE_MS = 300;

// A server-sent event stream for one court screen. It sends "change" whenever
// the competition changes; the page then fetches its new content. Comments keep
// the connection open through proxies, and the browser reconnects on its own.
function changeStream(req, res) {
  const { live } = req.app.locals;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');

  // Several changes in a burst (a result and the bout it fills) become one update.
  let pending = null;
  const unsubscribe = live.subscribe(req.competition.id, () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      res.write(`event: change\ndata: ${Date.now()}\n\n`);
    }, COALESCE_MS);
  });
  const heartbeat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(pending);
    unsubscribe();
  });
}

router.get('/:id(\\d+)/:day(\\d+)/:court(\\d+)/events', screenCompetition('kyorugi'), changeStream);
router.get('/:id(\\d+)/poomsae/:day(\\d+)/:court(\\d+)/events', screenCompetition('poomsae'), changeStream);
router.get('/:id(\\d+)/calls/:day(\\d+)/events', screenCompetition('kyorugi'), changeStream);
router.get('/:id(\\d+)/main/:day(\\d+)/events', screenCompetition('any'), changeStream);

module.exports = router;
