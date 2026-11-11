// Competition-day work shared by admins and officials: the weigh-in, recording
// results, and poomsae scores and bracket winners. Everything else about a
// competition stays admin-only, including poomsae approvals and draws.
const express = require('express');
const { formatEventDates, formatDay, GENDERS } = require('../divisions');
const {
  hasBoutList,
  loadBoutList,
  recordResult,
  clearResult,
  listWeighIns,
  weighInCounts,
  recordWeighIn,
  getEventDates,
  listBouts,
  applyWalkovers,
  listPoomsaeEntries,
  getPoomsaeEntry,
  poomsaeDivisions,
  loadPoomsaeBrackets,
  loadPoomsaeSettings,
  savePoomsaeSchedule,
  savePoomsaeDivision,
  generatePoomsaeOrder,
  clearPoomsaeOrder,
  poomsaeBoutList,
  poomsaeCourtQueue,
  judgeLinks,
  resetJudgeLinks,
  drawPoomsaeBracket,
  deletePoomsaeBracket,
  recordPoomsaeBout,
  reviewPoomsae,
  recordPoomsaeScore,
  hasPoomsaeScores,
  loadJudgeMarks,
} = require('../services');
const { hasPoomsae, parseScore, formatScore, poomsaeDivisionTitle, poomsaeMedalTable, POOMSAE_FORMATS, MAX_CUT, JUDGE_COUNTS, judgesScore } = require('../poomsae');
const { notifyPoomsaeDecisions, notifyPoomsaePublished } = require('../notifications');
const { writeBoutListPdf } = require('../boutlistPdf');
const { computeMedals, WIN_TYPES, readBoutScore } = require('../bracket');
const { clean, requireRole, notFound } = require('./helpers');

const router = express.Router();
const staff = requireRole(['admin', 'official']);

// Officials only reach competitions that are past registration.
router.use('/competitions/:id(\\d+)/:page(weigh-in|results|mat|poomsae)', staff, (req, res, next) => {
  const competition = req.app.locals.db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!competition || (req.user.role === 'official' && competition.status !== 'closed')) return notFound(res);
  req.competition = competition;
  return next();
});

// Weigh-in filters, kept across each step so the official stays on their list.
function weighInFilters(source) {
  const show = ['waiting', 'done', 'out'].includes(source.show) ? source.show : '';
  const club = /^\d+$/.test(source.club || '') ? source.club : '';
  const weight = /^\d+$/.test(source.weight || '') ? source.weight : '';
  const q = clean(source.q, 60);
  return { show, club, weight, q };
}

function weighInPath(competition, filters, registrationId = null) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  return `/admin/competitions/${competition.id}/weigh-in${query ? `?${query}` : ''}${registrationId ? `#reg-${registrationId}` : ''}`;
}

router.get('/competitions/:id(\\d+)/weigh-in', (req, res) => {
  const { db } = req.app.locals;
  const filters = weighInFilters(req.query);
  const all = listWeighIns(db, req.competition.id);
  const search = filters.q.toLowerCase();
  const rows = all.filter((r) => {
    if (filters.show === 'waiting' && r.weigh_status) return false;
    if (filters.show === 'done' && r.weigh_status !== 'passed') return false;
    if (filters.show === 'out' && !['no_show', 'disqualified'].includes(r.weigh_status)) return false;
    if (filters.club && String(r.club_id) !== filters.club) return false;
    if (filters.weight && String(r.weight_class_id) !== filters.weight) return false;
    return !search || `${r.first_name} ${r.last_name}`.toLowerCase().includes(search) || `${r.last_name} ${r.first_name}`.toLowerCase().includes(search);
  });
  // An out-of-class result waiting for the official's decision. The next weigh-in step clears it.
  const pending = req.session.weighDecision && req.session.weighDecision.competitionId === req.competition.id ? req.session.weighDecision : null;

  res.render('admin/weighin', {
    title: 'Weigh-in',
    competition: req.competition,
    rows,
    filters,
    query: new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString(),
    counts: weighInCounts(db, req.competition.id),
    clubs: [...new Map(all.map((r) => [r.club_id, r.club_name])).entries()].sort((a, b) => a[1].localeCompare(b[1])),
    // Classes with approved athletes in them, in division order. A label like
    // "-45 kg" repeats across age groups, so each names its age group and gender.
    weightClasses: [...new Map(all.map((r) => [r.weight_class_id, `${r.age_group} · ${GENDERS[r.gender]} · ${r.weight_class}`])).entries()],
    // After the draw, nobody changes class and anyone out gives their opponent a walkover.
    drawn: hasBoutList(db, req.competition.id),
    pending,
  });
});

