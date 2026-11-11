// A poomsae judge's phone page: a private link (no account) to score each
// performer on one poomsae court and day. The score is saved once every judge
// has sent theirs. The link is the only key, so it's never logged, and the
// page shows only what the public bout list would: names, clubs and divisions.
const express = require('express');
const { findJudgeLink, submitJudgeMark, poomsaeCourtQueue, loadJudgeMarks, getEventDates } = require('../services');
const { parseScore, formatScore } = require('../poomsae');
const { formatDay } = require('../divisions');
const { notFound } = require('./helpers');
const { changeStream } = require('./screens');

const router = express.Router();

function judgeLink(req, res, next) {
  const found = findJudgeLink(req.app.locals.db, req.params.token);
  if (!found || found.competition.status !== 'closed') return notFound(res);
  req.judge = found.link;
  req.competition = found.competition;
  return next();
}

const pagePath = (req) => `/judge/${req.params.token}`;

router.get('/:token', judgeLink, (req, res) => {
  const { db } = req.app.locals;
  const { day, court, judge } = req.judge;
  const queue = poomsaeCourtQueue(db, req.competition, day, court);
  const marks = loadJudgeMarks(db, req.competition.id);
  const date = getEventDates(db, req.competition.id)[day - 1];
  // Search engines and link previews should never keep a judge's page.
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.render('judge', {
    title: `Judge ${judge}`,
    competition: req.competition,
    judge,
    day,
    court,
    dayLabel: date ? `Day ${day} · ${formatDay(date)}` : `Day ${day}`,
    now: queue.now,
    next: queue.next.filter((i) => i.kind === 'perform'),
    mine: queue.now && queue.now.kind === 'perform' ? (marks.get(queue.now.id) || [])[judge - 1] ?? null : null,
    sent: queue.now && queue.now.kind === 'perform' ? (marks.get(queue.now.id) || []).filter((m) => m !== undefined).length : 0,
    path: pagePath(req),
  });
});

router.post('/:token', judgeLink, (req, res) => {
  const { db } = req.app.locals;
  const parsed = parseScore(req.body.score);
  const result = !parsed.ok ? parsed
    : parsed.score === null ? { ok: false, error: 'Enter your score, such as 7.8.' }
      : submitJudgeMark(db, req.competition, req.judge, req.body.entry, parsed.score);
  if (!result.ok) req.flash('error', result.error);
  else {
    const where = `Poomsae court ${req.judge.court}, day ${req.judge.day}`;
    req.logActivity('poomsae.judge_mark', `Judge ${req.judge.judge} (${where}) scored ${result.performer.name} (${result.performer.club})`, req.competition.id);
    if (result.complete) {
      req.logActivity('poomsae.scored', `Poomsae score ${formatScore(result.score)} for ${result.performer.name} (${result.performer.club}) from the judges' phones`, req.competition.id);
    }
    req.flash('success', result.complete ? `Thank you. Every judge has scored ${result.performer.name}.` : `Your score for ${result.performer.name} is in. You can change it until every judge has scored.`);
  }
  return res.redirect(pagePath(req));
});

router.get('/:token/events', judgeLink, changeStream);

module.exports = router;
