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
  saveClubIcon,
  deleteClubIcon,
  hasEntryHistory,
  listPoomsaeEntries,
  enterPoomsae,
  withdrawPoomsae,
  poomsaeDivisions,
  loadPoomsaeBrackets,
  loadPoomsaeSettings,
  poomsaeBoutList,
  REGISTRATION_SELECT,
} = require('../services');
const { POOMSAE_EVENTS, hasKyorugi, hasPoomsae, placeEntry, entryResult } = require('../poomsae');
const { documentLabel, documentTypeFor, detectFileType, detectIconType, sendDocument } = require('../documents');
const { layoutBracket, computeMedals, clubAthleteSummary } = require('../bracket');
const { writeBoutListPdf } = require('../boutlistPdf');
const { clean, toArray, requireRole, notFound, wrap } = require('./helpers');
const { COLUMNS, MAX_IMPORT_ROWS, ImportError, readRows, previewImport, templateXlsx, templateCsv } = require('../athleteImport');

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
  res.render('club/fighter_form', { title: 'Add athlete', fighter: {}, errors: [], action: '/club/fighters' });
});

router.post('/fighters', (req, res) => {
  const { values, errors } = readFighter(req.body);
  if (errors.length > 0) {
    return res.status(400).render('club/fighter_form', { title: 'Add athlete', fighter: values, errors, action: '/club/fighters' });
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

function iconPage(req, res, status = 200, error = null) {
  return res.status(status).render('club/icon', {
    title: 'Club icon',
    hasIcon: Boolean(res.locals.clubIconUrl(req.user.club_id)),
    error,
  });
}

router.get('/icon', (req, res) => iconPage(req, res));

router.post('/icon', (req, res) => {
  if (req.uploadError) return iconPage(req, res, 400, req.uploadError);
  if (!req.file) return iconPage(req, res, 400, 'Choose a picture to upload.');
  const type = detectIconType(req.file.buffer);
  if (!type) return iconPage(req, res, 400, 'That file type is not accepted. Upload a JPG, PNG or WebP picture.');
  saveClubIcon(req.app.locals.db, req.user.club_id, { data: req.file.buffer, contentType: type.contentType, userId: req.user.id });
  req.logActivity('club.icon_updated', `Updated the icon for ${req.user.club_name}`);
  req.flash('success', 'Club icon saved.');
  return res.redirect('/club');
});

router.post('/icon/delete', (req, res) => {
  if (deleteClubIcon(req.app.locals.db, req.user.club_id)) {
    req.logActivity('club.icon_removed', `Removed the icon for ${req.user.club_name}`);
    req.flash('success', 'Club icon removed.');
  }
  return res.redirect('/club');
});

function clubAthletes(req) {
  return req.app.locals.db.prepare('SELECT first_name, last_name, date_of_birth FROM fighters WHERE club_id = ?').all(req.user.club_id);
}

function importPage(res, status = 200, error = null) {
  return res.status(status).render('club/import', { title: 'Import athletes', error, maxRows: MAX_IMPORT_ROWS });
}

router.get('/fighters/import', (req, res) => importPage(res));

router.get('/fighters/import/template.xlsx', wrap(async (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="athlete-import-template.xlsx"');
  res.send(await templateXlsx());
}));

router.get('/fighters/import/template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="athlete-import-template.csv"');
  res.send(templateCsv());
});

// Step 1: read the sheet and show what would be imported. Nothing is saved yet.
router.post('/fighters/import', wrap(async (req, res) => {
  if (req.uploadError) return importPage(res, 400, req.uploadError);
  if (!req.file) return importPage(res, 400, 'Choose an .xlsx or .csv file to upload.');
  let preview;
  try {
    preview = previewImport(await readRows(req.file.buffer), { existing: clubAthletes(req), todayIso: today() });
  } catch (error) {
    if (error instanceof ImportError) return importPage(res, 400, error.message);
    throw error;
  }
  return res.render('club/import_preview', {
    title: 'Check the import',
    entries: preview.entries,
    readyCount: preview.ready.length,
    readyJson: JSON.stringify(preview.ready),
  });
}));

// Step 2: save the rows the coach confirmed. They come back from the browser,
// so they go through the same checks again, against the club's current list.
router.post('/fighters/import/confirm', (req, res) => {
  const { db } = req.app.locals;
  let submitted;
  try {
    submitted = JSON.parse(req.body.rows || '[]');
  } catch {
    submitted = null;
  }
  if (!Array.isArray(submitted) || submitted.length === 0 || submitted.length > MAX_IMPORT_ROWS) {
    req.flash('error', 'Nothing was imported. Upload the sheet again.');
    return res.redirect('/club/fighters/import');
  }
  const rows = [
    COLUMNS.map((c) => c.title),
    ...submitted.map((a) => [a && a.first_name, a && a.last_name, a && a.gender, a && a.date_of_birth, a && String(a.belt_rank)].map((v) => (typeof v === 'string' ? v : ''))),
  ];
  let ready;
  try {
    ({ ready } = previewImport(rows, { existing: clubAthletes(req), todayIso: today() }));
  } catch {
    ready = [];
  }
  const insert = db.prepare(
    `INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank)
     VALUES (@club_id, @first_name, @last_name, @gender, @date_of_birth, @belt_rank)`
  );
  db.transaction(() => ready.forEach((athlete) => insert.run({ ...athlete, club_id: req.user.club_id })))();

  const skipped = submitted.length - ready.length;
  if (ready.length === 0) {
    req.flash('error', 'No athletes were imported. They are already in your club, or the rows were not valid.');
    return res.redirect('/club');
  }
  const plural = (n) => `${n} athlete${n === 1 ? '' : 's'}`;
  req.logActivity('athlete.imported', `Imported ${plural(ready.length)} into ${req.user.club_name} from a spreadsheet`);
  req.flash(
    'success',
    `${plural(ready.length)} imported${skipped > 0 ? `, ${skipped} skipped because they were already added or not valid` : ''}. Upload each athlete's grading card or black belt certificate before entering them in a competition.`
  );
  return res.redirect('/club');
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
    req.flash('error', 'This athlete has an active registration. Withdraw it before editing, so their division stays correct.');
    return res.redirect('/club');
  }
  return res.render('club/fighter_form', {
    title: 'Edit athlete',
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
    req.flash('error', 'This athlete has an active registration. Withdraw it before editing, so their division stays correct.');
    return res.redirect('/club');
  }
  const { values, errors } = readFighter(req.body);
  if (errors.length > 0) {
    return res.status(400).render('club/fighter_form', {
      title: 'Edit athlete',
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
    req.flash('success', `Athlete updated. Their new belt needs a ${documentLabel(documentTypeFor(values.belt_rank))}, so please upload one.`);
    return res.redirect(`/club/fighters/${fighter.id}/document`);
  }
  req.flash('success', 'Athlete updated.');
  return res.redirect('/club');
});

router.post('/fighters/:id(\\d+)/delete', (req, res) => {
  const { db } = req.app.locals;
  const fighter = ownFighter(req, req.params.id);
  if (!fighter) return notFound(res);
  if (hasEntryHistory(db, fighter.id)) {
    req.flash('error', 'This athlete has registration history and cannot be removed.');
  } else {
    db.prepare('DELETE FROM fighters WHERE id = ?').run(fighter.id);
    req.logActivity('athlete.removed', `Removed ${fighter.first_name} ${fighter.last_name} from ${req.user.club_name}`);
    req.flash('success', 'Athlete removed.');
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
  if (!hasKyorugi(competition)) return res.redirect(`/club/competitions/${competition.id}/poomsae`);

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
  if (entered > 0) req.flash('success', `${entered} athlete${entered === 1 ? '' : 's'} submitted for approval.`);
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
    req.flash('error', 'That registration cannot be withdrawn. Approved athletes must be released by the organiser.');
  }
  return res.redirect(`/club/competitions/${req.params.id}`);
});

const poomsaePath = (competition) => `/club/competitions/${competition.id}/poomsae`;

function poomsaeCompetition(req) {
  const competition = competitionForClub(req);
  return competition && hasPoomsae(competition) ? competition : null;
}

router.get('/competitions/:id(\\d+)/poomsae', (req, res) => {
  const { db } = req.app.locals;
  const competition = poomsaeCompetition(req);
  if (!competition) return notFound(res);
  const setup = loadDivisionSetup(db, competition.id);
  const athletes = db
    .prepare(
      `SELECT f.*, EXISTS (SELECT 1 FROM fighter_documents d WHERE d.fighter_id = f.id) AS has_document
       FROM fighters f WHERE f.club_id = ? ORDER BY f.last_name, f.first_name`
    )
    .all(req.user.club_id)
    .map((f) => ({
      ...f,
      age: competitionAge(f.date_of_birth, competition.event_date, competition.age_basis),
      fits: placeEntry({ event: 'individual', members: [f], competition, ageGroups: setup.poomsaeAgeGroups, beltGroups: setup.beltGroups }),
    }));
  const entries = listPoomsaeEntries(db, competition.id, { clubId: req.user.club_id });
  // Places need every club's scores, but only this club's entries are listed. Like
  // the kyorugi bout list, the orders and brackets of the club's divisions show
  // once the admin publishes them.
  const everyone = listPoomsaeEntries(db, competition.id);
  const divisions = poomsaeDivisions(everyone, competition, loadPoomsaeBrackets(db, competition.id, everyone), loadPoomsaeSettings(db, competition.id));
  const divisionOf = new Map(divisions.flatMap((d) => d.entries.map((e) => [e.id, d])));
  const ranked = new Map(divisions.flatMap((d) => d.entries).map((e) => [e.id, e]));
  const inEvent = (event) => new Set(entries.filter((e) => e.event === event && e.status !== 'rejected').flatMap((e) => e.athletes.map((a) => a.id)));
  return res.render('club/poomsae', {
    title: `${competition.name}: poomsae`,
    competition,
    athletes,
    free: Object.fromEntries(Object.keys(POOMSAE_EVENTS).map((event) => {
      const taken = inEvent(event);
      return [event, athletes.filter((a) => a.has_document && a.fits.ok && !taken.has(a.id))];
    })),
    entries: entries.map((e) => {
      const division = divisionOf.get(e.id);
      return { ...e, result: division ? entryResult(ranked.get(e.id), division) : '' };
    }),
    pages: competition.poomsae_published_at ? poomsaeBoutList(db, competition, { clubId: req.user.club_id }) : [],
    open: isRegistrationOpen(competition),
  });
});

router.get('/competitions/:id(\\d+)/poomsae.pdf', (req, res) => {
  const { db } = req.app.locals;
  const competition = poomsaeCompetition(req);
  if (!competition || !competition.poomsae_published_at) return notFound(res);
  const pages = poomsaeBoutList(db, competition, { clubId: req.user.club_id });
  if (pages.length === 0) return notFound(res);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="poomsae-list-competition-${competition.id}.pdf"`);
  return writeBoutListPdf(res, { competition, divisions: pages, dateLabel: formatEventDates(getEventDates(db, competition.id)) });
});

router.post('/competitions/:id(\\d+)/poomsae/enter', (req, res) => {
  const { db } = req.app.locals;
  const competition = poomsaeCompetition(req);
  if (!competition) return notFound(res);
  if (!isRegistrationOpen(competition)) {
    req.flash('error', 'Registration for this competition is closed.');
    return res.redirect(poomsaePath(competition));
  }
  const event = POOMSAE_EVENTS[req.body.event] ? req.body.event : null;
  if (!event) return notFound(res);
  // Individuals are ticked in a list, each its own entry. A pair or team is one entry.
  const groups = event === 'individual'
    ? toArray(req.body.fighter_ids).map((id) => [id])
    : [toArray(req.body.member).filter(Boolean)];
  if (groups.length === 0 || groups[0].length === 0) {
    req.flash('error', event === 'individual' ? 'Select at least one athlete.' : `Choose the athletes for the ${event}.`);
    return res.redirect(poomsaePath(competition));
  }
  let entered = 0;
  groups.forEach((ids) => {
    const fighters = ids.map((id) => ownFighter(req, id));
    if (fighters.some((f) => !f)) return;
    const result = enterPoomsae(db, competition, req.user.club_id, event, fighters);
    const names = fighters.map((f) => `${f.first_name} ${f.last_name}`).join(', ');
    if (result.ok) {
      entered += 1;
      req.logActivity('poomsae.entered', `Entered ${names} (${req.user.club_name}) in poomsae ${event}: ${competition.name}`, competition.id);
    } else {
      req.flash('error', `${names || POOMSAE_EVENTS[event].label}: ${result.error}`);
    }
  });
  if (entered > 0) req.flash('success', `${entered} ${event} entr${entered === 1 ? 'y' : 'ies'} submitted for approval.`);
  return res.redirect(poomsaePath(competition));
});

router.post('/competitions/:id(\\d+)/poomsae/:entryId(\\d+)/withdraw', (req, res) => {
  const { db } = req.app.locals;
  const competition = poomsaeCompetition(req);
  if (!competition) return notFound(res);
  const entry = listPoomsaeEntries(db, competition.id, { clubId: req.user.club_id }).find((e) => e.id === Number(req.params.entryId));
  if (entry && withdrawPoomsae(db, competition.id, req.user.club_id, entry.id)) {
    req.logActivity('poomsae.withdrawn', `Withdrew the poomsae ${entry.event} entry of ${entry.names} (${req.user.club_name}) from ${competition.name}`, competition.id);
    req.flash('success', 'Entry withdrawn.');
  } else {
    req.flash('error', 'That entry cannot be withdrawn. Approved entries must be released by the organiser.');
  }
  return res.redirect(poomsaePath(competition));
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
