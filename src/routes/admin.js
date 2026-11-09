const express = require('express');
const {
  beltName,
  GENDERS,
  DEFAULT_BELT_GROUPS,
  isValidDate,
  formatEventDates,
  formatDay,
  formatWeightLimits,
  validateSetup,
} = require('../divisions');
const {
  loadDivisionSetup,
  countRegistrations,
  saveDivisionSetup,
  getEventDates,
  saveEventDates,
  createCompetition,
  deadlinePassed,
  hasBoutList,
  deleteBoutList,
  generateBoutList,
  applySchedule,
  loadDivisionDays,
  saveDivisionDays,
  loadBoutList,
  hasResults,
  recordResult,
  clearResult,
  clearAllResults,
  getFighterDocument,
  listWeighIns,
  weighInCounts,
  recordWeighIn,
  saveCompetitionLogo,
  hasCompetitionLogo,
  listCompetitionFiles,
  getCompetitionFile,
  addCompetitionFile,
  deleteCompetitionFile,
  REGISTRATION_SELECT,
  DIVISION_ORDER,
} = require('../services');
const { sendDocument, detectIconType, detectAttachmentType, safeFilename, MAX_ICON_BYTES, MAX_NEW_COMPETITION_FILES } = require('../documents');
const { ACTIVITY_CATEGORIES, listActivity, countActivity, formatActivityTime } = require('../activity');
const { notifyRegistrationDecisions, notifyBoutListPublished } = require('../notifications');
const { layoutBracket, computeMedals } = require('../bracket');
const { writeBoutListPdf } = require('../boutlistPdf');
const { clean, toArray, requireRole, notFound } = require('./helpers');

const router = express.Router();
router.use(requireRole('admin'));

const FILTER_KEYS = ['status', 'club', 'gender', 'age', 'belt', 'weight'];

const MAX_EVENT_DAYS = 14;

// lockedFirstDay is set once registrations exist, because ages are calculated
// from the first day. Later days can still be added or removed.
function readCompetition(body, lockedFirstDay = null) {
  const entered = toArray(body.event_dates).map((value) => clean(value, 10)).filter(Boolean);
  const eventDates = [...new Set([...(lockedFirstDay ? [lockedFirstDay] : []), ...entered])].sort();
  const values = {
    name: clean(body.name),
    event_dates: eventDates,
    event_date: eventDates[0] || '',
    registration_deadline: clean(body.registration_deadline, 10),
    registration_deadline_time: clean(body.registration_deadline_time, 5) || '23:59',
    venue: clean(body.venue),
    description: typeof body.description === 'string' ? body.description.replace(/\r\n?/g, '\n').trim().slice(0, 5000) : '',
    age_basis: body.age_basis === 'date' ? 'date' : 'year',
  };
  const errors = [];
  if (!values.name) errors.push('Enter a competition name.');
  if (!values.venue) errors.push('Enter a venue.');
  if (!values.description) errors.push('Enter a description for clubs.');
  if (eventDates.length === 0) errors.push('Enter at least one event date.');
  if (!eventDates.every(isValidDate)) errors.push('Enter valid event dates.');
  if (eventDates.length > MAX_EVENT_DAYS) errors.push(`A competition can have at most ${MAX_EVENT_DAYS} days.`);
  if (lockedFirstDay && values.event_date !== lockedFirstDay) {
    errors.push('Clubs have registered, so no event date can be earlier than the first day.');
  }
  if (!isValidDate(values.registration_deadline)) errors.push('Enter a valid registration deadline.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.registration_deadline_time)) errors.push('Enter a valid deadline time.');
  if (errors.length === 0 && values.registration_deadline > values.event_date) {
    errors.push('The registration deadline must be on or before the first event date.');
  }
  return { values, errors };
}

function loadCompetition(req, res, next) {
  const competition = req.app.locals.db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!competition) return notFound(res);
  req.competition = competition;
  return next();
}

router.get('/', (req, res) => {
  const competitions = req.app.locals.db
    .prepare(
      `SELECT comp.*,
         SUM(r.status = 'pending') AS pending,
         SUM(r.status = 'approved') AS approved,
         SUM(r.status = 'rejected') AS rejected
       FROM competitions comp LEFT JOIN registrations r ON r.competition_id = comp.id
       GROUP BY comp.id ORDER BY comp.status = 'closed', comp.event_date`
    )
    .all();
  res.render('admin/dashboard', {
    title: 'Admin dashboard',
    competitions,
    pendingCoaches: req.app.locals.db.prepare("SELECT COUNT(*) AS n FROM club_applications WHERE status = 'pending'").get().n,
  });
});

router.get('/competitions/new', (req, res) => {
  res.render('admin/comp_form', {
    title: 'New competition',
    competition: { age_basis: 'year' },
    errors: [],
    action: '/admin/competitions',
    locked: false,
  });
});