router.post('/competitions/:id(\\d+)/weigh-in/:regId(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const filters = weighInFilters(req.body);
  const registrationId = Number(req.params.regId);
  const athlete = db
    .prepare(
      `SELECT f.first_name, f.last_name, c.name AS club FROM registrations r
       JOIN fighters f ON f.id = r.fighter_id JOIN clubs c ON c.id = r.club_id WHERE r.id = ? AND r.competition_id = ?`
    )
    .get(registrationId, req.competition.id);
  const back = weighInPath(req.competition, filters, registrationId);
  if (!athlete) return notFound(res);
  const decision = req.session.weighDecision;
  delete req.session.weighDecision;
  if (req.body.action === 'cancel') return res.redirect(back);
  // Keeping an off-weight athlete in their class is only allowed when this
  // athlete's last check found them lighter than it, never heavier.
  const mayKeep = decision && decision.competitionId === req.competition.id && decision.registrationId === registrationId && decision.lighter;
  if (req.body.action === 'keep' && !mayKeep) {
    req.flash('error', `${athlete.first_name} ${athlete.last_name}: weigh them again first.`);
    return res.redirect(back);
  }

  const result = recordWeighIn(db, req.competition, registrationId, {
    action: req.body.action,
    weightKg: req.body.weight_kg,
    weightClassId: req.body.weight_class_id,
  });
  const name = `${athlete.first_name} ${athlete.last_name}`;
  const who = `${name} (${athlete.club})`;
  if (!result.ok) {
    req.flash('error', `${name}: ${result.error}`);
    return res.redirect(back);
  }
  const log = (summary) => req.logActivity('weighin.recorded', summary, req.competition.id);
  switch (result.outcome) {
    case 'out_of_class':
      // Nothing is saved yet. The weight stays server-side for the decision only.
      req.session.weighDecision = {
        competitionId: req.competition.id, registrationId, fitsId: result.fits.id, fits: result.fits.label, entered: result.entered, lighter: result.lighter,
      };
      if (hasBoutList(db, req.competition.id)) {
        // After the draw nobody changes class, so the choice is to keep or disqualify.
        req.flash(
          'error',
          result.lighter
            ? `${name} is under ${result.entered}: their weight is in ${result.fits.label}. Keep them in ${result.entered}, or disqualify them to give their opponent a walkover.`
            : `${name} is over ${result.entered}: their weight is in ${result.fits.label}. Disqualify them to give their opponent a walkover, or weigh them again.`
        );
      } else {
        req.flash(
          'error',
          result.lighter
            ? `${name} is under ${result.entered}: their weight is in ${result.fits.label}. Keep them in ${result.entered}, or move them.`
            : `${name} is over ${result.entered}: their weight is in ${result.fits.label}. Move them or disqualify them.`
        );
      }
      break;
    case 'kept':
      log(`${who} weighed in under ${result.weightClass} and stays in it`);
      req.flash('success', `${name} stays in ${result.weightClass}.`);
      break;
    case 'passed':
      log(`${who} made weight for ${result.weightClass}`);
      req.flash('success', `${name} made weight for ${result.weightClass}.`);
      break;
    case 'moved':
      log(`Moved ${who} from ${result.from} to ${result.to} at weigh-in`);
      req.flash('success', `${name} moved to ${result.to}.`);
      break;
    case 'no_show':
    case 'disqualify':
      log(`${result.outcome === 'no_show' ? 'Marked' : 'Disqualified'} ${who}${result.outcome === 'no_show' ? ' as a no-show' : ''} at weigh-in`);
      result.walkovers.forEach((item) => logWalkover(req, db, item));
      req.flash('success', `${name} ${result.outcome === 'no_show' ? 'marked as a no-show' : 'disqualified'}. ${
        !result.drawn ? "They won't be drawn."
          : result.walkovers.length > 0 ? 'Their opponent gets a walkover.'
            : 'Their opponent gets a walkover once they are known.'
      }`);
      break;
    default:
      log(`Undid the weigh-in for ${who}${result.backTo ? `, back to ${result.backTo}` : ''}`);
      req.flash('success', `Weigh-in undone for ${name}${result.backTo ? `. They're back in ${result.backTo}` : ''}${result.walkoversUndone ? `. Their opponent's walkover was taken back` : ''}.`);
  }
  return res.redirect(back);
});

