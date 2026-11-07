const express = require('express');
const { BELTS, GENDERS, isValidDate, competitionAge, divisionOptions, formatEventDates } = require('../divisions');
const {
  today,
  isRegistrationOpen,
  enterFighter,
  hasActiveRegistration,
  loadDivisionSetup,
  loadBoutList,
  getEventDates,
  saveFighterDocument,
  getFighterDocument,
  hasApprovedRegistration,
  REGISTRATION_SELECT,
} = require('../services');
const { documentLabel, documentTypeFor, detectFileType, sendDocument } = require('../documents');
const { layoutBracket, computeMedals, clubAthleteSummary } = require('../bracket');
const { writeBoutListPdf } = require('../boutlistPdf');
const { clean, toArray, requireRole, notFound } = require('./helpers');

const router = express.Router();
router.use(requireRole('coach'));

// Only coaches approved for a club can manage fighters and registrations.
router.use((req, res, next) => {
  if (req.user.club_id) return next();
  req.flash('error', 'An admin must approve you for a club before you can register athletes.');
  return res.redirect('/coach');
});

function readFighter(body) {
  const values = {
    first_name: clean(body.first_name, 80),
    last_name: clean(body.last_name, 80),
    gender: clean(body.gender, 1),
    date_of_birth: clean(body.date_of_birth, 10),
    belt_rank: Number(body.belt_rank),
  };
  const errors = [];
  if (!values.first_name) errors.push('Enter a first name.');
  if (!values.last_name) errors.push('Enter a last name.');
  if (!GENDERS[values.gender]) errors.push('Select a gender.');
  if (!isValidDate(values.date_of_birth) || values.date_of_birth >= today()) errors.push('Enter a valid date of birth.');
  if (!BELTS.some((b) => b.rank === values.belt_rank)) errors.push('Select a belt.');
  return { values, errors };
}

function ownFighter(req, id) {
  return req.app.locals.db.prepare('SELECT * FROM fighters WHERE id = ? AND club_id = ?').get(id, req.user.club_id);
}

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  const clubId = req.user.club_id;
  res.render('club/dashboard', {
    title: 'Club dashboard',
    fighters: db
      .prepare(
        `SELECT f.*, (SELECT d.doc_type FROM fighter_documents d WHERE d.fighter_id = f.id) AS document_type
         FROM fighters f WHERE f.club_id = ? ORDER BY f.last_name, f.first_name`
      )
      .all(clubId),
    competitions: db.prepare("SELECT * FROM competitions WHERE status = 'open' ORDER BY event_date").all().filter(isRegistrationOpen),
    registrations: db
      .prepare(
        `SELECT r.status, comp.id AS competition_id, comp.name, comp.event_date, COUNT(*) AS n
         FROM registrations r JOIN competitions comp ON comp.id = r.competition_id
         WHERE r.club_id = ? GROUP BY comp.id, r.status ORDER BY comp.event_date`
      )
      .all(clubId),
  });
});

router.get('/fighters/new', (req, res) => {
  res.render('club/fighter_form', { title: 'Add fighter', fighter: {}, errors: [], action: '/club/fighters' });
});

router.post('/fighters', (req, res) => {
  const { values, errors } = readFighter(req.body);
  if (errors.length > 0) {
    return res.status(400).render('club/fighter_form', { title: 'Add fighter', fighter: values, errors, action: '/club/fighters' });
  }
  const { lastInsertRowid: fighterId } = req.app.locals.db
    .prepare(
      `INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank)
       VALUES (@club_id, @first_name, @last_name, @gender, @date_of_birth, @belt_rank)`
    )
    .run({ ...values, club_id: req.user.club_id });
  req.logActivity('athlete.added', `Added ${values.first_name} ${values.last_name} to ${req.user.club_name}`);
  const label = documentLabel(documentTypeFor(values.belt_rank));
  req.flash('success', `${values.first_name} ${values.last_name} added. Now upload their ${label}, which they need to enter competitions.`);
  return res.redirect(`/club/fighters/${fighterId}/document`);
});

// Approval was based on the stored document, so it can't be swapped afterwards.
// Athletes approved before they had one can still add it.
function documentLocked(db, fighterId) {
  return hasApprovedRegistration(db, fighterId) && Boolean(db.prepare('SELECT 1 FROM fighter_documents WHERE fighter_id = ?').get(fighterId));
}

function documentPage(req, res, fighter, status = 200, error = null) {
  const document = getFighterDocument(req.app.locals.db, fighter.id);
  return res.status(status).render('club/document', {
    title: 'Athlete document',
    fighter,
    label: documentLabel(documentTypeFor(fighter.belt_rank)),
    document,
    locked: documentLocked(req.app.locals.db, fighter.id),
    error,
  });
}

router.get('/fighters/:id(\\d+)/document', (req, res) => {
  const fighter = ownFighter(req, req.params.id);
  if (!fighter) return notFound(res);
  return documentPage(req, res, fighter);
});

