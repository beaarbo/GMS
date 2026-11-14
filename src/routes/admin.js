const express = require('express');
const {
  beltName,
  GENDERS,
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
  savePoomsaeAgeGroups,
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
  listCompetitionPhotos,
  addCompetitionPhoto,
  deleteCompetitionPhoto,
  listCompetitionFiles,
  getCompetitionFile,
  addCompetitionFile,
  deleteCompetitionFile,
  createOfficialAccount,
  createCoachAccount,
  createSubAdmin,
  removeSubAdmin,
  removeOfficial,
  today,
  listNews,
  deleteCoachAccount,
  competitionFootprint,
  deleteCompetition,
  swapAthletes,
  withdrawAthlete,
  reinstateAthlete,
  redrawDivision,
  listWithdrawn,
  mergeDivision,
  unmergeRegistration,
  hasPoomsaeResults,
  listPoomsaeEntries,
  REGISTRATION_SELECT,
  DIVISION_ORDER,
  listDesignatedPoomsae,
  getClubIcon,
} = require('../services');
const { sendDocument, detectIconType, detectAttachmentType, safeFilename, MAX_ICON_BYTES, MAX_NEW_COMPETITION_FILES, MAX_COMPETITION_PHOTOS, MAX_COMPETITION_PHOTO_BYTES } = require('../documents');
const { ACTIVITY_CATEGORIES, listActivity, countActivity, formatActivityTime } = require('../activity');
const { notifyRegistrationDecisions, notifyBoutListPublished, notifyDivisionMerged, notifyAccountChange, sendAdminInvite } = require('../notifications');
const { layoutBracket, computeMedals } = require('../bracket');
const { writeBoutListPdf } = require('../boutlistPdf');
const { entriesSheets, sendXlsx } = require('../exports');
const { cardAthletes, cardClubs, writeAthleteCards } = require('../athleteCards');
const { clean, toArray, requireRole, requireOwner, notFound, wrap, passwordError, readSetup, readPoomsaeAges } = require('./helpers');
const { resultsPath, poomsaeDrawSummary } = require('./competitionDay');
const { createBackup, pruneBackups, listBackups } = require('../backups');
const { readMapLocation } = require('../maps');
const { EVENT_TYPES, POOMSAE_FORMATS, MAX_CUT, hasKyorugi, hasPoomsae, validatePoomsaeAgeGroups } = require('../poomsae');

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
    map_query: '',
    description: typeof body.description === 'string' ? body.description.replace(/\r\n?/g, '\n').trim().slice(0, 5000) : '',
    age_basis: body.age_basis === 'date' ? 'date' : 'year',
    events: EVENT_TYPES[body.events] ? body.events : 'kyorugi',
    poomsae_format: POOMSAE_FORMATS[body.poomsae_format] ? body.poomsae_format : 'score',
    poomsae_cut: clean(body.poomsae_cut, 3) === '' ? 16 : Number(clean(body.poomsae_cut, 3)),
    // Blank means no limit.
    max_per_club_division: clean(body.max_per_club_division, 3) === '' ? null : Number(clean(body.max_per_club_division, 3)),
  };
  const errors = [];
  if (values.max_per_club_division !== null && (!Number.isInteger(values.max_per_club_division) || values.max_per_club_division < 1 || values.max_per_club_division > 50)) {
    errors.push('Enter a club limit per division between 1 and 50, or leave it blank for no limit.');
  }
  if (!Number.isInteger(values.poomsae_cut) || values.poomsae_cut < 2 || values.poomsae_cut > MAX_CUT) {
    errors.push(`Enter how many go from the poomsae score round into the bracket, from 2 to ${MAX_CUT}.`);
  }
  if (!values.name) errors.push('Enter a competition name.');
  if (!values.venue) errors.push('Enter a venue.');
  const map = readMapLocation(body.map_query);
  if (map.ok) values.map_query = map.query;
  else errors.push(map.error);
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

function competitionsWithCounts(db) {
  return db
    .prepare(
      `SELECT comp.*,
         SUM(r.status = 'pending') AS pending,
         SUM(r.status = 'approved') AS approved,
         SUM(r.status = 'rejected') AS rejected,
         (SELECT COUNT(*) FROM bouts b WHERE b.competition_id = comp.id) AS bout_count,
         (SELECT COUNT(*) FROM poomsae_entries p WHERE p.competition_id = comp.id AND p.status = 'pending') AS poomsae_pending,
         (SELECT COUNT(*) FROM poomsae_entries p WHERE p.competition_id = comp.id AND p.status = 'approved') AS poomsae_approved,
         (SELECT COUNT(*) FROM poomsae_entries p WHERE p.competition_id = comp.id) AS poomsae_count,
         (SELECT MAX(d.event_date) FROM competition_dates d WHERE d.competition_id = comp.id) AS last_day
       FROM competitions comp LEFT JOIN registrations r ON r.competition_id = comp.id
       GROUP BY comp.id ORDER BY comp.status = 'closed', comp.event_date`
    )
    .all();
}