function resultsPath(competition, day, court) {
  const query = new URLSearchParams();
  if (/^\d+$/.test(day || '')) query.set('day', day);
  if (/^\d+$/.test(court || '')) query.set('court', court);
  const text = query.toString();
  return `/admin/competitions/${competition.id}/results${text ? `?${text}` : ''}`;
}

router.get('/competitions/:id(\\d+)/results', (req, res) => {
  const divisions = loadBoutList(req.app.locals.db, req.competition.id);
  const day = clean(req.query.day, 5);
  const court = clean(req.query.court, 5);
  const bouts = divisions
    .flatMap((division) =>
      division.bouts
        .filter((bout) => !bout.isBye)
        .map((bout) => ({ ...bout, title: division.title, day: division.day, dayLabel: division.dayLabel, court: division.court }))
    )
    .sort((a, b) => a.day - b.day || a.court - b.court || a.number - b.number);
  const shown = bouts.filter((b) => (!day || String(b.day) === day) && (!court || String(b.court) === court));
  const uniqueBy = (key, label) => [...new Map(bouts.map((b) => [b[key], b[label]])).entries()].sort((a, b) => a[0] - b[0]);
  res.render('admin/results', {
    title: 'Results',
    competition: req.competition,
    bouts: shown,
    day,
    court,
    days: uniqueBy('day', 'dayLabel'),
    courts: uniqueBy('court', 'court'),
    done: bouts.filter((b) => b.winner || b.noContest).length,
    total: bouts.length,
    medals: computeMedals(divisions),
  });
});

// Names the bout by its place in the schedule, plus who's in it.
function boutText(db, boutId) {
  const row = db
    .prepare(
      `SELECT b.bout_number, b.day, b.court, fw.first_name, fw.last_name,
         fb.first_name AS blue_first, fb.last_name AS blue_last, fr.first_name AS red_first, fr.last_name AS red_last
       FROM bouts b
       LEFT JOIN registrations rw ON rw.id = b.winner_registration_id LEFT JOIN fighters fw ON fw.id = rw.fighter_id
       LEFT JOIN registrations rb ON rb.id = b.blue_registration_id LEFT JOIN fighters fb ON fb.id = rb.fighter_id
       LEFT JOIN registrations rr ON rr.id = b.red_registration_id LEFT JOIN fighters fr ON fr.id = rr.fighter_id
       WHERE b.id = ?`
    )
    .get(boutId);
  return {
    place: `Bout ${row.bout_number} (Day ${row.day}, Court ${row.court})`,
    fighters: `${row.blue_first ? `${row.blue_first} ${row.blue_last}` : 'no opponent'} vs ${row.red_first ? `${row.red_first} ${row.red_last}` : 'no opponent'}`,
    winner: row.first_name ? `${row.first_name} ${row.last_name}` : '',
  };
}

router.post('/competitions/:id(\\d+)/results/:boutId(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const boutId = Number(req.params.boutId);
  const clearing = req.body.action === 'clear';
  const bout = db.prepare('SELECT walkover FROM bouts WHERE id = ? AND competition_id = ?').get(boutId, req.competition.id);
  const before = bout ? boutText(db, boutId) : null;
  // A walkover follows the weigh-in, so it changes only by undoing that weigh-in.
  // How the bout was won, both optional: a World Taekwondo result code and a score.
  const winType = WIN_TYPES[req.body.win_type] ? req.body.win_type : null;
  const score = readBoutScore(req.body.score);
  // A walkover follows the weigh-in, so it changes only by undoing that weigh-in.
  const result = bout && bout.walkover
    ? { ok: false, error: `${before.place} was a walkover after the weigh-in. Undo that athlete's weigh-in to change it.` }
    : clearing
      ? clearResult(db, req.competition.id, boutId)
      : !score.ok
        ? score
        : recordResult(db, req.competition.id, boutId, req.body.winner, { winType, score: score.score });
  if (!result.ok) req.flash('error', result.error);
  else if (clearing) {
    req.logActivity('result.cleared', `Undid the result of ${before.place}, ${before.fighters}. The winner had been ${before.winner}`, req.competition.id);
  } else {
    const after = boutText(db, boutId);
    const changedFrom = before.winner && before.winner !== after.winner ? `, changed from ${before.winner}` : '';
    const how = [winType, score.score].filter(Boolean).join(' ');
    req.logActivity('result.recorded', `${after.winner} won ${after.place}${how ? ` (${how})` : ''}, ${after.fighters}${changedFrom}`, req.competition.id);
    // The winner may now meet someone who failed the weigh-in.
    applyWalkovers(db, req.competition.id).forEach((item) => logWalkover(req, db, item));
  }
  const fromMat = req.body.back === 'mat' && /^\d+$/.test(req.body.day || '') && /^\d+$/.test(req.body.court || '');
  return res.redirect(fromMat ? matPath(req.competition, req.body.day, req.body.court) : resultsPath(req.competition, req.body.day, req.body.court));
});