router.get('/fighters/:id(\\d+)/document/file', (req, res) => {
  const fighter = ownFighter(req, req.params.id);
  const document = fighter && getFighterDocument(req.app.locals.db, fighter.id);
  if (!document) return notFound(res);
  return sendDocument(res, document);
});

router.post('/fighters/:id(\\d+)/document', (req, res) => {
  const { db } = req.app.locals;
  const fighter = ownFighter(req, req.params.id);
  if (!fighter) return notFound(res);
  if (documentLocked(db, fighter.id)) {
    return documentPage(req, res, fighter, 400, 'This athlete has an approved registration, so their document is locked. Ask the organiser if it needs changing.');
  }
  if (req.uploadError) return documentPage(req, res, fighter, 400, req.uploadError);
  if (!req.file) return documentPage(req, res, fighter, 400, 'Choose a file to upload.');
  const type = detectFileType(req.file.buffer);
  if (!type) return documentPage(req, res, fighter, 400, 'That file type is not accepted. Upload a JPG, PNG, WebP or PDF.');

  saveFighterDocument(db, fighter, { data: req.file.buffer, contentType: type.contentType, userId: req.user.id });
  const label = documentLabel(documentTypeFor(fighter.belt_rank));
  req.logActivity('document.uploaded', `Uploaded the ${label} for ${fighter.first_name} ${fighter.last_name} (${req.user.club_name})`);
  req.flash('success', `${label[0].toUpperCase()}${label.slice(1)} saved for ${fighter.first_name} ${fighter.last_name}.`);
  return res.redirect('/club');
});

router.get('/fighters/:id(\\d+)/edit', (req, res) => {
  const fighter = ownFighter(req, req.params.id);
  if (!fighter) return notFound(res);
  if (hasActiveRegistration(req.app.locals.db, fighter.id)) {
    req.flash('error', 'This fighter has an active registration. Withdraw it before editing, so their division stays correct.');
    return res.redirect('/club');
  }
  return res.render('club/fighter_form', {
    title: 'Edit fighter',
    fighter,
    errors: [],
    action: `/club/fighters/${fighter.id}`,
  });
});

router.post('/fighters/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const fighter = ownFighter(req, req.params.id);
  if (!fighter) return notFound(res);
  if (hasActiveRegistration(db, fighter.id)) {
    req.flash('error', 'This fighter has an active registration. Withdraw it before editing, so their division stays correct.');
    return res.redirect('/club');
  }
  const { values, errors } = readFighter(req.body);
  if (errors.length > 0) {
    return res.status(400).render('club/fighter_form', {
      title: 'Edit fighter',
      fighter: values,
      errors,
      action: `/club/fighters/${fighter.id}`,
    });
  }
  db.prepare(
    `UPDATE fighters SET first_name = @first_name, last_name = @last_name, gender = @gender,
       date_of_birth = @date_of_birth, belt_rank = @belt_rank WHERE id = @id`
  ).run({ ...values, id: fighter.id });
  req.logActivity('athlete.updated', `Updated ${values.first_name} ${values.last_name} (${req.user.club_name})`);
  // A grading card can't prove a black belt, or the other way round.
  if (documentTypeFor(values.belt_rank) !== documentTypeFor(fighter.belt_rank)) {
    db.prepare('DELETE FROM fighter_documents WHERE fighter_id = ?').run(fighter.id);
    req.flash('success', `Fighter updated. Their new belt needs a ${documentLabel(documentTypeFor(values.belt_rank))}, so please upload one.`);
    return res.redirect(`/club/fighters/${fighter.id}/document`);
  }
  req.flash('success', 'Fighter updated.');
  return res.redirect('/club');
});

router.post('/fighters/:id(\\d+)/delete', (req, res) => {
  const { db } = req.app.locals;
  const fighter = ownFighter(req, req.params.id);
  if (!fighter) return notFound(res);
  if (db.prepare('SELECT 1 FROM registrations WHERE fighter_id = ? LIMIT 1').get(fighter.id)) {
    req.flash('error', 'This fighter has registration history and cannot be removed.');
  } else {
    db.prepare('DELETE FROM fighters WHERE id = ?').run(fighter.id);
    req.logActivity('athlete.removed', `Removed ${fighter.first_name} ${fighter.last_name} from ${req.user.club_name}`);
    req.flash('success', 'Fighter removed.');
  }
  return res.redirect('/club');
});

function competitionForClub(req) {
  const competition = req.app.locals.db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  return competition && competition.status !== 'draft' ? competition : null;
}

