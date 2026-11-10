// Court screens: a page per court and day for a TV or tablet at the mat, showing
// the bout on now, what's next and recent results. Logged-in users only, because
// they show athletes' names, and coaches only once the bout list is published.
const express = require('express');
const { listBouts, getEventDates } = require('../services');
const { formatDay } = require('../divisions');
const { notFound } = require('./helpers');

const router = express.Router();
const REFRESH_SECONDS = 15;

function screenCompetition(req, res, next) {
  if (!req.user) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
  }
  const competition = req.app.locals.db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  const staff = ['admin', 'official'].includes(req.user.role);
  if (!competition || competition.status !== 'closed' || (!staff && !competition.bouts_published_at)) return notFound(res);
  req.competition = competition;
  return next();
}

const allBouts = listBouts;

router.get('/:id(\\d+)', screenCompetition, (req, res) => {
  const { db } = req.app.locals;
  const dates = getEventDates(db, req.competition.id);
  const courts = new Map();
  allBouts(db, req.competition.id).forEach((b) => {
    const key = `${b.day}:${b.court}`;
    const entry = courts.get(key) || { day: b.day, court: b.court, total: 0, done: 0 };
    entry.total += 1;
    if (b.winner) entry.done += 1;
    courts.set(key, entry);
  });
  const days = [...new Set([...courts.values()].map((c) => c.day))].map((day) => ({
    day,
    label: dates[day - 1] ? `Day ${day} (${formatDay(dates[day - 1])})` : `Day ${day}`,
    courts: [...courts.values()].filter((c) => c.day === day),
  }));
  res.render('screens/index', { title: 'Court screens', competition: req.competition, days });
});

router.get('/:id(\\d+)/:day(\\d+)/:court(\\d+)', screenCompetition, (req, res) => {
  const { db } = req.app.locals;
  const day = Number(req.params.day);
  const court = Number(req.params.court);
  const bouts = allBouts(db, req.competition.id).filter((b) => b.day === day && b.court === court);
  if (bouts.length === 0) return notFound(res);
  const waiting = bouts.filter((b) => !b.winner);
  // On now: the first unfinished bout whose two athletes are known.
  const now = waiting.find((b) => b.blue && b.red) || null;
  const next = waiting.filter((b) => b !== now).slice(0, 3);
  const recent = bouts.filter((b) => b.winner).slice(-3).reverse();
  const date = getEventDates(db, req.competition.id)[day - 1];
  res.render('screens/court', {
    title: `Court ${court}`,
    competition: req.competition,
    court,
    day,
    dayLabel: date ? `Day ${day} · ${formatDay(date)}` : `Day ${day}`,
    now,
    next,
    recent,
    done: bouts.length - waiting.length,
    total: bouts.length,
    refreshSeconds: REFRESH_SECONDS,
    updatedAt: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  });
});

const HEARTBEAT_MS = 25000;
const COALESCE_MS = 300;

// A server-sent event stream for one court screen. It sends "change" whenever
// the competition changes; the page then fetches its new content. Comments keep
// the connection open through proxies, and the browser reconnects on its own.
router.get('/:id(\\d+)/:day(\\d+)/:court(\\d+)/events', screenCompetition, (req, res) => {
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
});

module.exports = router;