const matPath = (competition, day, court) => `/admin/competitions/${competition.id}/mat/${day}/${court}`;

// item: { id, noContest } from applyWalkovers.
function logWalkover(req, db, item) {
  const text = boutText(db, item.id);
  if (item.noContest) {
    req.logActivity('result.no_contest', `${text.place} is a no contest: ${text.fighters} were both out at the weigh-in`, req.competition.id);
  } else {
    req.logActivity('result.walkover', `${text.winner} won ${text.place} by walkover, ${text.fighters}`, req.competition.id);
  }
}

// Results by mat: one court on one day, for an official's tablet. The bout on now
// with a big button per athlete, what's next, and the last result with undo.
// Results go through the same route as the results page, so the same rules apply.
router.get('/competitions/:id(\\d+)/mat/:day(\\d+)/:court(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const day = Number(req.params.day);
  const court = Number(req.params.court);
  const bouts = listBouts(db, req.competition.id).filter((b) => b.day === day && b.court === court);
  if (bouts.length === 0) return notFound(res);
  const waiting = bouts.filter((b) => !b.winner && !b.noContest);
  const now = waiting.find((b) => b.blue && b.red) || null;
  // An earlier bout still waiting for its athletes is why nothing is on yet.
  const blockedBy = !now && waiting.length > 0 ? waiting[0] : null;
  const date = getEventDates(db, req.competition.id)[day - 1];
  return res.render('admin/mat', {
    title: `Court ${court} results`,
    competition: req.competition,
    day,
    court,
    dayLabel: date ? `Day ${day} · ${formatDay(date)}` : `Day ${day}`,
    now,
    blockedBy,
    next: waiting.filter((b) => b !== now).slice(0, 3),
    last: bouts.filter((b) => b.winner).slice(-1)[0] || null,
    done: bouts.length - waiting.length,
    total: bouts.length,
  });
});

// Poomsae: admins approve entries here while registration runs. Once it closes,
// admins and officials record scores and bracket winners; admins draw brackets.
// The poomsae mat page: one poomsae court on one day, for an official's tablet.
// A performer gets score boxes (one per judge), a bout gets two winner buttons.
// Both post to the usual score and bout routes with back=mat, so the same rules apply.
router.get('/competitions/:id(\\d+)/poomsae/mat/:day(\\d+)/:court(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  if (!hasPoomsae(req.competition) || req.competition.status !== 'closed') return notFound(res);
  const day = Number(req.params.day);
  const court = Number(req.params.court);
  const queue = poomsaeCourtQueue(db, req.competition, day, court);
  if (queue.items.length === 0) return notFound(res);
  const date = getEventDates(db, req.competition.id)[day - 1];
  const last = queue.recent[0] || null;
  return res.render('admin/poomsae_mat', {
    title: `Poomsae court ${court} results`,
    competition: req.competition,
    day,
    court,
    dayLabel: date ? `Day ${day} · ${formatDay(date)}` : `Day ${day}`,
    ...queue,
    last,
    total: queue.items.length,
    marks: loadJudgeMarks(db, req.competition.id),
    // Each judge's private link for this court and day, for their phone.
    judgeLinks: judgeLinks(db, req.competition, day, court).map((l) => ({ judge: l.judge, url: `${req.app.locals.notify.publicUrl}/judge/${l.token}` })),
  });
});

// New judges' links for one court and day: the old ones stop working.
router.post('/competitions/:id(\\d+)/poomsae/mat/:day(\\d+)/:court(\\d+)/judge-links/reset', (req, res) => {
  const { day, court } = req.params;
  resetJudgeLinks(req.app.locals.db, req.competition.id, Number(day), Number(court));
  req.logActivity('poomsae.judge_links', `Replaced the judges' links for poomsae court ${court}, day ${day}: ${req.competition.name}`, req.competition.id);
  req.flash('success', 'New judges\' links made. The old ones no longer work, so send these to the judges.');
  return res.redirect(`/admin/competitions/${req.competition.id}/poomsae/mat/${day}/${court}#judge-links`);
});