// The new-competition form's optional logo and attachments, checked before
// anything is saved. Browsers send an empty part when no file is chosen.
function readNewCompetitionFiles(req) {
  const chosen = (name) => ((req.files && req.files[name]) || []).filter((f) => f.size > 0 && f.originalname);
  const errors = req.uploadError ? [req.uploadError] : [];
  let logo = null;
  const [logoFile] = chosen('logo');
  if (logoFile) {
    const type = detectIconType(logoFile.buffer);
    if (logoFile.size > MAX_ICON_BYTES) errors.push('The logo is over the 1 MB limit.');
    else if (!type) errors.push('The logo must be a JPG, PNG or WebP picture.');
    else logo = { data: logoFile.buffer, contentType: type.contentType };
  }
  const attachments = [];
  chosen('files').forEach((file) => {
    const type = detectAttachmentType(file.buffer, file.originalname);
    if (!type) {
      errors.push(`${file.originalname} is not an accepted file type. Attach PDF, Word (.docx), Excel (.xlsx), JPG, PNG or WebP files.`);
      return;
    }
    const filename = safeFilename(file.originalname, type.extension);
    attachments.push({ title: filename.replace(/\.[^.]*$/, ''), filename, contentType: type.contentType, data: file.buffer });
  });
  return { logo, attachments, errors, anyChosen: Boolean(logoFile) || chosen('files').length > 0 };
}

router.post('/competitions', (req, res) => {
  const { db } = req.app.locals;
  const { values, errors } = readCompetition(req.body || {});
  const uploads = readNewCompetitionFiles(req);
  const allErrors = [...errors, ...uploads.errors];
  if (allErrors.length > 0) {
    // Browsers can't refill file fields, so the admin has to choose them again.
    if (uploads.anyChosen) allErrors.push('Nothing was saved, so choose the logo and files again.');
    return res.status(400).render('admin/comp_form', {
      title: 'New competition',
      competition: values,
      errors: allErrors,
      action: '/admin/competitions',
      locked: false,
    });
  }
  const id = db.transaction(() => {
    const newId = createCompetition(db, values);
    if (uploads.logo) saveCompetitionLogo(db, newId, uploads.logo);
    uploads.attachments.forEach((file) => addCompetitionFile(db, newId, { ...file, userId: req.user.id }));
    return newId;
  })();
  req.logActivity('competition.created', `Created competition ${values.name}`, id);
  if (uploads.logo) req.logActivity('competition.logo', `Updated the logo for ${values.name}`, id);
  uploads.attachments.forEach((file) => req.logActivity('competition.file_added', `Attached ${file.title} to ${values.name}`, id));

  const added = [uploads.logo && 'the logo', uploads.attachments.length > 0 && `${uploads.attachments.length} file${uploads.attachments.length === 1 ? '' : 's'}`].filter(Boolean);
  req.flash(
    'success',
    `Competition created as a draft${added.length > 0 ? ` with ${added.join(' and ')}` : ''}. ${uploads.logo ? 'Check the files and divisions' : 'Upload its logo, check the divisions'}, then publish it.`
  );
  return res.redirect(`/admin/competitions/${id}/files`);
});

router.use('/competitions/:id(\\d+)', loadCompetition);

router.get('/competitions/:id(\\d+)/edit', (req, res) => {
  res.render('admin/comp_form', {
    title: 'Edit competition',
    competition: { ...req.competition, event_dates: getEventDates(req.app.locals.db, req.competition.id) },
    errors: [],
    action: `/admin/competitions/${req.competition.id}`,
    locked: countRegistrations(req.app.locals.db, req.competition.id) > 0,
  });
});

router.post('/competitions/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const locked = countRegistrations(db, req.competition.id) > 0;
  const { values, errors } = readCompetition(
    // Age placement depends on the first day and age rule, so they can't change after entries exist.
    { ...req.body, ...(locked ? { age_basis: req.competition.age_basis } : {}) },
    locked ? req.competition.event_date : null
  );
  if (errors.length > 0) {
    return res.status(400).render('admin/comp_form', {
      title: 'Edit competition',
      competition: { ...req.competition, ...values },
      errors,
      action: `/admin/competitions/${req.competition.id}`,
      locked,
    });
  }
  const { event_dates: eventDates, ...fields } = values;
  const getEventDatesBefore = getEventDates(db, req.competition.id);
  const deadlineMoved =
    values.registration_deadline !== req.competition.registration_deadline ||
    values.registration_deadline_time !== req.competition.registration_deadline_time;
  db.transaction(() => {
    // A new deadline earns coaches a new reminder.
    if (deadlineMoved) db.prepare('UPDATE competitions SET reminder_sent_at = NULL WHERE id = ?').run(req.competition.id);
    db.prepare(
      `UPDATE competitions SET name = @name, registration_deadline = @registration_deadline,
         registration_deadline_time = @registration_deadline_time, venue = @venue, description = @description, age_basis = @age_basis WHERE id = @id`
    ).run({ ...fields, id: req.competition.id });
    saveEventDates(db, req.competition.id, eventDates);
    // Keeps the draw, but moves bouts onto the new list of days.
    if (hasBoutList(db, req.competition.id)) applySchedule(db, req.competition.id);
  })();
  const changes = [];
  if (values.name !== req.competition.name) changes.push(`name to ${values.name}`);
  if (values.venue !== req.competition.venue) changes.push(`venue to ${values.venue}`);
  const oldDates = getEventDatesBefore.join(', ');
  if (eventDates.join(', ') !== oldDates) changes.push(`dates from ${oldDates} to ${eventDates.join(', ')}`);
  if (deadlineMoved) {
    changes.push(`deadline from ${req.competition.registration_deadline} ${req.competition.registration_deadline_time} to ${values.registration_deadline} ${values.registration_deadline_time}`);
  }
  req.logActivity(
    'competition.updated',
    `Updated ${req.competition.name}${changes.length > 0 ? `: ${changes.join('; ')}` : ''}`,
    req.competition.id
  );
  req.flash('success', 'Competition updated.');
  return res.redirect('/admin');
});

