// Competition-day work shared by admins and officials: the weigh-in and
// recording results. Everything else about a competition stays admin-only.
const express = require('express');
const { formatEventDates, GENDERS } = require('../divisions');
const {
  hasBoutList,
  loadBoutList,
  recordResult,
  clearResult,
  listWeighIns,
  weighInCounts,
  recordWeighIn,
  getEventDates,
} = require('../services');
const { computeMedals } = require('../bracket');
const { clean, requireRole, notFound } = require('./helpers');

const router = express.Router();
const staff = requireRole(['admin', 'official']);

// Officials only reach competitions that are past registration.
router.use('/competitions/:id(\\d+)/:page(weigh-in|results)', staff, (req, res, next) => {
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
    locked: hasBoutList(db, req.competition.id),
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
      req.flash(
        'error',
        result.lighter
          ? `${name} is under ${result.entered}: their weight is in ${result.fits.label}. Keep them in ${result.entered}, or move them.`
          : `${name} is over ${result.entered}: their weight is in ${result.fits.label}. Move them or disqualify them.`
      );
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
      log(`Marked ${who} as a no-show at weigh-in`);
      req.flash('success', `${name} marked as a no-show. They won't be drawn.`);
      break;
    case 'disqualify':
      log(`Disqualified ${who} at weigh-in`);
      req.flash('success', `${name} disqualified. They won't be drawn.`);
      break;
    default:
      log(`Undid the weigh-in for ${who}${result.backTo ? `, back to ${result.backTo}` : ''}`);
      req.flash('success', `Weigh-in undone for ${name}${result.backTo ? `. They're back in ${result.backTo}` : ''}.`);
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
    done: bouts.filter((b) => b.winner).length,
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
    fighters: `${row.blue_first} ${row.blue_last} vs ${row.red_first} ${row.red_last}`,
    winner: row.first_name ? `${row.first_name} ${row.last_name}` : '',
  };
}

router.post('/competitions/:id(\\d+)/results/:boutId(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const boutId = Number(req.params.boutId);
  const clearing = req.body.action === 'clear';
  const before = db.prepare('SELECT 1 FROM bouts WHERE id = ? AND competition_id = ?').get(boutId, req.competition.id) ? boutText(db, boutId) : null;
  const result = clearing
    ? clearResult(db, req.competition.id, boutId)
    : recordResult(db, req.competition.id, boutId, req.body.winner);
  if (!result.ok) req.flash('error', result.error);
  else if (clearing) {
    req.logActivity('result.cleared', `Undid the result of ${before.place}, ${before.fighters}. The winner had been ${before.winner}`, req.competition.id);
  } else {
    const after = boutText(db, boutId);
    const changedFrom = before.winner && before.winner !== after.winner ? `, changed from ${before.winner}` : '';
    req.logActivity('result.recorded', `${after.winner} won ${after.place}, ${after.fighters}${changedFrom}`, req.competition.id);
  }
  return res.redirect(resultsPath(req.competition, req.body.day, req.body.court));
});

module.exports = { router, resultsPath };