// Things the admin should act on, most urgent first, each with where to do it.
function attentionItems(db, competitions, { emailConfigured, backupsDir }) {
  const items = [];
  if (!emailConfigured) {
    items.push({ level: 'error', text: 'Email is not set up, so password resets, approvals and reminders aren\'t sent.', href: '/admin/email', link: 'Check email settings' });
  }
  const applications = db.prepare("SELECT COUNT(*) AS n FROM club_applications WHERE status = 'pending'").get().n;
  if (applications > 0) {
    items.push({ level: 'info', text: `${applications} coach application${applications === 1 ? ' is' : 's are'} waiting for approval.`, href: '/admin/clubs', link: 'Review' });
  }
  const upcomingOrRunning = (c) => !c.last_day || c.last_day >= today();
  competitions.forEach((c) => {
    if (c.pending > 0) {
      items.push({ level: 'info', text: `${c.pending} registration${c.pending === 1 ? '' : 's'} waiting for review in ${c.name}.`, href: `/admin/competitions/${c.id}/registrations?status=pending`, link: 'Review' });
    }
    if (c.poomsae_pending > 0) {
      items.push({ level: 'info', text: `${c.poomsae_pending} poomsae entr${c.poomsae_pending === 1 ? 'y' : 'ies'} waiting for review in ${c.name}.`, href: `/admin/competitions/${c.id}/registrations#poomsae`, link: 'Review' });
    }
    if (c.status === 'closed' && upcomingOrRunning(c) && c.approved > 0 && c.bout_count === 0) {
      items.push({ level: 'info', text: `${c.name} is closed: run the weigh-in, then draw the bout list.`, href: `/admin/competitions/${c.id}/bouts`, link: 'Bout list' });
    }
    if (c.status === 'closed' && upcomingOrRunning(c) && c.bout_count > 0 && !c.bouts_published_at) {
      items.push({ level: 'info', text: `The bout list for ${c.name} is drawn but coaches can't see it yet.`, href: `/admin/competitions/${c.id}/bouts`, link: 'Publish' });
    }
    if (c.status === 'draft' && (!hasCompetitionLogo(db, c.id) || !String(c.description || '').trim())) {
      items.push({ level: 'info', text: `${c.name} needs a logo and a description before it can open.`, href: `/admin/competitions/${c.id}/files`, link: 'Add them' });
    }
  });
  if (backupsDir) {
    const [latest] = listBackups(backupsDir);
    const ageDays = latest ? (Date.now() - new Date(latest.createdAt.replace(' ', 'T')).getTime()) / 86400000 : Infinity;
    if (ageDays > 2) {
      items.push({ level: 'error', text: latest ? `The newest backup is ${Math.floor(ageDays)} days old.` : 'There are no backups yet.', href: '/admin/backups', link: 'Backups' });
    }
  }
  return items;
}

// An overview of the whole site: what needs doing, totals, what's coming up, and recent changes.
router.get('/', (req, res) => {
  const { db, notify, backups } = req.app.locals;
  const competitions = competitionsWithCounts(db);
  const count = (sql) => db.prepare(sql).get().n;
  res.render('admin/dashboard', {
    title: 'Admin dashboard',
    attention: attentionItems(db, competitions, { emailConfigured: Boolean(notify.mailer.configured), backupsDir: backups && backups.dir }),
    totals: {
      open: competitions.filter((c) => c.status === 'open').length,
      closed: competitions.filter((c) => c.status === 'closed').length,
      draft: competitions.filter((c) => c.status === 'draft').length,
      clubs: count('SELECT COUNT(*) AS n FROM clubs'),
      coaches: count("SELECT COUNT(*) AS n FROM users WHERE role = 'coach' AND club_id IS NOT NULL"),
      officials: count("SELECT COUNT(*) AS n FROM users WHERE role = 'official'"),
      athletes: count('SELECT COUNT(*) AS n FROM fighters'),
      news: count('SELECT COUNT(*) AS n FROM news_posts'),
    },
    upcoming: competitions.filter((c) => c.status !== 'draft' && c.last_day && c.last_day >= today()).sort((a, b) => a.event_date.localeCompare(b.event_date)).slice(0, 4),
    activity: listActivity(db, {}, { limit: 8, offset: 0 }),
    news: listNews(db, { signedIn: true, limit: 3 }),
    formatActivityTime,
  });
});

router.get('/competitions', (req, res) => {
  res.render('admin/competitions', { title: 'Competitions', competitions: competitionsWithCounts(req.app.locals.db) });
});

router.get('/competitions/new', (req, res) => {
  const { age_basis, max_per_club_division, poomsae_format, poomsae_cut } = req.site.defaults.competition;
  res.render('admin/comp_form', {
    title: 'New competition',
    // The Settings page's defaults; courts, times and age groups follow on creation.
    competition: { age_basis, max_per_club_division, poomsae_format, poomsae_cut },
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
  const photos = readPhotos(chosen('photos'), errors, MAX_COMPETITION_PHOTOS);
  return { logo, attachments, photos, errors, anyChosen: Boolean(logoFile) || chosen('files').length > 0 || chosen('photos').length > 0 };
}

// Checks chosen photos (JPG, PNG or WebP, up to 5 MB each), adding a message to
// errors for each problem. room = how many more the competition can take.
function readPhotos(files, errors, room) {
  if (files.length > room) {
    errors.push(room === 0 ? `A competition can have ${MAX_COMPETITION_PHOTOS} photos. Remove one to add another.` : `Only ${room} more photo${room === 1 ? '' : 's'} can be added (a competition can have ${MAX_COMPETITION_PHOTOS}).`);
    return [];
  }
  return files.flatMap((file) => {
    const type = detectIconType(file.buffer);
    if (file.size > MAX_COMPETITION_PHOTO_BYTES) errors.push(`${file.originalname} is over the 5 MB limit.`);
    else if (!type) errors.push(`${file.originalname} is not a JPG, PNG or WebP picture.`);
    else return [{ data: file.buffer, contentType: type.contentType }];
    return [];
  });
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
    uploads.photos.forEach((photo) => addCompetitionPhoto(db, newId, { ...photo, userId: req.user.id }));
    return newId;
  })();
  req.logActivity('competition.created', `Created competition ${values.name}`, id);
  if (uploads.logo) req.logActivity('competition.logo', `Updated the logo for ${values.name}`, id);
  uploads.attachments.forEach((file) => req.logActivity('competition.file_added', `Attached ${file.title} to ${values.name}`, id));
  if (uploads.photos.length > 0) req.logActivity('competition.photos', `Added ${uploads.photos.length} photo${uploads.photos.length === 1 ? '' : 's'} to ${values.name}`, id);

  const added = [uploads.logo && 'the logo', uploads.attachments.length > 0 && `${uploads.attachments.length} file${uploads.attachments.length === 1 ? '' : 's'}`, uploads.photos.length > 0 && `${uploads.photos.length} photo${uploads.photos.length === 1 ? '' : 's'}`].filter(Boolean);
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
    formatLocked: hasPoomsaeResults(req.app.locals.db, req.competition.id),
  });
});