router.post('/competitions/:id(\\d+)/status', (req, res) => {
  const status = req.body.status;
  if (!['draft', 'open', 'closed'].includes(status)) return notFound(res);
  const { db } = req.app.locals;
  if (status === 'draft' && countRegistrations(db, req.competition.id) > 0) {
    req.flash('error', 'A competition with registrations cannot go back to draft. Close it instead.');
    return res.redirect('/admin');
  }
  if (status !== 'closed' && hasBoutList(db, req.competition.id)) {
    req.flash('error', 'Delete the bout list before reopening registration.');
    return res.redirect('/admin');
  }
  if (status === 'open' && (!hasCompetitionLogo(db, req.competition.id) || !req.competition.description.trim())) {
    req.flash('error', `${req.competition.name} needs a logo and a description before clubs can register. Add them first.`);
    return res.redirect(hasCompetitionLogo(db, req.competition.id) ? `/admin/competitions/${req.competition.id}/edit` : filesPath(req.competition));
  }
  if (status === 'open' && deadlinePassed(req.competition)) {
    req.flash('error', 'The registration deadline has passed. Edit the competition to set a later deadline first.');
    return res.redirect('/admin');
  }
  db.prepare('UPDATE competitions SET status = ? WHERE id = ?').run(status, req.competition.id);
  const actions = { open: 'Opened registration for', closed: 'Closed registration for', draft: 'Moved to draft:' };
  req.logActivity('competition.status', `${actions[status]} ${req.competition.name}`, req.competition.id);
  const messages = {
    open: 'Competition published. Clubs can now register.',
    closed: 'Registration closed. You can now generate the bout list.',
    draft: 'Competition moved back to draft.',
  };
  req.flash('success', messages[status]);
  return res.redirect('/admin');
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

function filesPage(req, res, status = 200, error = null) {
  const { db } = req.app.locals;
  return res.status(status).render('admin/comp_files', {
    title: 'Logo and files',
    competition: req.competition,
    hasLogo: hasCompetitionLogo(db, req.competition.id),
    files: listCompetitionFiles(db, req.competition.id),
    error,
  });
}

const filesPath = (competition) => `/admin/competitions/${competition.id}/files`;

router.get('/competitions/:id(\\d+)/files', (req, res) => filesPage(req, res));

router.post('/competitions/:id(\\d+)/logo', (req, res) => {
  if (req.uploadError) return filesPage(req, res, 400, req.uploadError);
  if (!req.file) return filesPage(req, res, 400, 'Choose a logo to upload.');
  const type = detectIconType(req.file.buffer);
  if (!type) return filesPage(req, res, 400, 'The logo must be a JPG, PNG or WebP picture.');
  saveCompetitionLogo(req.app.locals.db, req.competition.id, { data: req.file.buffer, contentType: type.contentType });
  req.logActivity('competition.logo', `Updated the logo for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'Logo saved.');
  return res.redirect(filesPath(req.competition));
});

router.post('/competitions/:id(\\d+)/files', (req, res) => {
  if (req.uploadError) return filesPage(req, res, 400, req.uploadError);
  if (!req.file) return filesPage(req, res, 400, 'Choose a file to attach.');
  const type = detectAttachmentType(req.file.buffer, req.file.originalname);
  if (!type) return filesPage(req, res, 400, 'That file type is not accepted. Attach a PDF, Word (.docx), Excel (.xlsx), JPG, PNG or WebP file.');
  const filename = safeFilename(req.file.originalname, type.extension);
  const title = clean(req.body.title, 120) || filename.replace(/\.[^.]*$/, '');
  addCompetitionFile(req.app.locals.db, req.competition.id, { title, filename, contentType: type.contentType, data: req.file.buffer, userId: req.user.id });
  req.logActivity('competition.file_added', `Attached ${title} to ${req.competition.name}`, req.competition.id);
  req.flash('success', `${title} attached.`);
  return res.redirect(filesPath(req.competition));
});

router.post('/competitions/:id(\\d+)/files/:fileId(\\d+)/delete', (req, res) => {
  const { db } = req.app.locals;
  const file = getCompetitionFile(db, req.competition.id, req.params.fileId);
  if (file && deleteCompetitionFile(db, req.competition.id, file.id)) {
    req.logActivity('competition.file_removed', `Removed ${file.title} from ${req.competition.name}`, req.competition.id);
    req.flash('success', `${file.title} removed.`);
  }
  return res.redirect(filesPath(req.competition));
});

router.post('/competitions/:id(\\d+)/delete', (req, res) => {
  const { db } = req.app.locals;
  if (req.competition.status !== 'draft' || countRegistrations(db, req.competition.id) > 0) {
    req.flash('error', 'Only draft competitions without registrations can be deleted.');
  } else {
    db.prepare('DELETE FROM competitions WHERE id = ?').run(req.competition.id);
    req.logActivity('competition.deleted', `Deleted draft competition ${req.competition.name}`, req.competition.id);
    req.flash('success', 'Draft competition deleted.');
  }
  return res.redirect('/admin');
});

function setupRowsForForm(setup) {
  return setup.ageGroups.map((group) => {
    const classesFor = (gender) => setup.weightClasses.filter((c) => c.age_group_id === group.id && c.gender === gender);
    return {
      name: group.name,
      min_age: group.min_age,
      max_age: group.max_age,
      male: formatWeightLimits(classesFor('M')),
      female: formatWeightLimits(classesFor('F')),
    };
  });
}

function readSetup(body) {
  const names = toArray(body.age_name);
  const ageGroups = names
    .map((_, i) => ({
      name: clean(names[i], 60),
      min_age: Number(toArray(body.age_min)[i]),
      max_age: Number(toArray(body.age_max)[i]),
      minRaw: clean(toArray(body.age_min)[i]),
      maxRaw: clean(toArray(body.age_max)[i]),
      male: clean(toArray(body.age_male)[i], 500),
      female: clean(toArray(body.age_female)[i], 500),
    }))
    .filter((g) => g.name || g.minRaw || g.maxRaw || g.male || g.female);

  // Belt groups are fixed: Blue, Red and Black.
  return { ageGroups, beltGroups: DEFAULT_BELT_GROUPS };
}

router.get('/competitions/:id(\\d+)/setup', (req, res) => {
  const { db } = req.app.locals;
  const setup = loadDivisionSetup(db, req.competition.id);
  res.render('admin/setup', {
    title: 'Division setup',
    competition: req.competition,
    ageRows: setupRowsForForm(setup),
    beltRows: setup.beltGroups,
    errors: [],
    locked: countRegistrations(db, req.competition.id) > 0,
  });
});

router.post('/competitions/:id(\\d+)/setup', (req, res) => {
  const { db } = req.app.locals;
  if (countRegistrations(db, req.competition.id) > 0) {
    req.flash('error', 'Divisions are locked because clubs have already registered fighters.');
    return res.redirect(`/admin/competitions/${req.competition.id}/setup`);
  }
  const setup = readSetup(req.body);
  const errors = validateSetup(setup);
  if (errors.length > 0) {
    return res.status(400).render('admin/setup', {
      title: 'Division setup',
      competition: req.competition,
      ageRows: setup.ageGroups.map((g) => ({ ...g, min_age: g.minRaw, max_age: g.maxRaw })),
      beltRows: setup.beltGroups,
      errors,
      locked: false,
    });
  }
  saveDivisionSetup(db, req.competition.id, setup);
  req.logActivity('competition.divisions', `Changed the division setup for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'Divisions saved.');
  return res.redirect(`/admin/competitions/${req.competition.id}/setup`);
});

function pickFilters(source) {
  const filters = {};
  FILTER_KEYS.forEach((key) => {
    const value = clean(source[key], 20);
    if (value) filters[key] = value;
  });
  return filters;
}

router.get('/competitions/:id(\\d+)/registrations', (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  const filters = pickFilters(req.query);

  const where = ['r.competition_id = @competition'];
  const params = { competition: competition.id };
  const columns = {
    status: 'r.status',
    club: 'r.club_id',
    gender: 'f.gender',
    age: 'r.age_group_id',
    belt: 'r.belt_group_id',
    weight: 'r.weight_class_id',
  };
  Object.entries(filters).forEach(([key, value]) => {
    where.push(`${columns[key]} = @${key}`);
    params[key] = value;
  });

  res.render('admin/registrations', {
    title: 'Registrations',
    competition,
    filters,
    query: new URLSearchParams(filters).toString(),
    registrations: db
      .prepare(`${REGISTRATION_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.status = 'pending' DESC, ${DIVISION_ORDER}`)
      .all(params),
    setup: loadDivisionSetup(db, competition.id),
    clubs: db
      .prepare(
        `SELECT DISTINCT c.id, c.name FROM clubs c JOIN registrations r ON r.club_id = c.id
         WHERE r.competition_id = ? ORDER BY c.name`
      )
      .all(competition.id),
    counts: db
      .prepare('SELECT status, COUNT(*) AS n FROM registrations WHERE competition_id = ? GROUP BY status')
      .all(competition.id)
      .reduce((all, row) => ({ ...all, [row.status]: row.n }), { pending: 0, approved: 0, rejected: 0 }),
  });
});

router.post('/competitions/:id(\\d+)/registrations/review', (req, res) => {
  const { db } = req.app.locals;
  const competitionId = req.competition.id;
  const returnFilters = pickFilters(Object.fromEntries(new URLSearchParams(clean(req.body.qs, 300))));
  const query = new URLSearchParams(returnFilters).toString();
  const back = `/admin/competitions/${competitionId}/registrations${query ? `?${query}` : ''}`;

  if (hasBoutList(db, competitionId)) {
    req.flash('error', 'Delete the bout list before changing approvals, so the draw stays correct.');
    return res.redirect(back);
  }

  // Either one row's button ("approved:12") or a bulk action on the ticked rows.
  let decision;
  let ids;
  const single = clean(req.body.single, 40).match(/^(approved|rejected|pending):(\d+)$/);
  if (single) {
    [, decision] = single;
    ids = [single[2]];
  } else if (req.body.bulk === 'approved') {
    decision = 'approved';
    ids = toArray(req.body.ids);
  } else {
    req.flash('error', 'Choose an action.');
    return res.redirect(back);
  }
  if (ids.length === 0) {
    req.flash('error', 'Tick at least one registration first.');
    return res.redirect(back);
  }

  // Skips rows already in this state, so nobody is emailed about a non-change.
  const update = db.prepare(
    `UPDATE registrations SET status = @decision, review_note = @note, reviewed_at = datetime('now')
     WHERE id = @id AND competition_id = @competitionId AND status != @decision`
  );
  const changedIds = [];
  db.transaction(() => {
    ids.forEach((id) => {
      const note = clean(req.body[`note_${id}`], 300);
      if (decision === 'rejected' && !note) {
        req.flash('error', 'Add a reason when rejecting, so the club knows what to fix.');
        return;
      }
      const result = update.run({ decision, note: decision === 'approved' ? '' : note, id: Number(id), competitionId });
      if (result.changes > 0) changedIds.push(Number(id));
    });
  })();
  const changed = changedIds.length;
  changedIds.forEach((id) => {
    const row = db
      .prepare(
        `SELECT r.review_note, f.first_name, f.last_name, c.name AS club FROM registrations r
         JOIN fighters f ON f.id = r.fighter_id JOIN clubs c ON c.id = r.club_id WHERE r.id = ?`
      )
      .get(id);
    const verb = { approved: 'Approved', rejected: 'Rejected', pending: 'Moved back to pending' }[decision];
    const reason = decision === 'rejected' ? `. Reason: ${row.review_note}` : '';
    req.logActivity(
      `registration.${decision}`,
      `${verb} ${row.first_name} ${row.last_name} (${row.club}) for ${req.competition.name}${reason}`,
      competitionId
    );
  });
  notifyRegistrationDecisions(req.app.locals.notify, req.competition, changedIds, decision);

  if (changed > 0) {
    const verb = { approved: 'approved', rejected: 'rejected', pending: 'moved back to pending' }[decision];
    req.flash('success', `${changed} registration${changed === 1 ? '' : 's'} ${verb}.`);
  }
  return res.redirect(back);
});

function approvedOrPending(db, competitionId) {
  return db
    .prepare(`${REGISTRATION_SELECT} WHERE r.competition_id = ? AND r.status != 'rejected' ORDER BY ${DIVISION_ORDER}`)
    .all(competitionId);
}

router.get('/competitions/:id(\\d+)/divisions', (req, res) => {
  const divisions = new Map();
  approvedOrPending(req.app.locals.db, req.competition.id).forEach((r) => {
    const key = [r.gender, r.age_group_id, r.belt_group_id, r.weight_class_id].join('-');
    if (!divisions.has(key)) {
      divisions.set(key, {
        title: `${GENDERS[r.gender]} · ${r.age_group} · ${r.belt_group} · ${r.weight_class}`,
        approved: [],
        pending: 0,
      });
    }
    const division = divisions.get(key);
    if (r.status === 'approved') division.approved.push(r);
    else division.pending += 1;
  });
  res.render('admin/divisions', {
    title: 'Divisions',
    competition: req.competition,
    divisions: [...divisions.values()],
  });
});

function boutListPath(competition) {
  return `/admin/competitions/${competition.id}/bouts`;
}

// Missing fields keep the competition's saved values.
function readSchedule(body, competition) {
  const values = {
    bout_courts: Number(body.courts ?? competition.bout_courts),
    bout_start: clean(body.start ?? competition.bout_start, 5),
    bout_minutes: Number(body.minutes ?? competition.bout_minutes),
    bout_rest_minutes: Number(body.rest ?? competition.bout_rest_minutes),
  };
  const errors = [];
  if (!Number.isInteger(values.bout_rest_minutes) || values.bout_rest_minutes < 0 || values.bout_rest_minutes > 240) {
    errors.push('Enter between 0 and 240 minutes of rest between bouts.');
  }
  if (!Number.isInteger(values.bout_courts) || values.bout_courts < 1 || values.bout_courts > 20) {
    errors.push('Enter between 1 and 20 courts.');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.bout_start)) errors.push('Enter a valid start time.');
  if (!Number.isInteger(values.bout_minutes) || values.bout_minutes < 1 || values.bout_minutes > 120) {
    errors.push('Enter between 1 and 120 minutes per bout.');
  }
  return { values, errors };
}

function saveSchedule(req, res) {
  const { values, errors } = readSchedule(req.body, req.competition);
  if (errors.length > 0) {
    errors.forEach((error) => req.flash('error', error));
    return false;
  }
  req.app.locals.db
    .prepare(
      `UPDATE competitions SET bout_courts = @bout_courts, bout_start = @bout_start,
         bout_minutes = @bout_minutes, bout_rest_minutes = @bout_rest_minutes WHERE id = @id`
    )
    .run({ ...values, id: req.competition.id });
  return true;
}

router.get('/competitions/:id(\\d+)/bouts', (req, res) => {
  const { db } = req.app.locals;
  const divisions = loadBoutList(db, req.competition.id).map((division) => ({
    ...division,
    layout: layoutBracket(division.bouts, { slotHeight: 30, top: 4 }),
  }));
  const eventDates = getEventDates(db, req.competition.id);
  res.render('admin/bouts', {
    title: 'Bout list',
    competition: req.competition,
    divisions,
    dayCount: eventDates.length,
    dayOptions: eventDates.map((date, i) => ({ value: i + 1, label: `Day ${i + 1} (${formatDay(date)})` })),
    pinnedDays: loadDivisionDays(db, req.competition.id),
    resultsRecorded: hasResults(db, req.competition.id),
    weighIn: weighInCounts(db, req.competition.id),
    totalBouts: divisions.reduce((sum, d) => sum + d.matches, 0),
    counts: db
      .prepare('SELECT status, COUNT(*) AS n FROM registrations WHERE competition_id = ? GROUP BY status')
      .all(req.competition.id)
      .reduce((all, row) => ({ ...all, [row.status]: row.n }), { pending: 0, approved: 0, rejected: 0 }),
  });
});

router.post('/competitions/:id(\\d+)/bouts/generate', (req, res) => {
  const { db } = req.app.locals;
  if (req.competition.status !== 'closed') {
    req.flash('error', 'Close registration before generating the bout list.');
    return res.redirect(boutListPath(req.competition));
  }
  if (hasResults(db, req.competition.id)) {
    req.flash('error', 'Clear the recorded results before redrawing.');
    return res.redirect(boutListPath(req.competition));
  }
  if (!saveSchedule(req, res)) return res.redirect(boutListPath(req.competition));
  const redraw = hasBoutList(db, req.competition.id);
  const fighters = generateBoutList(db, req.competition.id);
  // A new draw needs a fresh look before coaches see it.
  db.prepare('UPDATE competitions SET bouts_published_at = NULL WHERE id = ?').run(req.competition.id);
  if (fighters > 0) {
    req.logActivity(
      redraw ? 'bouts.redrawn' : 'bouts.generated',
      `${redraw ? 'Redrew' : 'Generated'} the bout list for ${req.competition.name} (${fighters} fighters)`,
      req.competition.id
    );
  }
  if (fighters === 0) req.flash('error', 'There are no approved athletes to draw.');
  else req.flash('success', `Bout list generated for ${fighters} approved athlete${fighters === 1 ? '' : 's'}. Publish it when you're ready for coaches to see it.`);
  return res.redirect(boutListPath(req.competition));
});

router.post('/competitions/:id(\\d+)/bouts/publish', (req, res) => {
  const { db, notify } = req.app.locals;
  if (!hasBoutList(db, req.competition.id)) {
    req.flash('error', 'Generate the bout list first.');
    return res.redirect(boutListPath(req.competition));
  }
  db.prepare("UPDATE competitions SET bouts_published_at = datetime('now') WHERE id = ?").run(req.competition.id);
  notifyBoutListPublished(notify, req.competition);
  req.logActivity('bouts.published', `Published the bout list for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'Bout list published. Coaches with athletes in it have been emailed.');
  return res.redirect(boutListPath(req.competition));
});

router.post('/competitions/:id(\\d+)/bouts/unpublish', (req, res) => {
  req.app.locals.db.prepare('UPDATE competitions SET bouts_published_at = NULL WHERE id = ?').run(req.competition.id);
  req.logActivity('bouts.unpublished', `Hid the bout list for ${req.competition.name} from coaches`, req.competition.id);
  req.flash('success', 'Bout list hidden from coaches.');
  return res.redirect(boutListPath(req.competition));
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

router.post('/competitions/:id(\\d+)/results/clear-all', (req, res) => {
  clearAllResults(req.app.locals.db, req.competition.id);
  req.logActivity('result.cleared_all', `Cleared all results for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'All results cleared.');
  return res.redirect(resultsPath(req.competition));
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

// Changes courts and times only. The draw stays the same.
router.post('/competitions/:id(\\d+)/bouts/schedule', (req, res) => {
  if (saveSchedule(req, res)) {
    applySchedule(req.app.locals.db, req.competition.id);
    const { bout_courts: courts, bout_start: start, bout_minutes: minutes, bout_rest_minutes: rest } = req.app.locals.db
      .prepare('SELECT bout_courts, bout_start, bout_minutes, bout_rest_minutes FROM competitions WHERE id = ?')
      .get(req.competition.id);
    req.logActivity(
      'bouts.scheduled',
      `Updated the schedule for ${req.competition.name}: ${courts} courts, starting ${start}, ${minutes} minutes per bout, ${rest} minutes rest`,
      req.competition.id
    );
    req.flash('success', 'Schedule updated. The draw has not changed.');
  }
  return res.redirect(boutListPath(req.competition));
});

// Pins divisions to event days, then reschedules. The draw stays the same.
router.post('/competitions/:id(\\d+)/bouts/days', (req, res) => {
  const { db } = req.app.locals;
  if (!hasBoutList(db, req.competition.id)) {
    req.flash('error', 'Generate the bout list first.');
    return res.redirect(boutListPath(req.competition));
  }
  const choices = Object.fromEntries(
    Object.entries(req.body)
      .filter(([name]) => /^day_[MF]-\d+-\d+-\d+$/.test(name))
      .map(([name, value]) => [name.slice(4), clean(value, 3)])
  );
  const pinned = saveDivisionDays(db, req.competition.id, choices);
  applySchedule(db, req.competition.id);
  req.logActivity(
    'bouts.days_set',
    `Set division days for ${req.competition.name}: ${pinned} division${pinned === 1 ? '' : 's'} on a chosen day, the rest automatic`,
    req.competition.id
  );
  req.flash('success', 'Division days saved and the schedule updated. The draw has not changed.');
  return res.redirect(boutListPath(req.competition));
});

router.post('/competitions/:id(\\d+)/bouts/delete', (req, res) => {
  const { db } = req.app.locals;
  if (hasResults(db, req.competition.id)) {
    req.flash('error', 'Clear the recorded results before deleting the bout list.');
    return res.redirect(boutListPath(req.competition));
  }
  deleteBoutList(db, req.competition.id);
  db.prepare('UPDATE competitions SET bouts_published_at = NULL WHERE id = ?').run(req.competition.id);
  req.logActivity('bouts.deleted', `Deleted the bout list for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'Bout list deleted. You can change approvals or reopen registration.');
  return res.redirect(boutListPath(req.competition));
});

router.get('/competitions/:id(\\d+)/bouts.pdf', (req, res) => {
  const divisions = loadBoutList(req.app.locals.db, req.competition.id);
  if (divisions.length === 0) {
    req.flash('error', 'Generate the bout list first.');
    return res.redirect(boutListPath(req.competition));
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bout-list-competition-${req.competition.id}.pdf"`);
  return writeBoutListPdf(res, {
    competition: req.competition,
    divisions,
    dateLabel: formatEventDates(getEventDates(req.app.locals.db, req.competition.id)),
  });
});

// Leading =, +, - or @ would run as a formula when the file is opened in a spreadsheet.
function csvCell(value, { userText = false } = {}) {
  let text = String(value ?? '');
  if (userText && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

router.get('/competitions/:id(\\d+)/export.csv', (req, res) => {
  const header = ['Gender', 'Age group', 'Belt group', 'Weight class', 'Last name', 'First name', 'Club', 'Date of birth', 'Age', 'Belt'];
  const rows = approvedOrPending(req.app.locals.db, req.competition.id)
    .filter((r) => r.status === 'approved')
    .map((r) =>
      [
        csvCell(GENDERS[r.gender]),
        csvCell(r.age_group),
        csvCell(r.belt_group),
        csvCell(r.weight_class),
        csvCell(r.last_name, { userText: true }),
        csvCell(r.first_name, { userText: true }),
        csvCell(r.club_name, { userText: true }),
        csvCell(r.date_of_birth),
        csvCell(r.age_at_event),
        csvCell(beltName(r.belt_rank)),
      ].join(',')
    );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="competition-${req.competition.id}-approved.csv"`);
  res.send(`﻿${[header.map((h) => csvCell(h)).join(','), ...rows].join('\r\n')}`);
});

router.get('/fighters/:id(\\d+)/document', (req, res) => {
  const document = getFighterDocument(req.app.locals.db, req.params.id);
  if (!document) return notFound(res);
  return sendDocument(res, document);
});

// Each account type, and how to find it. A coach's type follows their club status.
const ACCOUNT_TYPES = {
  admin: { label: 'Admins', where: "u.role = 'admin'" },
  coach: { label: 'Coaches in a club', where: "u.role = 'coach' AND u.club_id IS NOT NULL" },
  pending: {
    label: 'Coaches awaiting approval',
    where: "u.role = 'coach' AND u.club_id IS NULL AND EXISTS (SELECT 1 FROM club_applications a WHERE a.user_id = u.id AND a.status = 'pending')",
  },
  unattached: {
    label: 'Coaches without a club',
    where: "u.role = 'coach' AND u.club_id IS NULL AND NOT EXISTS (SELECT 1 FROM club_applications a WHERE a.user_id = u.id AND a.status = 'pending')",
  },
};

function accountType(row) {
  if (row.role === 'admin') return 'admin';
  if (row.club_id) return 'coach';
  return row.pending_club ? 'pending' : 'unattached';
}

router.get('/accounts', (req, res) => {
  const { db } = req.app.locals;
  const type = ACCOUNT_TYPES[clean(req.query.type, 20)] ? clean(req.query.type, 20) : '';
  const search = clean(req.query.q, 100);
  const where = [];
  const params = {};
  if (type) where.push(ACCOUNT_TYPES[type].where);
  if (search) {
    // Escapes % and _ so a search for them matches the characters themselves.
    where.push("(u.full_name LIKE @search ESCAPE '\\' OR u.email LIKE @search ESCAPE '\\')");
    params.search = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  const accounts = db
    .prepare(
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.club_id, u.created_at, c.name AS club,
         (SELECT pc.name FROM club_applications a JOIN clubs pc ON pc.id = a.club_id
          WHERE a.user_id = u.id AND a.status = 'pending') AS pending_club
       FROM users u LEFT JOIN clubs c ON c.id = u.club_id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.created_at DESC, u.id DESC`
    )
    .all(params)
    .map((row) => ({ ...row, type: accountType(row) }));
  const counts = Object.fromEntries(
    Object.entries(ACCOUNT_TYPES).map(([key, { where: clause }]) => [
      key,
      db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${clause}`).get().n,
    ])
  );
  res.render('admin/accounts', {
    title: 'Accounts',
    accounts,
    types: ACCOUNT_TYPES,
    counts,
    total: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    type,
    search,
    formatActivityTime,
  });
});

const ACTIVITY_PAGE_SIZE = 100;

function readActivityFilter(query) {
  const category = ACTIVITY_CATEGORIES[clean(query.category, 20)] ? clean(query.category, 20) : '';
  const competitionId = /^\d+$/.test(clean(query.competition, 12)) ? Number(query.competition) : null;
  return { category, competitionId };
}

router.get('/activity', (req, res) => {
  const { db } = req.app.locals;
  const filter = readActivityFilter(req.query);
  const total = countActivity(db, filter);
  const pages = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const requested = Number(req.query.page);
  const page = Number.isInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
  const query = new URLSearchParams();
  if (filter.category) query.set('category', filter.category);
  if (filter.competitionId) query.set('competition', String(filter.competitionId));
  res.render('admin/activity', {
    title: 'Activity log',
    entries: listActivity(db, filter, { limit: ACTIVITY_PAGE_SIZE, offset: (page - 1) * ACTIVITY_PAGE_SIZE }),
    categories: ACTIVITY_CATEGORIES,
    competitions: db.prepare('SELECT id, name FROM competitions ORDER BY event_date DESC').all(),
    category: filter.category,
    competitionId: filter.competitionId,
    query: query.toString(),
    total,
    page,
    pages,
    formatActivityTime,
  });
});

router.get('/activity.csv', (req, res) => {
  const { db } = req.app.locals;
  const filter = readActivityFilter(req.query);
  const entries = listActivity(db, filter, { limit: countActivity(db, filter), offset: 0 });
  const rows = entries.map((e) =>
    [csvCell(e.at), csvCell(e.actor, { userText: true }), csvCell(e.action), csvCell(e.summary, { userText: true })].join(',')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="activity-log.csv"');
  res.send(`﻿${[['When (UTC)', 'Who', 'Action', 'What'].map((h) => csvCell(h)).join(','), ...rows].join('\r\n')}`);
});

module.exports = router;