router.get('/competitions/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const competition = competitionForClub(req);
  if (!competition) return notFound(res);

  const registrations = db
    .prepare(`${REGISTRATION_SELECT} WHERE r.competition_id = ? AND r.club_id = ? ORDER BY f.last_name, f.first_name`)
    .all(competition.id, req.user.club_id);
  const setup = loadDivisionSetup(db, competition.id);
  const active = new Set(registrations.filter((r) => r.status !== 'rejected').map((r) => r.fighter_id));
  const available = db
    .prepare('SELECT * FROM fighters WHERE club_id = ? ORDER BY last_name, first_name')
    .all(req.user.club_id)
    .filter((f) => !active.has(f.id))
    .map((f) => ({
      ...f,
      age: competitionAge(f.date_of_birth, competition.event_date, competition.age_basis),
      options: divisionOptions({ fighter: f, competition, ...setup }),
      lastClassId: (registrations.find((r) => r.fighter_id === f.id) || {}).weight_class_id,
      hasDocument: Boolean(db.prepare('SELECT 1 FROM fighter_documents WHERE fighter_id = ?').get(f.id)),
    }));

  return res.render('club/enter', {
    title: competition.name,
    competition,
    registrations,
    available,
    open: isRegistrationOpen(competition),
  });
});

router.post('/competitions/:id(\\d+)/enter', (req, res) => {
  const { db } = req.app.locals;
  const competition = competitionForClub(req);
  if (!competition) return notFound(res);
  const back = `/club/competitions/${competition.id}`;

  if (!isRegistrationOpen(competition)) {
    req.flash('error', 'Registration for this competition is closed.');
    return res.redirect(back);
  }

  const fighterIds = toArray(req.body.fighter_ids);
  if (fighterIds.length === 0) {
    req.flash('error', 'Select at least one fighter.');
    return res.redirect(back);
  }

  let entered = 0;
  fighterIds.forEach((id) => {
    const fighter = ownFighter(req, id);
    if (!fighter) return;
    const result = enterFighter(db, competition, fighter, req.body[`weight_class_${fighter.id}`]);
    if (result.ok) {
      entered += 1;
      req.logActivity(
        'registration.entered',
        `Entered ${fighter.first_name} ${fighter.last_name} (${req.user.club_name}) in ${result.placement.weightClass.label}: ${competition.name}`,
        competition.id
      );
    } else {
      req.flash('error', `${fighter.first_name} ${fighter.last_name}: ${result.error}`);
    }
  });
  if (entered > 0) req.flash('success', `${entered} fighter${entered === 1 ? '' : 's'} submitted for approval.`);
  return res.redirect(back);
});

router.post('/competitions/:id(\\d+)/withdraw/:regId(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const entry = db
    .prepare(
      `SELECT f.first_name, f.last_name, c.name AS competition FROM registrations r
       JOIN fighters f ON f.id = r.fighter_id JOIN competitions c ON c.id = r.competition_id WHERE r.id = ?`
    )
    .get(req.params.regId);
  const result = db
    .prepare("DELETE FROM registrations WHERE id = ? AND competition_id = ? AND club_id = ? AND status != 'approved'")
    .run(req.params.regId, req.params.id, req.user.club_id);
  if (result.changes > 0) {
    req.logActivity(
      'registration.withdrawn',
      `Withdrew ${entry.first_name} ${entry.last_name} (${req.user.club_name}) from ${entry.competition}`,
      Number(req.params.id)
    );
    req.flash('success', 'Registration withdrawn.');
  } else {
    req.flash('error', 'That registration cannot be withdrawn. Approved fighters must be released by the organiser.');
  }
  return res.redirect(`/club/competitions/${req.params.id}`);
});

function publishedCompetition(req) {
  const competition = competitionForClub(req);
  return competition && competition.bouts_published_at ? competition : null;
}

// Coaches see the divisions their club has athletes in, plus overall medals.
function clubDivisions(req, competition) {
  const all = loadBoutList(req.app.locals.db, competition.id);
  const mine = all.filter((division) =>
    division.bouts.some((b) => [b.blue, b.red].some((s) => s && s.clubId === req.user.club_id))
  );
  return { all, mine };
}

router.get('/competitions/:id(\\d+)/bouts', (req, res) => {
  const competition = publishedCompetition(req);
  if (!competition) return notFound(res);
  const { all, mine } = clubDivisions(req, competition);
  return res.render('club/bouts', {
    title: 'Bout list',
    competition,
    athletes: clubAthleteSummary(mine, req.user.club_id),
    divisions: mine.map((division) => ({ ...division, layout: layoutBracket(division.bouts, { slotHeight: 30, top: 4 }) })),
    medals: computeMedals(all),
    highlightClubId: req.user.club_id,
  });
});

router.get('/competitions/:id(\\d+)/bouts.pdf', (req, res) => {
  const competition = publishedCompetition(req);
  if (!competition) return notFound(res);
  const { mine } = clubDivisions(req, competition);
  if (mine.length === 0) return notFound(res);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bout-list-competition-${competition.id}.pdf"`);
  return writeBoutListPdf(res, {
    competition,
    divisions: mine,
    dateLabel: formatEventDates(getEventDates(req.app.locals.db, competition.id)),
  });
});

module.exports = router;