router.post('/competitions/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const locked = countRegistrations(db, req.competition.id) > 0;
  // The poomsae format decides how scores and brackets are read, so it stays once either exists.
  const formatLocked = hasPoomsaeResults(db, req.competition.id);
  const { values, errors } = readCompetition(
    // Age placement depends on the first day and age rule, so they can't change after
    // entries exist, and neither can the events clubs entered.
    {
      ...req.body,
      ...(locked ? { age_basis: req.competition.age_basis, events: req.competition.events } : {}),
      ...(formatLocked ? { poomsae_format: req.competition.poomsae_format, poomsae_cut: String(req.competition.poomsae_cut) } : {}),
    },
    locked ? req.competition.event_date : null
  );
  if (errors.length > 0) {
    return res.status(400).render('admin/comp_form', {
      title: 'Edit competition',
      competition: { ...req.competition, ...values },
      errors,
      action: `/admin/competitions/${req.competition.id}`,
      locked,
      formatLocked,
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
         registration_deadline_time = @registration_deadline_time, venue = @venue, description = @description, age_basis = @age_basis,
         max_per_club_division = @max_per_club_division, events = @events,
         poomsae_format = @poomsae_format, poomsae_cut = @poomsae_cut, map_query = @map_query WHERE id = @id`
    ).run({ ...fields, id: req.competition.id });
    saveEventDates(db, req.competition.id, eventDates);
    // Keeps the draw, but moves bouts onto the new list of days.
    if (hasBoutList(db, req.competition.id)) applySchedule(db, req.competition.id);
  })();
  const changes = [];
  if (values.name !== req.competition.name) changes.push(`name to ${values.name}`);
  if (values.venue !== req.competition.venue) changes.push(`venue to ${values.venue}`);
  if (values.map_query !== req.competition.map_query) changes.push(values.map_query ? `map location to ${values.map_query}` : 'map location removed');
  if (values.events !== req.competition.events) changes.push(`events to ${EVENT_TYPES[values.events].toLowerCase()}`);
  if (values.poomsae_format !== req.competition.poomsae_format || values.poomsae_cut !== req.competition.poomsae_cut) {
    changes.push(`poomsae format to ${POOMSAE_FORMATS[values.poomsae_format].toLowerCase()}${values.poomsae_format === 'cut' ? ` (top ${values.poomsae_cut})` : ''}`);
  }
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
  return res.redirect('/admin/competitions');
});

router.post('/competitions/:id(\\d+)/status', (req, res) => {
  const status = req.body.status;
  if (!['draft', 'open', 'closed'].includes(status)) return notFound(res);
  const { db } = req.app.locals;
  if (status === 'draft' && countRegistrations(db, req.competition.id) > 0) {
    req.flash('error', 'A competition with registrations cannot go back to draft. Close it instead.');
    return res.redirect('/admin/competitions');
  }
  if (status !== 'closed' && hasBoutList(db, req.competition.id)) {
    req.flash('error', 'Delete the bout list before reopening registration.');
    return res.redirect('/admin/competitions');
  }
  if (status !== 'closed' && hasPoomsaeResults(db, req.competition.id)) {
    req.flash('error', 'Clear the poomsae scores and brackets before reopening registration.');
    return res.redirect('/admin/competitions');
  }
  if (status === 'open' && (!hasCompetitionLogo(db, req.competition.id) || !req.competition.description.trim())) {
    req.flash('error', `${req.competition.name} needs a logo and a description before clubs can register. Add them first.`);
    return res.redirect(hasCompetitionLogo(db, req.competition.id) ? `/admin/competitions/${req.competition.id}/edit` : filesPath(req.competition));
  }
  if (status === 'open' && deadlinePassed(req.competition)) {
    req.flash('error', 'The registration deadline has passed. Edit the competition to set a later deadline first.');
    return res.redirect('/admin/competitions');
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
  return res.redirect('/admin/competitions');
});

function filesPage(req, res, status = 200, error = null) {
  const { db } = req.app.locals;
  return res.status(status).render('admin/comp_files', {
    title: 'Logo and files',
    competition: req.competition,
    hasLogo: hasCompetitionLogo(db, req.competition.id),
    files: listCompetitionFiles(db, req.competition.id),
    photos: listCompetitionPhotos(db, req.competition.id),
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

router.post('/competitions/:id(\\d+)/photos', (req, res) => {
  const { db } = req.app.locals;
  if (req.uploadError) return filesPage(req, res, 400, req.uploadError);
  const chosen = (req.files || []).filter((f) => f.size > 0);
  if (chosen.length === 0) return filesPage(req, res, 400, 'Choose one or more photos to add.');
  const errors = [];
  const photos = readPhotos(chosen, errors, MAX_COMPETITION_PHOTOS - listCompetitionPhotos(db, req.competition.id).length);
  if (errors.length > 0) return filesPage(req, res, 400, `${errors.join(' ')} Nothing was added.`);
  db.transaction(() => photos.forEach((photo) => addCompetitionPhoto(db, req.competition.id, { ...photo, userId: req.user.id })))();
  req.logActivity('competition.photos', `Added ${photos.length} photo${photos.length === 1 ? '' : 's'} to ${req.competition.name}`, req.competition.id);
  req.flash('success', `${photos.length} photo${photos.length === 1 ? '' : 's'} added.`);
  return res.redirect(`${filesPath(req.competition)}#photos`);
});

router.post('/competitions/:id(\\d+)/photos/:photoId(\\d+)/delete', (req, res) => {
  if (deleteCompetitionPhoto(req.app.locals.db, req.competition.id, Number(req.params.photoId))) {
    req.logActivity('competition.photo_removed', `Removed a photo from ${req.competition.name}`, req.competition.id);
    req.flash('success', 'Photo removed.');
  }
  return res.redirect(`${filesPath(req.competition)}#photos`);
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

// A competition with entries goes only after registration closes, with its name
// typed to confirm, and after a backup. An empty draft goes with one click.
const emptyDraft = (db, competition) => competition.status === 'draft' && countRegistrations(db, competition.id) === 0;

router.get('/competitions/:id(\\d+)/delete', (req, res) => {
  const { db, backups } = req.app.locals;
  if (req.competition.status === 'open') {
    req.flash('error', 'Close registration before deleting this competition.');
    return res.redirect('/admin/competitions');
  }
  return res.render('admin/comp_delete', {
    title: 'Delete competition',
    competition: req.competition,
    footprint: competitionFootprint(db, req.competition.id),
    backupsOn: Boolean(backups && backups.dir),
    error: null,
  });
});

router.post('/competitions/:id(\\d+)/delete', wrap(async (req, res) => {
  const { db, backups } = req.app.locals;
  const competition = req.competition;
  if (competition.status === 'open') {
    req.flash('error', 'Close registration before deleting this competition.');
    return res.redirect('/admin/competitions');
  }
  if (emptyDraft(db, competition)) {
    deleteCompetition(db, competition.id);
    req.logActivity('competition.deleted', `Deleted draft competition ${competition.name}`, competition.id);
    req.flash('success', 'Draft competition deleted.');
    return res.redirect('/admin/competitions');
  }

  const typed = clean(req.body.confirm_name, 300);
  if (typed.toLowerCase() !== competition.name.trim().toLowerCase()) {
    return res.status(400).render('admin/comp_delete', {
      title: 'Delete competition',
      competition,
      footprint: competitionFootprint(db, competition.id),
      backupsOn: Boolean(backups && backups.dir),
      error: 'The name you typed doesn\'t match, so nothing was deleted.',
    });
  }
  // A copy first, so a mistake can be undone with RESTORE_BACKUP.
  let backupName = null;
  if (backups && backups.dir) {
    try {
      backupName = (await createBackup(db, backups.dir, { kind: 'manual' })).name;
      pruneBackups(backups.dir, backups.keep);
    } catch (error) {
      req.flash('error', `The backup before deleting failed, so nothing was deleted: ${error.message}`);
      return res.redirect(`/admin/competitions/${competition.id}/delete`);
    }
  }
  const footprint = competitionFootprint(db, competition.id);
  deleteCompetition(db, competition.id);
  req.logActivity(
    'competition.deleted',
    `Deleted ${competition.name} with ${footprint.registrations} registrations and ${footprint.results} results${backupName ? `, after backup ${backupName}` : ''}`,
    competition.id
  );
  req.flash('success', `${competition.name} was deleted.${backupName ? ` A backup was made first: ${backupName}.` : ''}`);
  return res.redirect('/admin/competitions');
}));

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

function setupPage(res, competition, { status = 200, ageRows, poomsaeRows, beltRows, errors = [], locked = false }) {
  return res.status(status).render('admin/setup', { title: 'Division setup', competition, ageRows, poomsaeRows, beltRows, errors, locked });
}

router.get('/competitions/:id(\\d+)/setup', (req, res) => {
  const { db } = req.app.locals;
  const setup = loadDivisionSetup(db, req.competition.id);
  return setupPage(res, req.competition, {
    ageRows: setupRowsForForm(setup),
    poomsaeRows: setup.poomsaeAgeGroups,
    beltRows: setup.beltGroups,
    locked: countRegistrations(db, req.competition.id) > 0,
  });
});

// Each event's part is read and saved only when the competition holds that event.
router.post('/competitions/:id(\\d+)/setup', (req, res) => {
  const { db } = req.app.locals;
  const competition = req.competition;
  if (countRegistrations(db, competition.id) > 0) {
    req.flash('error', 'Divisions are locked because clubs have already registered fighters.');
    return res.redirect(`/admin/competitions/${competition.id}/setup`);
  }
  const current = loadDivisionSetup(db, competition.id);
  const setup = hasKyorugi(competition) ? readSetup(req.body) : null;
  const poomsaeAges = hasPoomsae(competition) ? readPoomsaeAges(req.body) : null;
  const errors = [...(setup ? validateSetup(setup) : []), ...(poomsaeAges ? validatePoomsaeAgeGroups(poomsaeAges) : [])];
  if (errors.length > 0) {
    return setupPage(res, competition, {
      status: 400,
      ageRows: setup ? setup.ageGroups.map((g) => ({ ...g, min_age: g.minRaw, max_age: g.maxRaw })) : setupRowsForForm(current),
      poomsaeRows: poomsaeAges ? poomsaeAges.map((g) => ({ ...g, min_age: g.minRaw, max_age: g.maxRaw })) : current.poomsaeAgeGroups,
      beltRows: current.beltGroups,
      errors,
    });
  }
  db.transaction(() => {
    if (setup) saveDivisionSetup(db, competition.id, setup);
    if (poomsaeAges) savePoomsaeAgeGroups(db, competition.id, poomsaeAges);
  })();
  req.logActivity('competition.divisions', `Changed the division setup for ${competition.name}`, competition.id);
  req.flash('success', 'Divisions saved.');
  return res.redirect(`/admin/competitions/${competition.id}/setup`);
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
    poomsaeEntries: hasPoomsae(competition) ? listPoomsaeEntries(db, competition.id) : null,
    cardClubs: cardClubs(db, competition.id),
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

// "Male · Junior · Black Belt · -59 kg" for any division key of the competition.
function divisionTitler(db, competitionId) {
  const setup = loadDivisionSetup(db, competitionId);
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const ages = byId(setup.ageGroups);
  const belts = byId(setup.beltGroups);
  const weights = byId(setup.weightClasses);
  return (key) => {
    const [gender, age, belt, weight] = String(key).split('-');
    const parts = [GENDERS[gender], (ages.get(Number(age)) || {}).name, (belts.get(Number(belt)) || {}).name, (weights.get(Number(weight)) || {}).label];
    return parts.every(Boolean) ? parts.join(' · ') : 'another division';
  };
}

// Closest fits first for moving a lone athlete: same age and belt groups, next
// heavier class, then lighter; then the nearest age group, then belt group.
function mergeTargets(division, divisions) {
  const weightOf = (d) => (d.maxKg === null ? Infinity : d.maxKg);
  const score = (t) => {
    const weightGap = weightOf(t) === weightOf(division) ? 0 : weightOf(t) > weightOf(division) ? 1 : 2;
    return Math.abs(t.minAge - division.minAge) * 1000 + Math.abs(t.minRank - division.minRank) * 100 + weightGap * 10
      + Math.min(9, Math.abs((Number.isFinite(weightOf(t)) ? weightOf(t) : 999) - (Number.isFinite(weightOf(division)) ? weightOf(division) : 999)) / 10);
  };
  return divisions.filter((t) => t.key !== division.key && t.gender === division.gender).sort((a, b) => score(a) - score(b));
}

router.get('/competitions/:id(\\d+)/divisions', (req, res) => {
  const { db } = req.app.locals;
  const titleOf = divisionTitler(db, req.competition.id);
  const divisions = new Map();
  approvedOrPending(db, req.competition.id).forEach((r) => {
    const key = [r.gender, r.age_group_id, r.belt_group_id, r.weight_class_id].join('-');
    if (!divisions.has(key)) {
      divisions.set(key, {
        key,
        gender: r.gender,
        minAge: r.min_age,
        minRank: r.min_rank,
        maxKg: r.max_kg,
        title: `${GENDERS[r.gender]} · ${r.age_group} · ${r.belt_group} · ${r.weight_class}`,
        approved: [],
        pending: 0,
      });
    }
    const division = divisions.get(key);
    if (r.status === 'approved') division.approved.push({ ...r, mergedFromTitle: r.merged_from ? titleOf(r.merged_from) : null });
    else division.pending += 1;
  });
  const list = [...divisions.values()];
  list.forEach((d) => {
    d.lone = d.approved.length + d.pending < 2;
    d.targets = d.lone ? mergeTargets(d, list) : [];
  });
  res.render('admin/divisions', {
    title: 'Divisions',
    competition: req.competition,
    event: hasKyorugi(req.competition) && hasPoomsae(req.competition) && eventQuery(req.query.event) ? req.query.event : null,
    bothEvents: hasKyorugi(req.competition) && hasPoomsae(req.competition),
    divisions: list,
    locked: hasBoutList(db, req.competition.id),
    // Poomsae divisions on the same page, each with its own format, cut and day.
    poomsae: hasPoomsae(req.competition) ? poomsaeDrawSummary(db, req.competition) : null,
    designated: hasPoomsae(req.competition) ? listDesignatedPoomsae(db, req.competition.id) : [],
    dayOptions: getEventDates(db, req.competition.id).map((date, i) => ({ value: i + 1, label: `Day ${i + 1} (${formatDay(date)})` })),
  });
});

router.post('/competitions/:id(\\d+)/divisions/merge', (req, res) => {
  const { db, notify } = req.app.locals;
  const titleOf = divisionTitler(db, req.competition.id);
  const from = clean(req.body.from, 40);
  const to = clean(req.body.to, 40);
  const result = mergeDivision(db, req.competition, from, to);
  const back = `/admin/competitions/${req.competition.id}/divisions${eventQuery(req.body.event)}`;
  if (!result.ok) {
    req.flash('error', result.error);
    return res.redirect(back);
  }
  const moves = result.moved.map((m) => ({ ...m, from: titleOf(from), to: titleOf(to) }));
  notifyDivisionMerged(notify, req.competition, moves);
  req.logActivity('registration.merged', `Moved ${moves.map((m) => m.name).join(', ')} from ${titleOf(from)} to ${titleOf(to)}`, req.competition.id);
  req.flash('success', `${moves.map((m) => m.name).join(', ')} moved to ${titleOf(to)}. Their coach${moves.length === 1 ? ' was' : 'es were'} emailed.`);
  return res.redirect(back);
});

router.post('/competitions/:id(\\d+)/divisions/unmerge', (req, res) => {
  const { db } = req.app.locals;
  const titleOf = divisionTitler(db, req.competition.id);
  const name = athleteName(db, req.body.registration);
  const result = unmergeRegistration(db, req.competition, req.body.registration);
  if (!result.ok) req.flash('error', result.error);
  else {
    req.logActivity('registration.unmerged', `Moved ${name} back to ${titleOf(result.key)}`, req.competition.id);
    req.flash('success', `${name} is back in ${titleOf(result.key)}.`);
  }
  return res.redirect(`/admin/competitions/${req.competition.id}/divisions${eventQuery(req.body.event)}`);
});

// ?event=kyorugi or poomsae shows one event on the Divisions, Bout list and
// Results pages; forms send it back so saving stays on the same tab.
const eventQuery = (event) => (['kyorugi', 'poomsae'].includes(event) ? `?event=${event}` : '');

function boutListPath(competition, event) {
  return `/admin/competitions/${competition.id}/bouts${eventQuery(event)}`;
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
    event: hasKyorugi(req.competition) && hasPoomsae(req.competition) && eventQuery(req.query.event) ? req.query.event : null,
    bothEvents: hasKyorugi(req.competition) && hasPoomsae(req.competition),
    poomsae: hasPoomsae(req.competition) ? poomsaeDrawSummary(db, req.competition) : null,
    designated: hasPoomsae(req.competition) ? listDesignatedPoomsae(db, req.competition.id) : [],
    cardClubs: cardClubs(db, req.competition.id),
    divisions,
    dayCount: eventDates.length,
    dayOptions: eventDates.map((date, i) => ({ value: i + 1, label: `Day ${i + 1} (${formatDay(date)})` })),
    pinnedDays: loadDivisionDays(db, req.competition.id),
    resultsRecorded: hasResults(db, req.competition.id),
    weighIn: weighInCounts(db, req.competition.id),
    withdrawn: listWithdrawn(db, req.competition.id),
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
    return res.redirect(boutListPath(req.competition, req.body.event));
  }
  if (hasResults(db, req.competition.id)) {
    req.flash('error', 'Clear the recorded results before redrawing.');
    return res.redirect(boutListPath(req.competition, req.body.event));
  }
  if (!saveSchedule(req, res)) return res.redirect(boutListPath(req.competition, req.body.event));
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
  return res.redirect(boutListPath(req.competition, req.body.event));
});

router.post('/competitions/:id(\\d+)/bouts/publish', (req, res) => {
  const { db, notify } = req.app.locals;
  if (!hasBoutList(db, req.competition.id)) {
    req.flash('error', 'Generate the bout list first.');
    return res.redirect(boutListPath(req.competition, req.body.event));
  }
  db.prepare("UPDATE competitions SET bouts_published_at = datetime('now') WHERE id = ?").run(req.competition.id);
  notifyBoutListPublished(notify, req.competition);
  req.logActivity('bouts.published', `Published the bout list for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'Kyorugi bout list published for everyone to see. Coaches with athletes in it have been emailed.');
  return res.redirect(boutListPath(req.competition, req.body.event));
});

router.post('/competitions/:id(\\d+)/bouts/unpublish', (req, res) => {
  req.app.locals.db.prepare('UPDATE competitions SET bouts_published_at = NULL WHERE id = ?').run(req.competition.id);
  req.logActivity('bouts.unpublished', `Hid the bout list for ${req.competition.name} from coaches`, req.competition.id);
  req.flash('success', 'Kyorugi bout list hidden.');
  return res.redirect(boutListPath(req.competition, req.body.event));
});

router.post('/competitions/:id(\\d+)/results/clear-all', (req, res) => {
  clearAllResults(req.app.locals.db, req.competition.id);
  req.logActivity('result.cleared_all', `Cleared all results for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'All results cleared.');
  return res.redirect(resultsPath(req.competition, null, null, req.body.event));
});

// Manual changes to one division of a drawn bout list.
function athleteName(db, registrationId) {
  const row = db
    .prepare('SELECT f.first_name, f.last_name, c.name AS club FROM registrations r JOIN fighters f ON f.id = r.fighter_id JOIN clubs c ON c.id = r.club_id WHERE r.id = ?')
    .get(Number(registrationId));
  return row ? `${row.first_name} ${row.last_name} (${row.club})` : 'an athlete';
}

function divisionTitle(db, competitionId, key) {
  const division = loadBoutList(db, competitionId).find((d) => d.key === key);
  return division ? division.title : 'a division';
}

const divisionAnchor = (competition, key, event) => `${boutListPath(competition, event)}#division-${key}`;

router.post('/competitions/:id(\\d+)/bouts/swap', (req, res) => {
  const { db } = req.app.locals;
  const key = clean(req.body.division, 40);
  const title = divisionTitle(db, req.competition.id, key);
  const result = swapAthletes(db, req.competition, key, req.body.first, req.body.second);
  if (!result.ok) req.flash('error', result.error);
  else {
    req.logActivity('bouts.swapped', `Swapped ${athleteName(db, req.body.first)} and ${athleteName(db, req.body.second)} in ${title}`, req.competition.id);
    req.flash('success', 'Athletes swapped. Bout times were updated.');
  }
  return res.redirect(divisionAnchor(req.competition, key, req.body.event));
});

router.post('/competitions/:id(\\d+)/bouts/withdraw', (req, res) => {
  const { db } = req.app.locals;
  const key = clean(req.body.division, 40);
  const title = divisionTitle(db, req.competition.id, key);
  const name = athleteName(db, req.body.registration);
  const note = clean(req.body.note, 200);
  const result = withdrawAthlete(db, req.competition, key, req.body.registration, note);
  if (!result.ok) req.flash('error', result.error);
  else {
    req.logActivity('bouts.withdrawn', `Withdrew ${name} from ${title}${note ? `: ${note}` : ''}`, req.competition.id);
    req.flash('success', result.reseeded
      ? `${name} withdrawn. They had a bye, so the division was laid out again in seed order.`
      : `${name} withdrawn. Their first opponent now has a bye.`);
  }
  return res.redirect(divisionAnchor(req.competition, key, req.body.event));
});

router.post('/competitions/:id(\\d+)/bouts/reinstate', (req, res) => {
  const { db } = req.app.locals;
  const name = athleteName(db, req.body.registration);
  const result = reinstateAthlete(db, req.competition, req.body.registration);
  if (!result.ok) {
    req.flash('error', result.error);
    return res.redirect(boutListPath(req.competition, req.body.event));
  }
  const title = divisionTitle(db, req.competition.id, result.key);
  req.logActivity('bouts.reinstated', `Reinstated ${name} and redrew ${title} (${result.athletes} athletes)`, req.competition.id);
  req.flash('success', `${name} reinstated, and ${title} was redrawn to include them.`);
  return res.redirect(divisionAnchor(req.competition, result.key, req.body.event));
});

router.post('/competitions/:id(\\d+)/bouts/redraw-division', (req, res) => {
  const { db } = req.app.locals;
  const key = clean(req.body.division, 40);
  const title = divisionTitle(db, req.competition.id, key) || 'a division';
  const result = redrawDivision(db, req.competition, key);
  if (!result.ok) req.flash('error', result.error);
  else {
    req.logActivity('bouts.division_redrawn', `Redrew ${title} (${result.athletes} athletes)`, req.competition.id);
    req.flash('success', `Division redrawn with ${result.athletes} athlete${result.athletes === 1 ? '' : 's'}. Bout times were updated.`);
  }
  return res.redirect(divisionAnchor(req.competition, key, req.body.event));
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
  return res.redirect(boutListPath(req.competition, req.body.event));
});

// Pins divisions to event days, then reschedules. The draw stays the same.
router.post('/competitions/:id(\\d+)/bouts/days', (req, res) => {
  const { db } = req.app.locals;
  if (!hasBoutList(db, req.competition.id)) {
    req.flash('error', 'Generate the bout list first.');
    return res.redirect(boutListPath(req.competition, req.body.event));
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
  return res.redirect(boutListPath(req.competition, req.body.event));
});

router.post('/competitions/:id(\\d+)/bouts/delete', (req, res) => {
  const { db } = req.app.locals;
  if (hasResults(db, req.competition.id)) {
    req.flash('error', 'Clear the recorded results before deleting the bout list.');
    return res.redirect(boutListPath(req.competition, req.body.event));
  }
  deleteBoutList(db, req.competition.id);
  db.prepare('UPDATE competitions SET bouts_published_at = NULL WHERE id = ?').run(req.competition.id);
  req.logActivity('bouts.deleted', `Deleted the bout list for ${req.competition.name}`, req.competition.id);
  req.flash('success', 'Bout list deleted. You can change approvals or reopen registration.');
  return res.redirect(boutListPath(req.competition, req.body.event));
});

router.get('/competitions/:id(\\d+)/bouts.pdf', (req, res) => {
  const divisions = loadBoutList(req.app.locals.db, req.competition.id);
  if (divisions.length === 0) {
    req.flash('error', 'Generate the bout list first.');
    return res.redirect(boutListPath(req.competition, req.body.event));
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

// Every entry, kyorugi and poomsae, with dates of birth for insurers and
// federations. It holds minors' personal data, so each download is logged.
router.get('/competitions/:id(\\d+)/entries.xlsx', wrap(async (req, res) => {
  req.logActivity('competition.exported', `Downloaded every entry for ${req.competition.name}`, req.competition.id);
  return sendXlsx(res, `entries-competition-${req.competition.id}.xlsx`, entriesSheets(req.app.locals.db, req.competition));
}));

// Cards to print for every approved athlete, or one club's (?club=id).
router.get('/competitions/:id(\\d+)/cards.pdf', (req, res) => {
  const { db, notify } = req.app.locals;
  const clubId = /^\d+$/.test(clean(req.query.club, 12)) ? Number(req.query.club) : null;
  const athletes = cardAthletes(db, req.competition, { clubId });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="athlete-cards-competition-${req.competition.id}${clubId ? `-club-${clubId}` : ''}.pdf"`);
  const photoFor = (fighterId) => {
    const photo = db.prepare('SELECT data FROM fighter_photos WHERE fighter_id = ?').get(fighterId);
    return photo ? photo.data : null;
  };
  // One read per club, kept for the whole PDF: a club's athletes share its icon.
  const icons = new Map();
  const clubIconFor = (id) => {
    if (!icons.has(id)) icons.set(id, (getClubIcon(db, id) || {}).data || null);
    return icons.get(id);
  };
  return writeAthleteCards(res, { competition: req.competition, athletes, publicUrl: notify.publicUrl, photoFor, clubIconFor });
});

router.get('/fighters/:id(\\d+)/document', (req, res) => {
  const document = getFighterDocument(req.app.locals.db, req.params.id);
  if (!document) return notFound(res);
  return sendDocument(res, document);
});

// Each account type, and how to find it. A coach's type follows their club status.
const ACCOUNT_TYPES = {
  admin: { label: 'Admins', where: "u.role = 'admin'" },
  official: { label: 'Officials', where: "u.role = 'official'" },
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
  if (row.role === 'official') return 'official';
  if (row.club_id) return 'coach';
  return row.pending_club ? 'pending' : 'unattached';
}

// Officials get a starting password from the admin. They can change it on My account.
// Adds a coach directly, for sites where coaches can't sign up themselves. With
// a club chosen they are approved for it straight away.
router.post('/accounts/coaches', wrap(async (req, res) => {
  const { db } = req.app.locals;
  const values = { full_name: clean(req.body.full_name, 100), phone: clean(req.body.phone, 40), email: clean(req.body.email).toLowerCase() };
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const club = /^\d+$/.test(clean(req.body.club_id, 12)) ? db.prepare('SELECT id, name FROM clubs WHERE id = ?').get(Number(req.body.club_id)) : null;
  const errors = [];
  if (!values.full_name) errors.push('Enter the coach\'s name.');
  if (!values.phone) errors.push('Enter the coach\'s contact number.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('Enter a valid email address.');
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) errors.push('An account with this email already exists.');
  if (passwordError(password)) errors.push(passwordError(password));
  if (req.body.club_id && !club) errors.push('Choose a club from the list.');
  if (errors.length > 0) {
    errors.forEach((error) => req.flash('error', error));
    return res.redirect('/admin/accounts?type=coach');
  }
  const userId = await createCoachAccount(db, { ...values, password });
  if (club) {
    db.transaction(() => {
      db.prepare('UPDATE users SET club_id = ? WHERE id = ?').run(club.id, userId);
      db.prepare("INSERT INTO club_applications (user_id, club_id, status, reviewed_at) VALUES (?, ?, 'approved', datetime('now'))").run(userId, club.id);
    })();
  }
  req.logActivity('account.coach_added', `Added the coach ${values.full_name} (${values.email})${club ? ` for ${club.name}` : ''}`);
  req.flash('success', `${values.full_name} can now log in as a coach${club ? ` for ${club.name}` : ''}. Give them the starting password privately, and ask them to change it on My account.`);
  return res.redirect('/admin/accounts?type=coach');
}));

// Sub-admins: only the owner adds them. Their one-time password goes to them
// by email and is never shown here, and they must replace it at first login.
router.post('/accounts/admins', requireOwner, wrap(async (req, res) => {
  const { db, notify } = req.app.locals;
  const values = { full_name: clean(req.body.full_name, 100), email: clean(req.body.email).toLowerCase() };
  const errors = [];
  if (!values.full_name) errors.push('Enter the new admin\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('Enter a valid email address.');
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) errors.push('An account with this email already exists.');
  // In development an unset mailer prints the email to the console instead.
  if (!notify.mailer.configured && req.app.locals.production) errors.push('Email isn\'t set up, so the one-time password can\'t be sent. Set it up first (see the Email page).');
  if (errors.length > 0) {
    errors.forEach((error) => req.flash('error', error));
    return res.redirect('/admin/accounts?type=admin');
  }
  const { password } = await createSubAdmin(db, values);
  await sendAdminInvite(notify, { email: values.email, name: values.full_name, password, invitedBy: req.user.full_name || req.user.email });
  req.logActivity('account.admin_added', `Added the admin ${values.full_name} (${values.email})`);
  req.flash('success', `${values.full_name} is now an admin. Their one-time password was emailed to ${values.email}; they'll choose their own when they first log in.`);
  return res.redirect('/admin/accounts?type=admin');
}));

router.post('/accounts/admins/:userId(\\d+)/remove', requireOwner, (req, res) => {
  const admin = removeSubAdmin(req.app.locals.db, Number(req.params.userId));
  if (admin) {
    req.logActivity('account.admin_removed', `Removed the admin ${admin.full_name || admin.email} (${admin.email})`);
    req.flash('success', `${admin.full_name || admin.email} is no longer an admin, and has been logged out.`);
  }
  return res.redirect('/admin/accounts?type=admin');
});

// For someone who lost their phone and their recovery codes. The owner's own
// two-step login is never turned off by anyone else.
router.post('/accounts/:userId(\\d+)/two-step/off', (req, res) => {
  const { db } = req.app.locals;
  const account = db.prepare('SELECT id, email, full_name FROM users WHERE id = ? AND totp_secret IS NOT NULL AND owner = 0').get(Number(req.params.userId));
  if (account) {
    db.prepare("UPDATE users SET totp_secret = NULL, totp_recovery = '[]' WHERE id = ?").run(account.id);
    req.logActivity('account.two_step_reset', `Turned off two-step login for ${account.full_name || account.email}`);
    notifyAccountChange(req.app.locals.notify, account.email, 'An admin turned off two-step login for your account. Set it up again on My account.');
    req.flash('success', `Two-step login is off for ${account.full_name || account.email}. They log in with their password alone until they set it up again.`);
  }
  return res.redirect(`/admin/accounts${req.body.type ? `?type=${encodeURIComponent(clean(req.body.type, 20))}` : ''}`);
});

router.post('/accounts/officials', wrap(async (req, res) => {
  const { db } = req.app.locals;
  const values = { full_name: clean(req.body.full_name, 100), email: clean(req.body.email).toLowerCase() };
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const errors = [];
  if (!values.full_name) errors.push('Enter the official\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('Enter a valid email address.');
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) errors.push('An account with this email already exists.');
  if (passwordError(password)) errors.push(passwordError(password));
  if (errors.length > 0) {
    errors.forEach((error) => req.flash('error', error));
    return res.redirect('/admin/accounts?type=official');
  }
  await createOfficialAccount(db, { ...values, password });
  req.logActivity('account.official_added', `Added the official ${values.full_name} (${values.email})`);
  req.flash('success', `${values.full_name} can now log in as an official. Give them the starting password privately, and ask them to change it on My account.`);
  return res.redirect('/admin/accounts?type=official');
}));

router.post('/accounts/officials/:userId(\\d+)/remove', (req, res) => {
  const official = removeOfficial(req.app.locals.db, Number(req.params.userId));
  if (official) {
    req.logActivity('account.official_removed', `Removed the official ${official.full_name} (${official.email})`);
    req.flash('success', `${official.full_name}'s official account was removed.`);
  }
  return res.redirect('/admin/accounts?type=official');
});

// Deletes a coach's account. The club keeps its athletes and entries.
router.post('/accounts/coaches/:userId(\\d+)/delete', (req, res) => {
  const coach = deleteCoachAccount(req.app.locals.db, Number(req.params.userId));
  if (coach) {
    req.logActivity('account.coach_deleted', `Deleted the coach account of ${coach.full_name || coach.email} (${coach.email})${coach.club ? `, coach of ${coach.club}` : ''}`);
    req.flash('success', `${coach.full_name || coach.email}'s account was deleted.${coach.club ? ` ${coach.club} keeps its athletes and entries.` : ''}`);
  } else {
    req.flash('error', 'Only coach accounts can be deleted here.');
  }
  const back = ACCOUNT_TYPES[clean(req.body.type, 20)] ? `?type=${clean(req.body.type, 20)}` : '';
  return res.redirect(`/admin/accounts${back}`);
});

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
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.club_id, u.created_at, c.name AS club, u.totp_secret IS NOT NULL AS two_step, u.owner, u.must_change_password,
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
    clubs: db.prepare('SELECT id, name FROM clubs ORDER BY name').all(),
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