const poomsaePath = (competition, entryId = null, divisionKey = null) =>
  `/admin/competitions/${competition.id}/poomsae${entryId ? `#entry-${entryId}` : divisionKey ? `#division-${divisionKey}` : ''}`;

function poomsaeOverview(db, competition) {
  const entries = listPoomsaeEntries(db, competition.id);
  return {
    entries,
    divisions: poomsaeDivisions(entries, competition, loadPoomsaeBrackets(db, competition.id, entries), loadPoomsaeSettings(db, competition.id)),
  };
}

// The poomsae courts and timings, then every bracket is timed again.
router.post('/competitions/:id(\\d+)/poomsae/schedule', requireRole('admin'), (req, res) => {
  const { db } = req.app.locals;
  const number = (value) => (/^\d{1,3}$/.test(clean(value, 3)) ? Number(clean(value, 3)) : NaN);
  const values = {
    courts: number(req.body.courts),
    start: clean(req.body.start, 5),
    minutes: number(req.body.minutes),
    rest: number(req.body.rest),
    // Left out of the form: keep the current number of judges.
    judges: req.body.judges === undefined ? req.competition.poomsae_judges : number(req.body.judges),
  };
  const errors = [];
  if (!JUDGE_COUNTS.includes(values.judges)) errors.push('Choose 1, 3, 5 or 7 judges.');
  else if (values.judges !== req.competition.poomsae_judges && hasPoomsaeScores(db, req.competition.id)) {
    errors.push('Poomsae already has scores, so the number of judges stays as it is. Clear the scores to change it.');
  }
  if (!(values.courts >= 1 && values.courts <= 20)) errors.push('Enter from 1 to 20 poomsae courts.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.start)) errors.push('Enter a valid start time.');
  if (!(values.minutes >= 1 && values.minutes <= 60)) errors.push('Enter from 1 to 60 minutes per bout.');
  if (!(values.rest >= 0 && values.rest <= 120)) errors.push('Enter a rest from 0 to 120 minutes.');
  if (errors.length > 0) errors.forEach((error) => req.flash('error', error));
  else {
    savePoomsaeSchedule(db, req.competition.id, values);
    req.logActivity(
      'poomsae.schedule',
      `Set the poomsae schedule for ${req.competition.name}: ${values.courts} court${values.courts === 1 ? '' : 's'} from ${values.start}, ${values.minutes} minutes a bout, ${values.rest} minutes rest, ${values.judges} judge${values.judges === 1 ? '' : 's'}`,
      req.competition.id
    );
    req.flash('success', 'Poomsae schedule saved. Every bracket has been timed again.');
  }
  return res.redirect(poomsaePath(req.competition));
});

// One division's own format, cut and day. Blank keeps the competition's choice.
router.post('/competitions/:id(\\d+)/poomsae/division', requireRole('admin'), (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  const key = clean(req.body.division, 60);
  const format = POOMSAE_FORMATS[req.body.format] ? req.body.format : null;
  const cutText = clean(req.body.cut, 3);
  const cut = cutText === '' ? null : Number(cutText);
  const dayText = clean(req.body.day, 2);
  const day = dayText === '' ? null : Number(dayText);
  const days = getEventDates(db, competition.id).length;
  if (cut !== null && !(Number.isInteger(cut) && cut >= 2 && cut <= MAX_CUT)) {
    req.flash('error', `Enter a cut from 2 to ${MAX_CUT}, or leave it blank for the competition's.`);
  } else if (day !== null && !(Number.isInteger(day) && day >= 1 && day <= days)) {
    req.flash('error', 'Choose one of the competition days.');
  } else {
    const result = savePoomsaeDivision(db, competition, key, { format, cut, day });
    if (!result.ok) req.flash('error', result.error);
    else {
      const parts = [
        result.format ? POOMSAE_FORMATS[result.format].toLowerCase() : 'the competition format',
        result.cut ? `top ${result.cut}` : null,
        result.day ? `day ${result.day}` : 'any day',
      ].filter(Boolean);
      req.logActivity('poomsae.division', `Set ${result.title} to ${parts.join(', ')}: ${competition.name}`, competition.id);
      req.flash('success', `${result.title} saved.${result.kept ? ' Its format stays as it was, because it has a performance list, scores or a bracket.' : ''}`);
    }
  }
  return res.redirect(poomsaePath(competition, null, key));
});

router.get('/competitions/:id(\\d+)/poomsae', (req, res) => {
  const { db } = req.app.locals;
  if (!hasPoomsae(req.competition)) return notFound(res);
  const { entries, divisions } = poomsaeOverview(db, req.competition);
  return res.render('admin/poomsae', {
    title: 'Poomsae',
    competition: req.competition,
    divisions,
    medals: poomsaeMedalTable(divisions),
    rejected: entries.filter((e) => e.status === 'rejected'),
    marks: loadJudgeMarks(db, req.competition.id),
    pending: entries.filter((e) => e.status === 'pending').length,
    approved: entries.filter((e) => e.status === 'approved').length,
    closed: req.competition.status === 'closed',
    drawable: divisions.filter((d) => d.mode !== 'score' && !d.bouts && !d.drawProblem && d.pending === 0).length,
    orderable: divisions.filter((d) => d.canOrder && d.order.length === 0).length,
    hasPages: divisions.some((d) => d.order.length > 0 || d.bouts),
    hasLists: divisions.some((d) => d.order.length > 0),
    hasBrackets: divisions.some((d) => d.bouts),
    // [number, label for the day list, short label like the kyorugi bout list's "1 (Fri 8 Jan)"]
    days: getEventDates(db, req.competition.id).map((date, i) => [i + 1, `Day ${i + 1} · ${formatDay(date)}`, `${i + 1} (${formatDay(date)})`]),
  });
});

// A random performance order for one ranked division or score round, or all that are ready.
router.post('/competitions/:id(\\d+)/poomsae/order', requireRole('admin'), (req, res) => {
  const { db } = req.app.locals;
  const key = clean(req.body.division, 60);
  const result = generatePoomsaeOrder(db, req.competition, key);
  if (!result.ok) req.flash('error', result.error);
  else {
    result.titles.forEach((title) => req.logActivity('poomsae.order', `Drew the poomsae performance order for ${title}: ${req.competition.name}`, req.competition.id));
    req.flash('success', `${result.titles.length} performance list${result.titles.length === 1 ? '' : 's'} made in a random order and timed.`);
  }
  return res.redirect(poomsaePath(req.competition, null, key === 'all' ? null : key));
});

router.post('/competitions/:id(\\d+)/poomsae/clear-order', requireRole('admin'), (req, res) => {
  const key = clean(req.body.division, 60);
  const result = clearPoomsaeOrder(req.app.locals.db, req.competition, key);
  if (!result.ok) req.flash('error', result.error);
  else {
    req.logActivity('poomsae.order_cleared', `Cleared the poomsae performance order for ${result.title}: ${req.competition.name}`, req.competition.id);
    req.flash('success', 'Performance list cleared.');
  }
  return res.redirect(poomsaePath(req.competition, null, key));
});

// Two stages, published apart: the performance lists (the first draw), then the
// brackets that follow the score rounds. Published pages are public, like the
// kyorugi bout list. Brackets drawn after their stage is published show at once.
const STAGES = {
  lists: { column: 'poomsae_published_at', kind: 'list', what: 'performance order' },
  brackets: { column: 'poomsae_brackets_published_at', kind: 'bracket', what: 'brackets' },
};

router.post('/competitions/:id(\\d+)/poomsae/publish', requireRole('admin'), (req, res) => {
  const { db, notify } = req.app.locals;
  const stage = STAGES[req.body.stage];
  if (!stage) return notFound(res);
  if (!poomsaeBoutList(db, req.competition).some((p) => p.kind === stage.kind)) {
    req.flash('error', stage.kind === 'list' ? 'Make a performance list first.' : 'Draw a bracket first.');
    return res.redirect(poomsaePath(req.competition));
  }
  db.prepare(`UPDATE competitions SET ${stage.column} = datetime('now') WHERE id = ?`).run(req.competition.id);
  notifyPoomsaePublished(notify, req.competition, stage.what);
  req.logActivity('poomsae.published', `Published the poomsae ${stage.what} for ${req.competition.name}`, req.competition.id);
  req.flash('success', `Poomsae ${stage.what} published for everyone to see. Coaches with entries have been emailed.`);
  return res.redirect(poomsaePath(req.competition));
});

router.post('/competitions/:id(\\d+)/poomsae/unpublish', requireRole('admin'), (req, res) => {
  const stage = STAGES[req.body.stage];
  if (!stage) return notFound(res);
  req.app.locals.db.prepare(`UPDATE competitions SET ${stage.column} = NULL WHERE id = ?`).run(req.competition.id);
  req.logActivity('poomsae.unpublished', `Hid the poomsae ${stage.what} for ${req.competition.name}`, req.competition.id);
  req.flash('success', `Poomsae ${stage.what} hidden.`);
  return res.redirect(poomsaePath(req.competition));
});

// Every performance list and bracket, one page each, in running order.
router.get('/competitions/:id(\\d+)/poomsae.pdf', staff, (req, res) => {
  const { db } = req.app.locals;
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!competition || !hasPoomsae(competition) || (req.user.role === 'official' && competition.status !== 'closed')) return notFound(res);
  const pages = poomsaeBoutList(db, competition);
  if (pages.length === 0) return notFound(res);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="poomsae-list-competition-${competition.id}.pdf"`);
  return writeBoutListPdf(res, { competition, divisions: pages, dateLabel: formatEventDates(getEventDates(db, competition.id)) });
});

// Draws one division's bracket, or every division that's ready ("all").
router.post('/competitions/:id(\\d+)/poomsae/draw', requireRole('admin'), (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  if (competition.status !== 'closed') {
    req.flash('error', 'Close registration before drawing poomsae brackets.');
    return res.redirect(poomsaePath(competition));
  }
  const key = clean(req.body.division, 60);
  const { divisions } = poomsaeOverview(db, competition);
  const targets = key === 'all'
    ? divisions.filter((d) => d.mode !== 'score' && !d.bouts && !d.drawProblem && d.pending === 0).map((d) => d.key)
    : [key];
  let drawn = 0;
  targets.forEach((target) => {
    const result = drawPoomsaeBracket(db, competition, target);
    if (result.ok) {
      drawn += 1;
      req.logActivity('poomsae.bracket_drawn', `Drew the poomsae bracket for ${result.title} (${result.entrants} entries): ${competition.name}`, competition.id);
    } else req.flash('error', result.error);
  });
  if (drawn > 0) req.flash('success', `${drawn} bracket${drawn === 1 ? '' : 's'} drawn.`);
  return res.redirect(poomsaePath(competition, null, key === 'all' ? null : key));
});

router.post('/competitions/:id(\\d+)/poomsae/delete-bracket', requireRole('admin'), (req, res) => {
  const { db } = req.app.locals;
  const key = clean(req.body.division, 60);
  const division = poomsaeOverview(db, req.competition).divisions.find((d) => d.key === key);
  const result = deletePoomsaeBracket(db, req.competition.id, key);
  if (!result.ok) req.flash('error', result.error);
  else {
    req.logActivity('poomsae.bracket_deleted', `Deleted the poomsae bracket for ${division ? division.title : key}: ${req.competition.name}`, req.competition.id);
    req.flash('success', 'Bracket deleted. You can draw it again.');
  }
  return res.redirect(poomsaePath(req.competition, null, key));
});

// A bracket winner, or "clear" to undo one. Admins and officials.
router.post('/competitions/:id(\\d+)/poomsae/bouts/:boutId(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  const bout = db.prepare('SELECT * FROM poomsae_bouts WHERE id = ? AND competition_id = ?').get(req.params.boutId, competition.id);
  if (!bout) return notFound(res);
  if (competition.status !== 'closed') return notFound(res);
  const clearing = req.body.action === 'clear';
  const { divisions } = poomsaeOverview(db, competition);
  const division = divisions.find((d) => d.key === bout.division_key);
  const before = division.bouts.find((b) => b.id === bout.id);
  const result = recordPoomsaeBout(db, competition.id, bout.id, clearing ? null : req.body.winner);
  if (!result.ok) req.flash('error', result.error);
  else if (clearing) {
    req.logActivity('poomsae.bout_cleared', `Undid poomsae Bout ${bout.bout_number} in ${division.title}, ${before.blue.name} vs ${before.red.name}. The winner had been ${before.winner.name}`, competition.id);
  } else {
    const winner = req.body.winner === 'blue' ? before.blue : before.red;
    req.logActivity('poomsae.bout_won', `${winner.name} won poomsae Bout ${bout.bout_number} in ${division.title}, ${before.blue.name} vs ${before.red.name}`, competition.id);
  }
  return res.redirect(poomsaeMatReturn(req) || poomsaePath(competition, null, bout.division_key));
});

router.post('/competitions/:id(\\d+)/poomsae/review', requireRole('admin'), (req, res) => {
  const { db, notify } = req.app.locals;
  const competition = req.competition;
  const all = listPoomsaeEntries(db, competition.id);
  // One row's button ("approved:12"), or approving every pending entry at once.
  const single = clean(req.body.single, 40).match(/^(approved|rejected|pending):(\d+)$/);
  const decision = single ? single[1] : req.body.bulk === 'approve-pending' ? 'approved' : null;
  if (!decision) return res.redirect(poomsaePath(competition));
  const targets = single ? all.filter((e) => e.id === Number(single[2])) : all.filter((e) => e.status === 'pending');

  const changed = [];
  targets.forEach((entry) => {
    const result = reviewPoomsae(db, competition.id, entry.id, decision, clean(req.body[`note_${entry.id}`], 300));
    if (!result.ok) req.flash('error', `${entry.names}: ${result.error}`);
    else if (result.changed) {
      const note = clean(req.body[`note_${entry.id}`], 300);
      changed.push({ ...entry, review_note: decision === 'rejected' ? note : '' });
      const verb = { approved: 'Approved', rejected: 'Rejected', pending: 'Moved back to pending' }[decision];
      req.logActivity(
        `poomsae.${decision}`,
        `${verb} the poomsae ${entry.event} entry of ${entry.names} (${entry.club_name}) for ${competition.name}${decision === 'rejected' ? `. Reason: ${note}` : ''}`,
        competition.id
      );
    }
  });
  notifyPoomsaeDecisions(notify, competition, changed, decision);
  if (changed.length > 0) {
    const verb = { approved: 'approved', rejected: 'rejected', pending: 'moved back to pending' }[decision];
    req.flash('success', `${changed.length} poomsae entr${changed.length === 1 ? 'y' : 'ies'} ${verb}.`);
  }
  return res.redirect(poomsaePath(competition, single ? single[2] : null));
});

router.post('/competitions/:id(\\d+)/poomsae/:entryId(\\d+)/score', (req, res) => {
  const { db } = req.app.locals;
  const entry = getPoomsaeEntry(db, req.competition.id, req.params.entryId);
  if (!entry) return notFound(res);
  const parsed = readScore(req.body, req.competition.poomsae_judges);
  const result = parsed.ok ? recordPoomsaeScore(db, req.competition, entry.id, parsed.score, parsed.marks) : parsed;
  if (!result.ok) {
    req.flash('error', `${entry.names}: ${result.error}`);
  } else if (parsed.score !== entry.score || parsed.marks) {
    const was = entry.score === null ? '' : `, changed from ${formatScore(entry.score)}`;
    const judges = parsed.marks ? ` (judges ${parsed.marks.map(formatScore).join(', ')})` : '';
    const summary = parsed.score === null
      ? `Cleared the poomsae score of ${entry.names} (${entry.club_name}), which was ${formatScore(entry.score)}`
      : `Poomsae score ${formatScore(parsed.score)}${judges} for ${entry.names} (${entry.club_name}) in ${poomsaeDivisionTitle(entry)}${was}`;
    req.logActivity(parsed.score === null ? 'poomsae.score_cleared' : 'poomsae.scored', summary, req.competition.id);
  }
  return res.redirect(poomsaeMatReturn(req) || poomsaePath(req.competition, entry.id));
});

// One final score (judge_1 alone, or "score"), or one mark per judge. Every
// judge's box must be filled, or all left blank to clear the score.
function readScore(body, judges) {
  if (judges === 1) return { ...parseScore(body.score ?? body.judge_1), marks: null };
  const raw = Array.from({ length: judges }, (_, i) => String(body[`judge_${i + 1}`] ?? '').trim());
  if (raw.every((value) => value === '')) return { ok: true, score: null, marks: null };
  if (raw.some((value) => value === '')) return { ok: false, error: `Enter all ${judges} judges' scores, or clear them all.` };
  const parsed = raw.map(parseScore);
  const bad = parsed.find((p) => !p.ok);
  if (bad) return bad;
  const marks = parsed.map((p) => p.score);
  return { ok: true, score: judgesScore(marks), marks };
}

// Where to go back to when a form came from the poomsae mat page.
function poomsaeMatReturn(req) {
  const ok = req.body.back === 'mat' && /^\d+$/.test(req.body.day || '') && /^\d+$/.test(req.body.court || '');
  return ok ? `/admin/competitions/${req.competition.id}/poomsae/mat/${req.body.day}/${req.body.court}` : null;
}

module.exports = { router, resultsPath };
