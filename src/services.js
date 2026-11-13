// Database operations shared by routes, the seed script and tests.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  DEFAULT_BELT_GROUPS,
  GENDERS,
  assignDivision,
  checkWeight,
  parseWeightLimits,
  formatDay,
} = require('./divisions');
const { buildBracket, roundsFromSlots, seededSlots, slotsAreValid, assignCourts, scheduleCourt, formatTime, layoutBracket, computeMedals } = require('./bracket');
const {
  placeEntry, POOMSAE_EVENTS, POOMSAE_GENDERS, poomsaeDivisionTitle, rankEntries, divisionMode, bracketEntrants, poomsaeMedalists, schedulePoomsae, hasKyorugi, hasPoomsae, judgesScore,
} = require('./poomsae');
const { logActivity } = require('./activity');
const { documentLabel, documentTypeFor } = require('./documents');
const { loadSettings } = require('./settings');

const RESET_LIFETIME_MS = 3600000;
const RESET_COOLDOWN_MS = 5 * 60000;

function today() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the server's TZ
}

// "YYYY-MM-DD HH:MM" in the server's time zone, which sorts as text.
function localNow() {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${today()} ${time}`;
}

function deadlinePassed(competition) {
  return localNow() > `${competition.registration_deadline} ${competition.registration_deadline_time}`;
}

function isRegistrationOpen(competition) {
  return competition.status === 'open' && !deadlinePassed(competition);
}

// Runs on each request, so a competition closes by itself when its deadline passes.
function closeExpiredCompetitions(db) {
  const expired = db
    .prepare(
      `SELECT id, name FROM competitions
       WHERE status = 'open' AND registration_deadline || ' ' || registration_deadline_time < ?`
    )
    .all(localNow());
  expired.forEach((competition) => {
    db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(competition.id);
    logActivity(db, {
      action: 'competition.auto_closed',
      summary: `Registration closed at the deadline: ${competition.name}`,
      competitionId: competition.id,
    });
  });
}

function timeLeft(competition) {
  const closesAt = new Date(`${competition.registration_deadline}T${competition.registration_deadline_time}:59`);
  const hours = Math.floor((closesAt.getTime() - Date.now()) / 3600000);
  if (hours >= 48) return `${Math.floor(hours / 24)} days left`;
  if (hours >= 2) return `${hours} hours left`;
  return 'Closing soon';
}

function loadDivisionSetup(db, competitionId) {
  return {
    ageGroups: db.prepare('SELECT * FROM age_groups WHERE competition_id = ? ORDER BY min_age').all(competitionId),
    beltGroups: db.prepare('SELECT * FROM belt_groups WHERE competition_id = ? ORDER BY min_rank').all(competitionId),
    weightClasses: db
      .prepare('SELECT * FROM weight_classes WHERE competition_id = ? ORDER BY max_kg IS NULL, max_kg')
      .all(competitionId),
    poomsaeAgeGroups: db.prepare('SELECT * FROM poomsae_age_groups WHERE competition_id = ? ORDER BY min_age').all(competitionId),
  };
}

// Kyorugi registrations and poomsae entries together: either locks the setup.
function countRegistrations(db, competitionId) {
  return db
    .prepare('SELECT (SELECT COUNT(*) FROM registrations WHERE competition_id = ?) + (SELECT COUNT(*) FROM poomsae_entries WHERE competition_id = ?) AS n')
    .get(competitionId, competitionId).n;
}

// Replaces a competition's setup. Callers must validate first and must not call
// this once registrations exist, because registrations point at these rows.
function saveDivisionSetup(db, competitionId, { ageGroups, beltGroups }) {
  const insertAge = db.prepare('INSERT INTO age_groups (competition_id, name, min_age, max_age) VALUES (?, ?, ?, ?)');
  const insertBelt = db.prepare('INSERT INTO belt_groups (competition_id, name, min_rank, max_rank) VALUES (?, ?, ?, ?)');
  const insertWeight = db.prepare(
    'INSERT INTO weight_classes (competition_id, age_group_id, gender, label, max_kg) VALUES (?, ?, ?, ?, ?)'
  );

  db.transaction(() => {
    if (countRegistrations(db, competitionId) > 0) {
      throw new Error('Division setup is locked once registrations exist.');
    }
    db.prepare('DELETE FROM weight_classes WHERE competition_id = ?').run(competitionId);
    db.prepare('DELETE FROM age_groups WHERE competition_id = ?').run(competitionId);
    db.prepare('DELETE FROM belt_groups WHERE competition_id = ?').run(competitionId);

    ageGroups.forEach((group) => {
      const ageGroupId = insertAge.run(competitionId, group.name, group.min_age, group.max_age).lastInsertRowid;
      [['M', group.male], ['F', group.female]].forEach(([gender, limits]) => {
        parseWeightLimits(limits).classes.forEach((c) => {
          insertWeight.run(competitionId, ageGroupId, gender, c.label, c.max_kg);
        });
      });
    });
    beltGroups.forEach((group) => {
      insertBelt.run(competitionId, group.name, group.min_rank, group.max_rank);
    });
  })();
}

// Replaces a competition's poomsae age groups. Validate first. Locked, like the
// kyorugi setup, once entries exist.
function savePoomsaeAgeGroups(db, competitionId, groups) {
  db.transaction(() => {
    if (countRegistrations(db, competitionId) > 0) throw new Error('Division setup is locked once registrations exist.');
    db.prepare('DELETE FROM poomsae_age_groups WHERE competition_id = ?').run(competitionId);
    const insert = db.prepare('INSERT INTO poomsae_age_groups (competition_id, name, min_age, max_age) VALUES (?, ?, ?, ?)');
    groups.forEach((g) => insert.run(competitionId, g.name, g.min_age, g.max_age));
  })();
}

function getEventDates(db, competitionId) {
  return db
    .prepare('SELECT event_date FROM competition_dates WHERE competition_id = ? ORDER BY event_date')
    .all(competitionId)
    .map((row) => row.event_date);
}

// Expects sorted, unique dates. The first becomes the competition's event_date.
function saveEventDates(db, competitionId, dates) {
  db.transaction(() => {
    db.prepare('DELETE FROM competition_dates WHERE competition_id = ?').run(competitionId);
    const insert = db.prepare('INSERT INTO competition_dates (competition_id, event_date) VALUES (?, ?)');
    dates.forEach((date) => insert.run(competitionId, date));
    db.prepare('UPDATE competitions SET event_date = ? WHERE id = ?').run(dates[0], competitionId);
  })();
}

// Anything the form leaves out comes from the Settings page's competition defaults.
function createCompetition(db, { event_dates: eventDates, ...fields }) {
  const { defaults } = loadSettings(db);
  return db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO competitions (name, event_date, registration_deadline, registration_deadline_time, venue, description, age_basis, status, max_per_club_division, events, poomsae_format, poomsae_cut, map_query,
           bout_courts, bout_start, bout_minutes, bout_rest_minutes, poomsae_courts, poomsae_start, poomsae_minutes, poomsae_rest_minutes, poomsae_judges)
         VALUES (@name, @event_date, @registration_deadline, @registration_deadline_time, @venue, @description, @age_basis, @status, @max_per_club_division, @events, @poomsae_format, @poomsae_cut, @map_query,
           @bout_courts, @bout_start, @bout_minutes, @bout_rest_minutes, @poomsae_courts, @poomsae_start, @poomsae_minutes, @poomsae_rest_minutes, @poomsae_judges)`
      )
      .run({ description: '', status: 'draft', registration_deadline_time: '23:59', events: 'kyorugi', map_query: '', ...defaults.competition, ...fields }).lastInsertRowid;
    saveEventDates(db, id, eventDates || [fields.event_date]);
    saveDivisionSetup(db, id, { ageGroups: defaults.kyorugiAgeGroups, beltGroups: DEFAULT_BELT_GROUPS });
    savePoomsaeAgeGroups(db, id, defaults.poomsaeAgeGroups);
    return Number(id);
  })();
}

// Enters a fighter, or re-enters one who was rejected. Returns { ok, error? }.
function enterFighter(db, competition, fighter, weightClassId) {
  const placement = assignDivision({
    fighter,
    weightClassId,
    competition,
    ...loadDivisionSetup(db, competition.id),
  });
  if (!placement.ok) return placement;

  if (loadSettings(db).requireDocument && !db.prepare('SELECT 1 FROM fighter_documents WHERE fighter_id = ?').get(fighter.id)) {
    return { ok: false, error: `Upload their ${documentLabel(documentTypeFor(fighter.belt_rank))} first.` };
  }

  const existing = db
    .prepare('SELECT id, status FROM registrations WHERE competition_id = ? AND fighter_id = ?')
    .get(competition.id, fighter.id);
  if (existing && existing.status !== 'rejected') {
    return { ok: false, error: 'Already registered for this competition.' };
  }

  // The competition may cap one club's entries in a division. Rejected entries don't count.
  const limit = competition.max_per_club_division;
  if (limit) {
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM registrations
         WHERE competition_id = ? AND club_id = ? AND status != 'rejected' AND age_group_id = ? AND belt_group_id = ? AND weight_class_id = ?`
      )
      .get(competition.id, fighter.club_id, placement.ageGroup.id, placement.beltGroup.id, placement.weightClass.id);
    if (n >= limit) {
      return {
        ok: false,
        error: `Your club already has ${n} athlete${n === 1 ? '' : 's'} in ${placement.weightClass.label} for this age and belt group, the most this competition allows per club.`,
      };
    }
  }

  const values = {
    competition_id: competition.id,
    fighter_id: fighter.id,
    club_id: fighter.club_id,
    age: placement.age,
    age_group_id: placement.ageGroup.id,
    belt_group_id: placement.beltGroup.id,
    weight_class_id: placement.weightClass.id,
  };

  if (existing) {
    db.prepare(
      `UPDATE registrations
       SET age_at_event = @age, age_group_id = @age_group_id,
           belt_group_id = @belt_group_id, weight_class_id = @weight_class_id,
           status = 'pending', review_note = '', reviewed_at = NULL
       WHERE competition_id = @competition_id AND fighter_id = @fighter_id`
    ).run(values);
  } else {
    db.prepare(
      `INSERT INTO registrations
         (competition_id, fighter_id, club_id, age_at_event, age_group_id, belt_group_id, weight_class_id)
       VALUES (@competition_id, @fighter_id, @club_id, @age, @age_group_id, @belt_group_id, @weight_class_id)`
    ).run(values);
  }
  return { ok: true, placement };
}

function saveFighterDocument(db, fighter, { data, contentType, userId = null }) {
  db.prepare(
    `INSERT INTO fighter_documents (fighter_id, doc_type, content_type, data, uploaded_by)
     VALUES (@fighterId, @docType, @contentType, @data, @userId)
     ON CONFLICT(fighter_id) DO UPDATE SET doc_type = excluded.doc_type, content_type = excluded.content_type,
       data = excluded.data, uploaded_by = excluded.uploaded_by, uploaded_at = datetime('now')`
  ).run({ fighterId: fighter.id, docType: documentTypeFor(fighter.belt_rank), contentType, data, userId });
}

function saveCompetitionLogo(db, competitionId, { data, contentType }) {
  db.prepare(
    `INSERT INTO competition_logos (competition_id, content_type, data) VALUES (?, ?, ?)
     ON CONFLICT(competition_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, uploaded_at = datetime('now')`
  ).run(competitionId, contentType, data);
}

function getCompetitionLogo(db, competitionId) {
  return db.prepare('SELECT * FROM competition_logos WHERE competition_id = ?').get(competitionId) || null;
}

function hasCompetitionLogo(db, competitionId) {
  return Boolean(db.prepare('SELECT 1 FROM competition_logos WHERE competition_id = ?').get(competitionId));
}

// When each competition's logo last changed, by competition id, for cache-safe links.
function competitionLogoVersions(db) {
  return new Map(db.prepare('SELECT competition_id, uploaded_at FROM competition_logos').all().map((r) => [r.competition_id, r.uploaded_at]));
}

function listCompetitionPhotos(db, competitionId) {
  return db.prepare('SELECT id, uploaded_at FROM competition_photos WHERE competition_id = ? ORDER BY id').all(competitionId);
}

function getCompetitionPhoto(db, competitionId, photoId) {
  return db.prepare('SELECT id, content_type, data FROM competition_photos WHERE competition_id = ? AND id = ?').get(competitionId, photoId) || null;
}

function addCompetitionPhoto(db, competitionId, { data, contentType, userId = null }) {
  db.prepare('INSERT INTO competition_photos (competition_id, content_type, data, uploaded_by) VALUES (?, ?, ?, ?)').run(competitionId, contentType, data, userId);
}

function deleteCompetitionPhoto(db, competitionId, photoId) {
  return db.prepare('DELETE FROM competition_photos WHERE competition_id = ? AND id = ?').run(competitionId, photoId).changes > 0;
}

function listCompetitionFiles(db, competitionId) {
  return db
    .prepare('SELECT id, competition_id, title, filename, content_type, size, uploaded_at FROM competition_files WHERE competition_id = ? ORDER BY id')
    .all(competitionId);
}

function getCompetitionFile(db, competitionId, fileId) {
  return db.prepare('SELECT * FROM competition_files WHERE competition_id = ? AND id = ?').get(competitionId, fileId) || null;
}

function addCompetitionFile(db, competitionId, { title, filename, contentType, data, userId = null }) {
  return Number(
    db
      .prepare('INSERT INTO competition_files (competition_id, title, filename, content_type, size, data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(competitionId, title, filename, contentType, data.length, data, userId).lastInsertRowid
  );
}

function deleteCompetitionFile(db, competitionId, fileId) {
  return db.prepare('DELETE FROM competition_files WHERE competition_id = ? AND id = ?').run(competitionId, fileId).changes > 0;
}

const NEWS_SELECT =`SELECT n.*, u.full_name AS author FROM news_posts n LEFT JOIN users u ON u.id = n.author_id`;

// Pinned posts first, then newest. Visitors only see public posts.
function listNews(db, { signedIn, limit = 50 }) {
  return db
    .prepare(`${NEWS_SELECT} ${signedIn ? '' : "WHERE n.audience = 'public'"} ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC LIMIT ?`)
    .all(limit);
}

function getNews(db, id, { signedIn = true } = {}) {
  const post = db.prepare(`${NEWS_SELECT} WHERE n.id = ?`).get(id);
  if (!post || (!signedIn && post.audience !== 'public')) return null;
  return post;
}

function createNews(db, values, authorId) {
  return Number(
    db
      .prepare('INSERT INTO news_posts (title, body, audience, pinned, author_id) VALUES (@title, @body, @audience, @pinned, @authorId)')
      .run({ ...values, authorId }).lastInsertRowid
  );
}

function updateNews(db, id, values) {
  return (
    db
      .prepare("UPDATE news_posts SET title = @title, body = @body, audience = @audience, pinned = @pinned, updated_at = datetime('now') WHERE id = @id")
      .run({ ...values, id }).changes > 0
  );
}

function deleteNews(db, id) {
  return db.prepare('DELETE FROM news_posts WHERE id = ?').run(id).changes > 0;
}

function saveClubIcon(db, clubId, { data, contentType, userId = null }) {
  db.prepare(
    `INSERT INTO club_icons (club_id, content_type, data, uploaded_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(club_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data,
       uploaded_by = excluded.uploaded_by, uploaded_at = datetime('now')`
  ).run(clubId, contentType, data, userId);
}

function getClubIcon(db, clubId) {
  return db.prepare('SELECT club_id, content_type, data, uploaded_at FROM club_icons WHERE club_id = ?').get(clubId) || null;
}

function deleteClubIcon(db, clubId) {
  return db.prepare('DELETE FROM club_icons WHERE club_id = ?').run(clubId).changes > 0;
}

// When each club's icon last changed, by club id. Used in icon links so a new
// icon gets a new address and browsers don't show a cached old one.
function clubIconVersions(db) {
  return new Map(db.prepare('SELECT club_id, uploaded_at FROM club_icons').all().map((r) => [r.club_id, r.uploaded_at]));
}

function saveFighterPhoto(db, fighterId, { data, contentType, userId = null }) {
  db.prepare(
    `INSERT INTO fighter_photos (fighter_id, content_type, data, uploaded_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(fighter_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data,
       uploaded_by = excluded.uploaded_by, uploaded_at = datetime('now')`
  ).run(fighterId, contentType, data, userId);
}

function getFighterPhoto(db, fighterId) {
  return db.prepare('SELECT fighter_id, content_type, data, uploaded_at FROM fighter_photos WHERE fighter_id = ?').get(fighterId) || null;
}

function deleteFighterPhoto(db, fighterId) {
  return db.prepare('DELETE FROM fighter_photos WHERE fighter_id = ?').run(fighterId).changes > 0;
}

function getFighterDocument(db, fighterId) {
  return db.prepare('SELECT * FROM fighter_documents WHERE fighter_id = ?').get(fighterId) || null;
}

// An approved registration was checked against this document, so it stays as is.
// Kyorugi registrations or poomsae entries in the given states.
function hasEntryIn(db, fighterId, statuses) {
  const list = statuses.map(() => '?').join(', ');
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM registrations WHERE fighter_id = ? AND status IN (${list})
         UNION ALL
         SELECT 1 FROM poomsae_members m JOIN poomsae_entries e ON e.id = m.entry_id WHERE m.fighter_id = ? AND e.status IN (${list})
         LIMIT 1`
      )
      .get(fighterId, ...statuses, fighterId, ...statuses)
  );
}

function hasApprovedRegistration(db, fighterId) {
  return hasEntryIn(db, fighterId, ['approved']);
}

function hasActiveRegistration(db, fighterId) {
  return hasEntryIn(db, fighterId, ['pending', 'approved']);
}

// Any kyorugi or poomsae entry ever, which keeps the athlete from being deleted.
function hasEntryHistory(db, fighterId) {
  return hasEntryIn(db, fighterId, ['pending', 'approved', 'rejected']);
}

// How a club appears beside its athletes on bout lists, results and screens:
// its country code first when it has one, as in "SGP · Tigers Taekwondo Club".
const clubLabel = (alias) => `CASE WHEN ${alias}.country != '' THEN ${alias}.country || ' · ' || ${alias}.name ELSE ${alias}.name END`;

const POOMSAE_SELECT = `
  SELECT e.*, c.name AS club_name, ${clubLabel('c')} AS club_label, a.name AS age_group, a.min_age, b.name AS belt_group, b.min_rank
  FROM poomsae_entries e
  JOIN clubs c ON c.id = e.club_id
  JOIN poomsae_age_groups a ON a.id = e.age_group_id
  JOIN belt_groups b ON b.id = e.belt_group_id`;

const EVENT_ORDER = "CASE e.event WHEN 'individual' THEN 0 WHEN 'pair' THEN 1 ELSE 2 END";

// A competition's poomsae entries in division order, each with its athletes.
// clubId limits it to one club's entries.
function listPoomsaeEntries(db, competitionId, { clubId = null } = {}) {
  const entries = db
    .prepare(
      `${POOMSAE_SELECT} WHERE e.competition_id = ? ${clubId ? 'AND e.club_id = ?' : ''}
       ORDER BY ${EVENT_ORDER}, a.min_age, e.gender DESC, b.min_rank, e.id`
    )
    .all(...[competitionId, clubId].filter(Boolean));
  const members = db.prepare(
    `SELECT m.entry_id, m.age_at_event, f.id, f.first_name, f.last_name, f.gender, f.belt_rank,
            (SELECT d.doc_type FROM fighter_documents d WHERE d.fighter_id = f.id) AS document_type,
            (SELECT p.uploaded_at FROM fighter_photos p WHERE p.fighter_id = f.id) AS photo_at
     FROM poomsae_members m JOIN fighters f ON f.id = m.fighter_id
     WHERE m.entry_id = ? ORDER BY f.last_name, f.first_name`
  );
  return entries.map((entry) => {
    const athletes = members.all(entry.id);
    return { ...entry, athletes, names: athletes.map((a) => `${a.first_name} ${a.last_name}`).join(', ') };
  });
}

function getPoomsaeEntry(db, competitionId, entryId) {
  return listPoomsaeEntries(db, competitionId).find((e) => e.id === Number(entryId)) || null;
}

// Enters one athlete (individual), two (pair) or three (team) from a club.
// Each athlete can be in one entry per event. Returns { ok, error?, placement }.
function enterPoomsae(db, competition, clubId, event, fighters) {
  const { poomsaeAgeGroups, beltGroups } = loadDivisionSetup(db, competition.id);
  const placement = placeEntry({ event, members: fighters, competition, ageGroups: poomsaeAgeGroups, beltGroups });
  if (!placement.ok) return placement;
  const label = POOMSAE_EVENTS[event].label.toLowerCase();

  const missingDocument = loadSettings(db).requireDocument && fighters.find((f) => !db.prepare('SELECT 1 FROM fighter_documents WHERE fighter_id = ?').get(f.id));
  if (missingDocument) {
    return { ok: false, error: `Upload the ${documentLabel(documentTypeFor(missingDocument.belt_rank))} of ${missingDocument.first_name} ${missingDocument.last_name} first.` };
  }
  const inEvent = db.prepare(
    `SELECT 1 FROM poomsae_members m JOIN poomsae_entries e ON e.id = m.entry_id
     WHERE m.fighter_id = ? AND e.competition_id = ? AND e.event = ? AND e.status != 'rejected'`
  );
  const taken = fighters.find((f) => inEvent.get(f.id, competition.id, event));
  if (taken) return { ok: false, error: `${taken.first_name} ${taken.last_name} is already in a ${label} entry.` };

  const limit = competition.max_per_club_division;
  if (limit) {
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM poomsae_entries
         WHERE competition_id = ? AND club_id = ? AND status != 'rejected' AND event = ? AND gender = ? AND age_group_id = ? AND belt_group_id = ?`
      )
      .get(competition.id, clubId, event, placement.gender, placement.ageGroup.id, placement.beltGroup.id);
    if (n >= limit) {
      return { ok: false, error: `Your club already has ${n} ${label} entr${n === 1 ? 'y' : 'ies'} in this division, the most this competition allows per club.` };
    }
  }

  const id = db.transaction(() => {
    const entryId = db
      .prepare('INSERT INTO poomsae_entries (competition_id, club_id, event, gender, age_group_id, belt_group_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(competition.id, clubId, event, placement.gender, placement.ageGroup.id, placement.beltGroup.id).lastInsertRowid;
    const insertMember = db.prepare('INSERT INTO poomsae_members (entry_id, fighter_id, age_at_event) VALUES (?, ?, ?)');
    fighters.forEach((f, i) => insertMember.run(entryId, f.id, placement.ages[i]));
    return Number(entryId);
  })();
  return { ok: true, id, placement };
}

// A club takes back an entry that isn't approved yet.
function withdrawPoomsae(db, competitionId, clubId, entryId) {
  return db.prepare("DELETE FROM poomsae_entries WHERE id = ? AND competition_id = ? AND club_id = ? AND status != 'approved'").run(entryId, competitionId, clubId).changes > 0;
}

const poomsaeKey = (e) => [e.event, e.gender, e.age_group_id, e.belt_group_id].join('-');

// Each division's own choices (format, cut, day), by division key.
function loadPoomsaeSettings(db, competitionId) {
  return new Map(db.prepare('SELECT * FROM poomsae_divisions WHERE competition_id = ?').all(competitionId).map((row) => [row.division_key, row]));
}

// The competition with one division's own format and cut in place of its defaults.
function divisionRules(competition, setting) {
  return {
    ...competition,
    poomsae_format: (setting && setting.format) || competition.poomsae_format,
    poomsae_cut: (setting && setting.cut) || competition.poomsae_cut,
  };
}

function hasPoomsaeBracket(db, competitionId, key) {
  return Boolean(db.prepare('SELECT 1 FROM poomsae_bouts WHERE competition_id = ? AND division_key = ? LIMIT 1').get(competitionId, key));
}

// Approve, reject or move back to pending. A scored entry, or one in a division
// with a bracket, stays as it is, so placings and the draw never change behind
// the judges' backs. Returns { ok, error? }.
function reviewPoomsae(db, competitionId, entryId, decision, note = '') {
  const entry = db.prepare('SELECT * FROM poomsae_entries WHERE id = ? AND competition_id = ?').get(entryId, competitionId);
  if (!entry) return { ok: false, error: 'That entry no longer exists.' };
  if (entry.score !== null) return { ok: false, error: 'This entry has a score. Clear the score first.' };
  if (hasPoomsaeBracket(db, competitionId, poomsaeKey(entry))) return { ok: false, error: 'This division has a bracket. Delete the bracket first.' };
  if (entry.perform_order !== null) return { ok: false, error: 'This entry is in a performance list. Clear the list first.' };
  if (decision === 'rejected' && !note) return { ok: false, error: 'Add a reason when rejecting, so the club knows what to fix.' };
  if (entry.status === decision) return { ok: true, changed: false };
  db.prepare("UPDATE poomsae_entries SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(decision, decision === 'rejected' ? note : '', entry.id);
  return { ok: true, changed: true };
}

// Records (or clears, with null) the score of an approved entry once registration has closed.
// Scores count in a ranked division or a score round, never once its bracket is drawn.
// With several judges, marks are each judge's score and score is worked out from them.
function recordPoomsaeScore(db, competition, entryId, score, marks = null) {
  if (competition.status !== 'closed') return { ok: false, error: 'Scores can be recorded once registration closes.' };
  const entry = db.prepare("SELECT * FROM poomsae_entries WHERE id = ? AND competition_id = ? AND status = 'approved'").get(entryId, competition.id);
  if (!entry) return { ok: false, error: 'Only approved entries can be scored.' };
  const key = poomsaeKey(entry);
  if (hasPoomsaeBracket(db, competition.id, key)) return { ok: false, error: 'The bracket is drawn from these scores. Delete the bracket to change them.' };
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM poomsae_entries WHERE competition_id = ? AND status = 'approved' AND event = ? AND gender = ? AND age_group_id = ? AND belt_group_id = ?")
    .get(competition.id, entry.event, entry.gender, entry.age_group_id, entry.belt_group_id);
  if (divisionMode(divisionRules(competition, loadPoomsaeSettings(db, competition.id).get(key)), n) === 'bracket') return { ok: false, error: 'This division goes straight to single elimination, so it has no scores.' };
  db.transaction(() => {
    db.prepare("UPDATE poomsae_entries SET score = ?, scored_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE id = ?").run(score, score, entry.id);
    db.prepare('DELETE FROM poomsae_judge_scores WHERE entry_id = ?').run(entry.id);
    const insert = db.prepare('INSERT INTO poomsae_judge_scores (entry_id, judge, score) VALUES (?, ?, ?)');
    if (score !== null && marks) marks.forEach((mark, i) => insert.run(entry.id, i + 1, mark));
  })();
  return { ok: true };
}

// Each entry's judges' marks, by entry id: an array with judge N's mark at N - 1,
// and gaps for judges who haven't scored yet (from their phones).
function loadJudgeMarks(db, competitionId) {
  const marks = new Map();
  db.prepare(
    `SELECT j.entry_id, j.judge, j.score FROM poomsae_judge_scores j JOIN poomsae_entries e ON e.id = j.entry_id
     WHERE e.competition_id = ? ORDER BY j.entry_id, j.judge`
  ).all(competitionId).forEach((row) => {
    if (!marks.has(row.entry_id)) marks.set(row.entry_id, []);
    marks.get(row.entry_id)[row.judge - 1] = row.score;
  });
  return marks;
}

function hasPoomsaeScores(db, competitionId) {
  return Boolean(db.prepare('SELECT 1 FROM poomsae_entries WHERE competition_id = ? AND score IS NOT NULL LIMIT 1').get(competitionId));
}

// Scores or brackets: either keeps registration closed and the format fixed.
function hasPoomsaeResults(db, competitionId) {
  return hasPoomsaeScores(db, competitionId)
    || Boolean(db.prepare('SELECT 1 FROM poomsae_bouts WHERE competition_id = ? LIMIT 1').get(competitionId))
    || Boolean(db.prepare('SELECT 1 FROM poomsae_entries WHERE competition_id = ? AND perform_order IS NOT NULL LIMIT 1').get(competitionId));
}

// Every drawn poomsae bracket, by division key, in the shape bracket.js expects:
// sides carry registrationId (here the entry id), name, club, clubId and seed.
function loadPoomsaeBrackets(db, competitionId, entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const brackets = new Map();
  db.prepare('SELECT * FROM poomsae_bouts WHERE competition_id = ? ORDER BY division_key, round, position').all(competitionId).forEach((row) => {
    const side = (color) => {
      const entry = byId.get(row[`${color}_entry_id`]);
      return entry ? { registrationId: entry.id, name: entry.names, club: entry.club_label, clubId: entry.club_id, seed: row[`${color}_seed`] } : null;
    };
    const blue = side('blue');
    const red = side('red');
    if (!brackets.has(row.division_key)) brackets.set(row.division_key, []);
    brackets.get(row.division_key).push({
      id: row.id, round: row.round, totalRounds: row.total_rounds, position: row.position, number: row.bout_number,
      time: row.start_time || '', day: row.day, court: row.court,
      isBye: row.is_bye === 1, blue, red, winner: [blue, red].find((s) => s && s.registrationId === row.winner_entry_id) || null,
    });
  });
  brackets.forEach((bouts) => bouts.forEach((bout) => {
    const feeder = (position) => bouts.find((b) => b.round === bout.round - 1 && b.position === position);
    bout.bluePlaceholder = bout.blue ? '' : `Winner of Bout ${(feeder(bout.position * 2) || {}).number}`;
    bout.redPlaceholder = bout.red ? '' : `Winner of Bout ${(feeder(bout.position * 2 + 1) || {}).number}`;
  }));
  return brackets;
}

// Entries grouped into divisions, each ranked by score, with its mode (score,
// bracket, or a score round then a bracket), its bracket once drawn, and medals.
// Rejected entries are left out.
function poomsaeDivisions(entries, competition, brackets = new Map(), settings = new Map()) {
  const divisions = new Map();
  entries.filter((e) => e.status !== 'rejected').forEach((e) => {
    const key = poomsaeKey(e);
    if (!divisions.has(key)) divisions.set(key, { key, title: poomsaeDivisionTitle(e), entries: [] });
    divisions.get(key).entries.push(e);
  });
  return [...divisions.values()].map((d) => {
    const approved = rankEntries(d.entries.filter((e) => e.status === 'approved'));
    const bouts = brackets.get(d.key) || null;
    const setting = settings.get(d.key) || null;
    const rules = divisionRules(competition, setting);
    const mode = divisionMode(rules, approved.length);
    const draw = mode === 'score' || bouts ? null : bracketEntrants(rules, approved);
    const place = bouts && bouts.find((b) => b.day);
    const order = approved.filter((e) => e.perform_order !== null).sort((a, b) => a.perform_order - b.perform_order);
    return {
      ...d,
      mode,
      entries: [...approved, ...d.entries.filter((e) => e.status === 'pending')],
      scored: approved.filter((e) => e.score !== null).length,
      approved: approved.length,
      pending: d.entries.filter((e) => e.status === 'pending').length,
      bouts,
      rules,
      format: rules.poomsae_format,
      cut: rules.poomsae_cut,
      // Whether this division chose its own format, or uses the competition's.
      ownFormat: Boolean(setting && setting.format),
      ownCut: setting ? setting.cut : null,
      pinnedDay: setting ? setting.day : null,
      day: place ? place.day : null,
      court: place ? place.court : null,
      locked: Boolean(bouts) || approved.some((e) => e.score !== null) || order.length > 0,
      // The random order entries perform in, for a ranked division or a score round.
      order,
      listDay: setting ? setting.list_day : null,
      listCourt: setting ? setting.list_court : null,
      canOrder: mode !== 'score' && mode !== 'cut' ? false : !approved.some((e) => e.score !== null) && d.entries.every((e) => e.status !== 'pending') && approved.length > 0,
      layout: bouts ? layoutBracket(bouts, { slotHeight: 30, top: 4 }) : null,
      drawProblem: draw && !draw.ok ? draw.error : null,
      medalists: poomsaeMedalists(mode, approved, bouts),
    };
  });
}

// Draws one division's bracket: at random with clubs kept apart, or seeded by
// the score round's ranking. Returns { ok, error? }.
function drawPoomsaeBracket(db, competition, key, rng = secureRandom) {
  return db.transaction(() => {
    const division = poomsaeDivisions(listPoomsaeEntries(db, competition.id), competition, new Map(), loadPoomsaeSettings(db, competition.id)).find((d) => d.key === key);
    if (!division) return { ok: false, error: 'That division was not found.' };
    if (hasPoomsaeBracket(db, competition.id, key)) return { ok: false, error: 'This division already has a bracket.' };
    if (division.pending > 0) return { ok: false, error: 'Approve or reject the pending entries in this division first.' };
    const ranked = division.entries.filter((e) => e.status === 'approved');
    const draw = bracketEntrants(division.rules, ranked);
    if (!draw.ok) return draw;
    const sides = draw.entrants.map((e) => ({ registrationId: e.id, clubId: e.club_id }));
    const rounds = draw.seeded ? roundsFromSlots(seededSlots(sides)) : buildBracket(sides, rng);
    const insert = db.prepare(
      `INSERT INTO poomsae_bouts (competition_id, division_key, round, total_rounds, position, bout_number, blue_entry_id, red_entry_id, is_bye, blue_seed, red_seed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let number = 0;
    rounds.forEach((bouts, r) => bouts.forEach((bout, position) => {
      insert.run(
        competition.id, key, r + 1, rounds.length, position, bout.isBye ? null : (number += 1),
        bout.blue ? bout.blue.registrationId : null, bout.red ? bout.red.registrationId : null, bout.isBye ? 1 : 0,
        bout.blue && draw.seeded ? bout.blue.seed : null, bout.red && draw.seeded ? bout.red.seed : null
      );
    }));
    db.prepare(
      `INSERT INTO poomsae_divisions (competition_id, division_key, bracket_seq) VALUES (?, ?, ?)
       ON CONFLICT(competition_id, division_key) DO UPDATE SET bracket_seq = excluded.bracket_seq`
    ).run(competition.id, key, nextPoomsaeSeq(db, competition.id));
    applyPoomsaeSchedule(db, competition.id);
    return { ok: true, entrants: draw.entrants.length, title: division.title };
  })();
}

// A bracket can be drawn again only while nobody has won a bout in it.
function deletePoomsaeBracket(db, competitionId, key) {
  if (db.prepare('SELECT 1 FROM poomsae_bouts WHERE competition_id = ? AND division_key = ? AND winner_entry_id IS NOT NULL').get(competitionId, key)) {
    return { ok: false, error: 'Clear the bracket results first.' };
  }
  const removed = db.prepare('DELETE FROM poomsae_bouts WHERE competition_id = ? AND division_key = ?').run(competitionId, key).changes;
  if (removed === 0) return { ok: false, error: 'That division has no bracket.' };
  applyPoomsaeSchedule(db, competitionId);
  return { ok: true };
}

// Gives every drawn bracket its day, court, bout numbers and times, in the order
// the brackets were drawn (see schedulePoomsae). Who meets whom doesn't change.
function nextPoomsaeSeq(db, competitionId) {
  return db.prepare('SELECT COALESCE(MAX(MAX(COALESCE(list_seq, 0), COALESCE(bracket_seq, 0))), 0) + 1 AS n FROM poomsae_divisions WHERE competition_id = ?').get(competitionId).n;
}

function applyPoomsaeSchedule(db, competitionId) {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(competitionId);
  const settings = loadPoomsaeSettings(db, competitionId);
  const setting = (key) => settings.get(key) || {};
  const rows = db.prepare('SELECT id, division_key, round, position, is_bye FROM poomsae_bouts WHERE competition_id = ? ORDER BY id').all(competitionId);
  const units = new Map();
  rows.forEach((row) => {
    if (!units.has(row.division_key)) {
      // Brackets drawn before sequence numbers existed go after the rest, in draw order.
      units.set(row.division_key, { key: row.division_key, seq: setting(row.division_key).bracket_seq ?? 1e9 + row.id, day: setting(row.division_key).day ?? null, bouts: [] });
    }
    units.get(row.division_key).bouts.push({ ...row, isBye: row.is_bye === 1 });
  });
  const performers = db
    .prepare("SELECT id, event, gender, age_group_id, belt_group_id FROM poomsae_entries WHERE competition_id = ? AND status = 'approved' AND perform_order IS NOT NULL ORDER BY perform_order")
    .all(competitionId);
  performers.forEach((entry) => {
    const key = poomsaeKey(entry);
    const unit = `list:${key}`;
    if (!units.has(unit)) units.set(unit, { key: unit, division: key, seq: setting(key).list_seq ?? 0, day: setting(key).day ?? null, list: [] });
    units.get(unit).list.push(`e${entry.id}`);
  });
  const [hours, mins] = competition.poomsae_start.split(':').map(Number);
  const { places, slots } = schedulePoomsae([...units.values()].sort((a, b) => a.seq - b.seq), {
    days: getEventDates(db, competitionId).length,
    courts: competition.poomsae_courts,
    start: hours * 60 + mins,
    minutes: competition.poomsae_minutes,
    rest: competition.poomsae_rest_minutes,
  });
  const update = db.prepare('UPDATE poomsae_bouts SET day = ?, court = ?, bout_number = ?, start_time = ? WHERE id = ?');
  const time = db.prepare('UPDATE poomsae_entries SET perform_time = ? WHERE id = ?');
  const listPlace = db.prepare('UPDATE poomsae_divisions SET list_day = ?, list_court = ? WHERE competition_id = ? AND division_key = ?');
  db.transaction(() => {
    rows.forEach((row) => {
      const place = places.get(row.division_key);
      const slot = slots.get(row.id);
      update.run(place.day, place.court, slot ? slot.number : null, slot ? formatTime(slot.start) : null, row.id);
    });
    performers.forEach((entry) => time.run(formatTime(slots.get(`e${entry.id}`).start), entry.id));
    units.forEach((unit) => {
      if (unit.list) listPlace.run(places.get(unit.key).day, places.get(unit.key).court, competitionId, unit.division);
    });
  })();
}

// A random performance order for ranked divisions and score rounds: key, or
// "all" for every division that's ready. Only while a division has no scores.
// A division ordered again keeps its place in the schedule. Returns { ok, error?, titles }.
function generatePoomsaeOrder(db, competition, key, rng = secureRandom) {
  if (competition.status !== 'closed') return { ok: false, error: 'Close registration before making performance lists.' };
  return db.transaction(() => {
    const entries = listPoomsaeEntries(db, competition.id);
    const settings = loadPoomsaeSettings(db, competition.id);
    const divisions = poomsaeDivisions(entries, competition, loadPoomsaeBrackets(db, competition.id, entries), settings);
    const targets = key === 'all' ? divisions.filter((d) => d.canOrder && d.order.length === 0) : divisions.filter((d) => d.key === key);
    if (targets.length === 0) return { ok: false, error: key === 'all' ? 'No divisions are waiting for a performance list.' : 'That division was not found.' };
    const refused = targets.find((d) => !d.canOrder);
    if (refused) {
      return { ok: false, error: refused.mode === 'bracket' ? `${refused.title} goes straight to a bracket.` : `${refused.title} has scores or pending entries, so its order stays.` };
    }
    const order = db.prepare('UPDATE poomsae_entries SET perform_order = ? WHERE id = ?');
    const seq = db.prepare(
      `INSERT INTO poomsae_divisions (competition_id, division_key, list_seq) VALUES (?, ?, ?)
       ON CONFLICT(competition_id, division_key) DO UPDATE SET list_seq = COALESCE(poomsae_divisions.list_seq, excluded.list_seq)`
    );
    targets.forEach((d) => {
      const ids = d.entries.filter((e) => e.status === 'approved').map((e) => e.id);
      for (let i = ids.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      ids.forEach((id, i) => order.run(i + 1, id));
      seq.run(competition.id, d.key, nextPoomsaeSeq(db, competition.id));
    });
    applyPoomsaeSchedule(db, competition.id);
    return { ok: true, titles: targets.map((d) => d.title) };
  })();
}

// Titled like the kyorugi bout list: "POOMSAE INDIVIDUAL BLACK BELT, Junior (U18), Female".
function boutListTitle(d) {
  const e = d.entries[0];
  return `POOMSAE ${POOMSAE_EVENTS[e.event].label.toUpperCase()} ${e.belt_group.toUpperCase()}, ${e.age_group}, ${POOMSAE_GENDERS[e.gender]}`;
}

// The poomsae "bout list": each performance order and bracket as its own page,
// in running order (day, court, start). clubId keeps only divisions where that
// club has an entry; published keeps only the stages published so far (lists,
// brackets). Pages carry what the PDF and web page both draw.
function poomsaeBoutList(db, competition, { clubId = null, published = false } = {}) {
  const show = published
    ? { list: Boolean(competition.poomsae_published_at), bracket: Boolean(competition.poomsae_brackets_published_at) }
    : { list: true, bracket: true };
  const entries = listPoomsaeEntries(db, competition.id);
  const divisions = poomsaeDivisions(entries, competition, loadPoomsaeBrackets(db, competition.id, entries), loadPoomsaeSettings(db, competition.id));
  const dates = getEventDates(db, competition.id);
  const dayLabel = (day) => (day && dates[day - 1] ? `${day} (${formatDay(dates[day - 1])})` : day ? String(day) : '-');
  const pages = [];
  divisions
    .filter((d) => !clubId || d.entries.some((e) => e.club_id === clubId && e.status === 'approved'))
    .forEach((d) => {
      if (d.order.length > 0) {
        pages.push({
          kind: 'list', key: d.key, title: boutListTitle(d), day: d.listDay, court: d.listCourt, start: d.order[0].perform_time || '',
          meta: [`Day: ${dayLabel(d.listDay)}`, `Poomsae court: ${d.listCourt || '-'}`, `Entries: ${d.order.length}`, `Starts: ${d.order[0].perform_time || '-'}`],
          performers: d.order.map((e) => ({ id: e.id, name: e.names, club: e.club_label, clubId: e.club_id, time: e.perform_time })),
          dayLabel: dayLabel(d.listDay),
        });
      }
      if (d.bouts) {
        const matches = d.bouts.filter((b) => !b.isBye).length;
        const times = d.bouts.map((b) => b.time).filter(Boolean).sort();
        pages.push({
          kind: 'bracket', key: d.key, title: `${boutListTitle(d)}${d.mode === 'cut' ? ' - FINAL ROUND' : ''}`, day: d.day, court: d.court, start: times[0] || '',
          meta: [`Day: ${dayLabel(d.day)}`, `Poomsae court: ${d.court || '-'}`, `Entries: ${d.bouts.filter((b) => b.round === 1).reduce((n, b) => n + (b.blue ? 1 : 0) + (b.red ? 1 : 0), 0)}`, `Bouts: ${matches}`],
          bouts: d.bouts, matches, layout: d.layout, dayLabel: dayLabel(d.day),
        });
      }
    });
  return pages.filter((p) => show[p.kind]).sort((a, b) => (a.day || 99) - (b.day || 99) || (a.court || 99) - (b.court || 99) || String(a.start).localeCompare(String(b.start)));
}

// Everything on the poomsae courts, in time order: each performer of a
// performance list, and each bracket bout (byes left out). done: scored, or a
// winner recorded. published keeps only the stages coaches can see.
function poomsaeCourtItems(db, competition, { published = false } = {}) {
  const entries = listPoomsaeEntries(db, competition.id);
  const divisions = poomsaeDivisions(entries, competition, loadPoomsaeBrackets(db, competition.id, entries), loadPoomsaeSettings(db, competition.id));
  const showLists = !published || Boolean(competition.poomsae_published_at);
  const showBrackets = !published || Boolean(competition.poomsae_brackets_published_at);
  const items = [];
  divisions.forEach((d) => {
    if (showLists && d.listCourt) {
      d.order.forEach((e) => items.push({
        kind: 'perform', id: e.id, day: d.listDay, court: d.listCourt, time: e.perform_time || '', title: d.title,
        name: e.names, club: e.club_label, score: e.score, done: e.score !== null, place: e.perform_order, of: d.order.length,
      }));
    }
    if (showBrackets && d.bouts && d.court) {
      d.bouts.filter((b) => !b.isBye).forEach((b) => items.push({ ...b, kind: 'bout', day: d.day, court: d.court, title: d.title, done: Boolean(b.winner) }));
    }
  });
  return items.sort((a, b) => a.day - b.day || a.court - b.court || a.time.localeCompare(b.time) || (a.number || 0) - (b.number || 0));
}

// One poomsae court on one day: what's on now (the first unfinished item that
// can start: a performer always can, a bout once both sides are known), what's
// next, and what finished last.
function poomsaeCourtQueue(db, competition, day, court, options = {}) {
  const items = poomsaeCourtItems(db, competition, options).filter((i) => i.day === day && i.court === court);
  const waiting = items.filter((i) => !i.done);
  const now = waiting.find((i) => i.kind === 'perform' || (i.blue && i.red)) || null;
  return {
    items,
    now,
    blockedBy: !now && waiting.length > 0 ? waiting[0] : null,
    next: waiting.filter((i) => i !== now).slice(0, 3),
    recent: items.filter((i) => i.done).slice(-3).reverse(),
    done: items.length - waiting.length,
  };
}

// The whole bout list as one running order: each kyorugi division and each
// poomsae performance list or bracket, sorted by day, then court (kyorugi courts
// first), then start time. published keeps only what visitors may see; event
// ('kyorugi' or 'poomsae') and clubId (divisions that club is in) narrow it.
// Each part has what its card and the PDF draw, plus anchor and courtLabel.
function competitionProgramme(db, competition, { published = false, event = null, clubId = null } = {}) {
  const parts = [];
  if (event !== 'poomsae' && hasKyorugi(competition) && (!published || competition.bouts_published_at)) {
    loadBoutList(db, competition.id)
      .filter((d) => !clubId || d.bouts.some((b) => [b.blue, b.red].some((s) => s && s.clubId === clubId)))
      .forEach((d) => {
        const times = d.bouts.map((b) => b.time).filter(Boolean).sort();
        parts.push({
          ...d, kind: 'kyorugi', event: 'Kyorugi', anchor: `kyorugi-${d.key}`, courtOrder: 0,
          courtLabel: d.court ? `Court ${d.court}` : 'No court', start: times[0] || '',
          layout: layoutBracket(d.bouts, { slotHeight: 30, top: 4 }),
        });
      });
  }
  if (event !== 'kyorugi' && hasPoomsae(competition)) {
    poomsaeBoutList(db, competition, { published, clubId }).forEach((p) => parts.push({
      ...p, event: 'Poomsae', anchor: `poomsae-${p.kind}-${p.key}`, courtOrder: 1,
      courtLabel: p.court ? `Poomsae court ${p.court}` : 'No court',
    }));
  }
  return parts.sort((a, b) => (a.day || 99) - (b.day || 99) || a.courtOrder - b.courtOrder
    || (a.court || 99) - (b.court || 99) || String(a.start).localeCompare(String(b.start)));
}

// The competition's final results: every division with its medallists (gold
// decided), and one club medal table for kyorugi and poomsae together.
// published keeps only what visitors may see: the kyorugi bout list once
// published, ranked poomsae once its order is published, poomsae brackets once
// the brackets are. Medallists carry name, club and clubId only.
function competitionResults(db, competition, { published = false, event = null } = {}) {
  const divisions = [];
  if (event !== 'poomsae' && hasKyorugi(competition) && (!published || competition.bouts_published_at)) {
    computeMedals(loadBoutList(db, competition.id)).divisions.forEach((d) => {
      if (!d.gold) return;
      const side = (f) => ({ name: f.name, club: f.club, clubId: f.clubId });
      divisions.push({ event: 'Kyorugi', title: d.title, gold: [side(d.gold)], silver: d.silver ? [side(d.silver)] : [], bronze: d.bronze.map(side) });
    });
  }
  if (event !== 'kyorugi' && hasPoomsae(competition)) {
    const entries = listPoomsaeEntries(db, competition.id);
    const byId = new Map(entries.map((e) => [e.id, { name: e.names, club: e.club_label, clubId: e.club_id }]));
    poomsaeDivisions(entries, competition, loadPoomsaeBrackets(db, competition.id, entries), loadPoomsaeSettings(db, competition.id)).forEach((d) => {
      const visible = d.mode === 'score' ? competition.poomsae_published_at : competition.poomsae_brackets_published_at;
      if ((published && !visible) || d.medalists.gold.length === 0) return;
      const people = (ids) => ids.map((id) => byId.get(id));
      divisions.push({ event: 'Poomsae', title: boutListTitle(d), gold: people(d.medalists.gold), silver: people(d.medalists.silver), bronze: people(d.medalists.bronze) });
    });
  }
  const clubs = new Map();
  divisions.forEach((d) => ['gold', 'silver', 'bronze'].forEach((medal) => d[medal].forEach((m) => {
    if (!clubs.has(m.clubId)) clubs.set(m.clubId, { clubId: m.clubId, club: m.club, gold: 0, silver: 0, bronze: 0 });
    clubs.get(m.clubId)[medal] += 1;
  })));
  const table = [...clubs.values()].sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.club.localeCompare(b.club));
  return { divisions, table };
}

// One judge's mark for a performer on their court, from the judge's phone.
// seat is { day, court, judge }. The mark can be changed until every judge has
// sent theirs; then the score is worked out (judgesScore) and saved like one
// entered on the mat page. Returns { ok, error?, complete, score, performer }.
function submitJudgeMark(db, competition, seat, entryId, mark) {
  if (competition.status !== 'closed') return { ok: false, error: 'Scoring opens once registration closes.' };
  const performer = poomsaeCourtItems(db, competition)
    .find((i) => i.kind === 'perform' && i.id === Number(entryId) && i.day === seat.day && i.court === seat.court);
  if (!performer) return { ok: false, error: 'That performer is not on your court.' };
  if (performer.score !== null) return { ok: false, error: `${performer.name} already has a score. Ask the official on the mat to change it.` };
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO poomsae_judge_scores (entry_id, judge, score) VALUES (?, ?, ?)
       ON CONFLICT(entry_id, judge) DO UPDATE SET score = excluded.score`
    ).run(performer.id, seat.judge, mark);
    const marks = db.prepare('SELECT judge, score FROM poomsae_judge_scores WHERE entry_id = ? AND judge <= ? ORDER BY judge').all(performer.id, competition.poomsae_judges);
    if (marks.length < competition.poomsae_judges) return { ok: true, complete: false, performer };
    const all = marks.map((m) => m.score);
    const score = judgesScore(all);
    const saved = recordPoomsaeScore(db, competition, performer.id, score, all);
    return saved.ok ? { ok: true, complete: true, score, performer } : saved;
  })();
}

// Removes a division's performance list, while it has no scores.
function clearPoomsaeOrder(db, competition, key) {
  return db.transaction(() => {
    const entries = listPoomsaeEntries(db, competition.id).filter((e) => poomsaeKey(e) === key);
    if (!entries.some((e) => e.perform_order !== null)) return { ok: false, error: 'That division has no performance list.' };
    if (entries.some((e) => e.score !== null)) return { ok: false, error: 'Clear the scores first.' };
    entries.forEach((e) => db.prepare('UPDATE poomsae_entries SET perform_order = NULL, perform_time = NULL WHERE id = ?').run(e.id));
    db.prepare('UPDATE poomsae_divisions SET list_seq = NULL, list_day = NULL, list_court = NULL WHERE competition_id = ? AND division_key = ?').run(competition.id, key);
    applyPoomsaeSchedule(db, competition.id);
    return { ok: true, title: poomsaeDivisionTitle(entries[0]) };
  })();
}

// The poomsae courts and timings. Callers validate first. Reschedules every bracket.
function savePoomsaeSchedule(db, competitionId, { courts, start, minutes, rest, judges }) {
  db.transaction(() => {
    db.prepare('UPDATE competitions SET poomsae_courts = ?, poomsae_start = ?, poomsae_minutes = ?, poomsae_rest_minutes = ?, poomsae_judges = ? WHERE id = ?')
      .run(courts, start, minutes, rest, judges, competitionId);
    applyPoomsaeSchedule(db, competitionId);
  })();
}

// One division's own format, cut and day (null keeps the competition's, or an
// automatic day). The format and cut stay as they are once the division has
// scores or a bracket; the day can change any time. Returns { ok, error?, kept }.
function savePoomsaeDivision(db, competition, key, choice) {
  const entries = listPoomsaeEntries(db, competition.id);
  const settings = loadPoomsaeSettings(db, competition.id);
  const division = poomsaeDivisions(entries, competition, loadPoomsaeBrackets(db, competition.id, entries), settings).find((d) => d.key === key);
  if (!division) return { ok: false, error: 'That division was not found.' };
  const current = settings.get(key) || { format: null, cut: null };
  const kept = division.locked && (choice.format !== current.format || choice.cut !== current.cut);
  const { format, cut } = division.locked ? current : choice;
  const { day } = choice;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO poomsae_divisions (competition_id, division_key, format, cut, day) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(competition_id, division_key) DO UPDATE SET format = excluded.format, cut = excluded.cut, day = excluded.day`
    ).run(competition.id, key, format, cut, day);
    applyPoomsaeSchedule(db, competition.id);
  })();
  return { ok: true, title: division.title, kept, format, cut, day };
}

function nextPoomsaeBout(db, bout) {
  const next = db
    .prepare('SELECT * FROM poomsae_bouts WHERE competition_id = ? AND division_key = ? AND round = ? AND position = ?')
    .get(bout.competition_id, bout.division_key, bout.round + 1, Math.floor(bout.position / 2));
  return { next, column: bout.position % 2 === 0 ? 'blue_entry_id' : 'red_entry_id' };
}

// Records a bracket winner ('blue' or 'red', or null to clear) and moves them on,
// as kyorugi results do. A result can't change once the next bout has one.
function recordPoomsaeBout(db, competitionId, boutId, side) {
  return db.transaction(() => {
    const bout = db.prepare('SELECT * FROM poomsae_bouts WHERE id = ? AND competition_id = ?').get(boutId, competitionId);
    if (!bout || bout.is_bye) return { ok: false, error: 'That bout was not found.' };
    const { next, column } = nextPoomsaeBout(db, bout);
    if (next && next.winner_entry_id) return { ok: false, error: `Clear the result of Bout ${next.bout_number} first, because it depends on this one.` };
    if (side === null) {
      if (!bout.winner_entry_id) return { ok: false, error: 'That bout has no result.' };
      db.prepare('UPDATE poomsae_bouts SET winner_entry_id = NULL WHERE id = ?').run(bout.id);
      if (next) db.prepare(`UPDATE poomsae_bouts SET ${column} = NULL WHERE id = ?`).run(next.id);
      return { ok: true };
    }
    if (!bout.blue_entry_id || !bout.red_entry_id) return { ok: false, error: 'Both sides must be known before recording this bout.' };
    const winner = side === 'blue' ? bout.blue_entry_id : side === 'red' ? bout.red_entry_id : null;
    if (!winner) return { ok: false, error: 'Choose a winner.' };
    db.prepare('UPDATE poomsae_bouts SET winner_entry_id = ? WHERE id = ?').run(winner, bout.id);
    if (next) db.prepare(`UPDATE poomsae_bouts SET ${column} = ? WHERE id = ?`).run(winner, next.id);
    return { ok: true, key: bout.division_key, number: bout.bout_number };
  })();
}

const REGISTRATION_SELECT = `
  SELECT r.*, f.first_name, f.last_name, f.gender, f.date_of_birth, f.belt_rank,
         c.name AS club_name, c.country AS club_country, a.name AS age_group, a.min_age,
         b.name AS belt_group, b.min_rank, w.label AS weight_class, w.max_kg,
         (SELECT d.doc_type FROM fighter_documents d WHERE d.fighter_id = r.fighter_id) AS document_type,
         (SELECT p.uploaded_at FROM fighter_photos p WHERE p.fighter_id = r.fighter_id) AS photo_at
  FROM registrations r
  JOIN fighters f ON f.id = r.fighter_id
  JOIN clubs c ON c.id = r.club_id
  JOIN age_groups a ON a.id = r.age_group_id
  JOIN belt_groups b ON b.id = r.belt_group_id
  JOIN weight_classes w ON w.id = r.weight_class_id`;

const DIVISION_ORDER = `a.min_age, f.gender DESC, b.min_rank, w.max_kg IS NULL, w.max_kg, f.last_name, f.first_name`;

function hasBoutList(db, competitionId) {
  return Boolean(db.prepare('SELECT 1 FROM bouts WHERE competition_id = ? LIMIT 1').get(competitionId));
}

function deleteBoutList(db, competitionId) {
  db.prepare('DELETE FROM bouts WHERE competition_id = ?').run(competitionId);
}

function secureRandom() {
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

function divisionKey(row) {
  return [row.gender, row.age_group_id, row.belt_group_id, row.weight_class_id].join('-');
}

// Pinned days by division key. Days beyond the competition's dates are ignored.
function loadDivisionDays(db, competitionId) {
  const days = getEventDates(db, competitionId).length;
  return new Map(
    db
      .prepare('SELECT * FROM division_days WHERE competition_id = ?')
      .all(competitionId)
      .filter((row) => row.day >= 1 && row.day <= days)
      .map((row) => [divisionKey(row), row.day])
  );
}

// Pins divisions to days. `choices` maps division key to a day number, or to
// null for automatic. Keys that aren't divisions in the bout list are ignored.
function saveDivisionDays(db, competitionId, choices) {
  const days = getEventDates(db, competitionId).length;
  const known = new Map(
    db
      .prepare('SELECT DISTINCT gender, age_group_id, belt_group_id, weight_class_id FROM bouts WHERE competition_id = ?')
      .all(competitionId)
      .map((row) => [divisionKey(row), row])
  );
  const remove = db.prepare(
    'DELETE FROM division_days WHERE competition_id = ? AND gender = ? AND age_group_id = ? AND belt_group_id = ? AND weight_class_id = ?'
  );
  const insert = db.prepare(
    `INSERT INTO division_days (competition_id, gender, age_group_id, belt_group_id, weight_class_id, day)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let pinned = 0;
  db.transaction(() => {
    Object.entries(choices).forEach(([key, value]) => {
      const division = known.get(key);
      if (!division) return;
      const ids = [competitionId, division.gender, division.age_group_id, division.belt_group_id, division.weight_class_id];
      remove.run(...ids);
      const day = Number(value);
      if (value !== null && value !== '' && Number.isInteger(day) && day >= 1 && day <= days) {
        insert.run(...ids, day);
        pinned += 1;
      }
    });
  })();
  return pinned;
}

// Sets each division's day and court, then numbers and times its bouts, keeping
// each fighter's rest between bouts. Numbering restarts for each court on each
// day. Doesn't change who fights whom.
function applySchedule(db, competitionId) {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(competitionId);
  const rows = db
    .prepare(
      `SELECT bt.id, bt.gender, bt.age_group_id, bt.belt_group_id, bt.weight_class_id, bt.is_bye, bt.round, bt.position
       FROM bouts bt
       JOIN age_groups a ON a.id = bt.age_group_id
       JOIN belt_groups bg ON bg.id = bt.belt_group_id
       JOIN weight_classes w ON w.id = bt.weight_class_id
       WHERE bt.competition_id = ?
       ORDER BY a.min_age, bt.gender DESC, bg.min_rank, w.max_kg IS NULL, w.max_kg, bt.round, bt.position`
    )
    .all(competitionId);

  const divisions = new Map();
  rows.forEach((row) => {
    const key = divisionKey(row);
    divisions.set(key, [...(divisions.get(key) || []), { ...row, isBye: row.is_bye === 1 }]);
  });

  const keys = [...divisions.keys()];
  const list = [...divisions.values()];
  const pinned = loadDivisionDays(db, competitionId);
  const places = assignCourts(
    list.map((bouts) => bouts.filter((b) => !b.isBye).length),
    {
      courts: competition.bout_courts,
      days: getEventDates(db, competitionId).length,
      fixedDays: keys.map((key) => pinned.get(key) ?? null),
    }
  );
  const [startHours, startMinutes] = competition.bout_start.split(':').map(Number);
  const options = { start: startHours * 60 + startMinutes, minutes: competition.bout_minutes, rest: competition.bout_rest_minutes };

  const courts = new Map();
  list.forEach((bouts, i) => {
    const { day, court } = places[i];
    if (court === null) return;
    const key = `${day}:${court}`;
    courts.set(key, [...(courts.get(key) || []), bouts]);
  });
  const times = new Map();
  courts.forEach((courtDivisions) => {
    scheduleCourt(courtDivisions, options).forEach((slot, id) => times.set(id, slot));
  });

  const update = db.prepare('UPDATE bouts SET day = ?, court = ?, bout_number = ?, start_time = ? WHERE id = ?');
  db.transaction(() => {
    list.forEach((bouts, i) => {
      const { day, court } = places[i];
      bouts.forEach((bout) => {
        const slot = times.get(bout.id);
        update.run(day, court, slot ? slot.number : null, slot ? formatTime(slot.start) : null, bout.id);
      });
    });
  })();
}

// Athletes who didn't turn up or were disqualified at weigh-in aren't drawn.
const DRAWN = "r.status = 'approved' AND (r.weigh_status IS NULL OR r.weigh_status = 'passed') AND r.withdrawn_at IS NULL";

// Approved athletes and their weigh-in result, in division order.
function listWeighIns(db, competitionId) {
  return db
    .prepare(
      `${REGISTRATION_SELECT.replace('FROM registrations r', ', ew.label AS entered_weight_class FROM registrations r')}
       LEFT JOIN weight_classes ew ON ew.id = r.entered_weight_class_id
       WHERE r.competition_id = ? AND r.status = 'approved' ORDER BY ${DIVISION_ORDER}`
    )
    .all(competitionId);
}

function weighInCounts(db, competitionId) {
  const counts = { waiting: 0, passed: 0, moved: 0, no_show: 0, disqualified: 0, total: 0 };
  db.prepare("SELECT weigh_status, entered_weight_class_id FROM registrations WHERE competition_id = ? AND status = 'approved'")
    .all(competitionId)
    .forEach((r) => {
      counts.total += 1;
      if (!r.weigh_status) counts.waiting += 1;
      else counts[r.weigh_status] += 1;
      if (r.entered_weight_class_id) counts.moved += 1;
    });
  return counts;
}

// The weight classes an approved registration could move between: same
// competition, age group and gender.
function classesForRegistration(db, registration) {
  return db
    .prepare(
      `SELECT w.* FROM weight_classes w
       WHERE w.competition_id = ? AND w.age_group_id = ? AND w.gender = (SELECT gender FROM fighters WHERE id = ?)
       ORDER BY w.max_kg IS NULL, w.max_kg`
    )
    .all(registration.competition_id, registration.age_group_id, registration.fighter_id);
}

// Records one weigh-in step for an approved registration. Actions:
// check (weightKg): marks it passed if the weight makes the entered class,
//   otherwise changes nothing and returns the class it fits instead.
// move (weightClassId): moves to another class of the same age group and gender, passed.
// no_show, disqualify: leave the athlete out of the draw.
// reset: back to not weighed, and back to the entered class if they were moved.
// The weigh-in can also run after the bout list is drawn. Then nobody changes
// class, and a no-show or disqualified athlete gives their opponent a walkover
// (returned as walkovers: bout ids). Undoing it takes the walkovers back.
function recordWeighIn(db, competition, registrationId, { action, weightKg, weightClassId }) {
  if (competition.status !== 'closed') return { ok: false, error: 'Close registration before the weigh-in.' };
  const registration = db
    .prepare("SELECT * FROM registrations WHERE id = ? AND competition_id = ? AND status = 'approved'")
    .get(registrationId, competition.id);
  if (!registration) return { ok: false, error: 'That athlete is not an approved entry in this competition.' };
  const drawn = hasBoutList(db, competition.id);
  if (drawn && action === 'move') {
    return { ok: false, error: 'The bout list is drawn, so nobody can change weight class. Keep them in their class if they are lighter, or disqualify them to give their opponent a walkover.' };
  }

  const classes = classesForRegistration(db, registration);
  const labelOf = (id) => (classes.find((c) => c.id === id) || {}).label;
  const save = db.prepare(
    `UPDATE registrations SET weigh_status = @status, weighed_at = @at, weight_class_id = @classId,
       entered_weight_class_id = @enteredId WHERE id = @id`
  );
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const base = { id: registration.id, classId: registration.weight_class_id, enteredId: registration.entered_weight_class_id, at: now };

  if (action === 'check') {
    const result = checkWeight(classes, registration.weight_class_id, weightKg);
    if (!result.ok) return result;
    if (!result.made) {
      const enteredClass = classes.find((c) => c.id === registration.weight_class_id);
      // Under the class rather than over it: many events let them fight up.
      const lighter = result.fits.max_kg !== null && (enteredClass.max_kg === null || result.fits.max_kg < enteredClass.max_kg);
      return { ok: true, outcome: 'out_of_class', fits: result.fits, entered: enteredClass.label, lighter };
    }
    save.run({ ...base, status: 'passed' });
    return { ok: true, outcome: 'passed', weightClass: labelOf(registration.weight_class_id) };
  }
  // Only after a check found them lighter than their class; the route enforces that.
  if (action === 'keep') {
    save.run({ ...base, status: 'passed' });
    return { ok: true, outcome: 'kept', weightClass: labelOf(registration.weight_class_id) };
  }
  if (action === 'move') {
    const target = classes.find((c) => c.id === Number(weightClassId));
    if (!target) return { ok: false, error: 'Choose a weight class for their age group and gender.' };
    const enteredId = registration.entered_weight_class_id || registration.weight_class_id;
    save.run({ ...base, status: 'passed', classId: target.id, enteredId: target.id === enteredId ? null : enteredId });
    return { ok: true, outcome: 'moved', from: labelOf(registration.weight_class_id), to: target.label };
  }
  if (action === 'no_show' || action === 'disqualify') {
    return db.transaction(() => {
      save.run({ ...base, status: action === 'no_show' ? 'no_show' : 'disqualified' });
      return { ok: true, outcome: action, drawn, walkovers: drawn ? applyWalkovers(db, competition.id) : [] };
    })();
  }
  if (action === 'reset') {
    // Undoing the weigh-in would put the old weight class back without the old age group.
    if (registration.merged_from) return { ok: false, error: 'This athlete was moved to another division. Undo that on the Divisions page first.' };
    if (drawn && registration.entered_weight_class_id) return { ok: false, error: 'The bout list is drawn, so they stay in the class they were moved to.' };
    try {
      return undoWeighIn();
    } catch (error) {
      if (error.refusal) return { ok: false, error: `${error.message} Their opponent's walkover is still in place.` };
      throw error;
    }
  }
  return { ok: false, error: 'Unknown weigh-in action.' };

  function undoWeighIn() {
    return db.transaction(() => {
      // Their opponents' walkovers go, latest first. A later result built on one blocks the undo.
      const lost = db
        .prepare('SELECT id FROM bouts WHERE competition_id = ? AND walkover = 1 AND winner_registration_id != ? AND ? IN (blue_registration_id, red_registration_id) ORDER BY round DESC')
        .all(competition.id, registration.id, registration.id);
      for (const bout of lost) {
        const cleared = clearResult(db, competition.id, bout.id);
        if (!cleared.ok) throw Object.assign(new Error(cleared.error), { refusal: true });
      }
      // A no contest they were in: the walkover it gave the next bout goes first.
      const contests = db
        .prepare('SELECT * FROM bouts WHERE competition_id = ? AND no_contest = 1 AND ? IN (blue_registration_id, red_registration_id) ORDER BY round DESC')
        .all(competition.id, registration.id);
      for (const bout of contests) {
        const { next } = nextBoutOf(db, bout);
        if (next && (next.no_contest || (next.winner_registration_id && !next.walkover))) {
          throw Object.assign(new Error(`Bout ${next.bout_number} depends on this athlete's no contest.`), { refusal: true });
        }
        if (next && next.winner_registration_id) {
          const cleared = clearResult(db, competition.id, next.id);
          if (!cleared.ok) throw Object.assign(new Error(cleared.error), { refusal: true });
        }
        db.prepare('UPDATE bouts SET no_contest = 0 WHERE id = ?').run(bout.id);
      }
      const enteredId = registration.entered_weight_class_id || registration.weight_class_id;
      save.run({ ...base, status: null, at: null, classId: enteredId, enteredId: null });
      // Their opponent in an undone no contest may still be out, so this athlete now gets the walkover.
      const walkovers = drawn ? applyWalkovers(db, competition.id) : [];
      return { ok: true, outcome: 'reset', backTo: registration.entered_weight_class_id ? labelOf(enteredId) : null, walkoversUndone: lost.length + contests.length, walkovers };
    })();
  }
}

// Writes one division's rounds as bouts. `division` has its gender and group ids.
function writeDivisionBouts(db, competitionId, division, rounds) {
  const insert = db.prepare(
    `INSERT INTO bouts (competition_id, gender, age_group_id, belt_group_id, weight_class_id, round, total_rounds,
       position, blue_registration_id, red_registration_id, is_bye, blue_seed, red_seed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  rounds.forEach((bouts, roundIndex) => {
    bouts.forEach((bout, position) => {
      insert.run(
        competitionId, division.gender, division.age_group_id, division.belt_group_id, division.weight_class_id,
        roundIndex + 1, rounds.length, position,
        bout.blue ? bout.blue.registrationId : null,
        bout.red ? bout.red.registrationId : null,
        bout.isBye ? 1 : 0,
        bout.blue ? bout.blue.seed : null,
        bout.red ? bout.red.seed : null
      );
    });
  });
}

const DIVISION_WHERE = 'competition_id = ? AND gender = ? AND age_group_id = ? AND belt_group_id = ? AND weight_class_id = ?';

function divisionFromKey(key) {
  const match = /^([MF])-(\d+)-(\d+)-(\d+)$/.exec(String(key || ''));
  if (!match) return null;
  return { gender: match[1], age_group_id: Number(match[2]), belt_group_id: Number(match[3]), weight_class_id: Number(match[4]) };
}

const divisionIds = (competitionId, d) => [competitionId, d.gender, d.age_group_id, d.belt_group_id, d.weight_class_id];

// Draws every division from the approved registrations, replacing any earlier
// draw. Returns the number of fighters drawn.
function generateBoutList(db, competitionId, rng = secureRandom) {
  const approved = db
    .prepare(`${REGISTRATION_SELECT} WHERE r.competition_id = ? AND ${DRAWN} ORDER BY ${DIVISION_ORDER}`)
    .all(competitionId);

  const divisions = new Map();
  approved.forEach((r) => {
    const key = [r.gender, r.age_group_id, r.belt_group_id, r.weight_class_id].join('-');
    divisions.set(key, [...(divisions.get(key) || []), r]);
  });

  db.transaction(() => {
    deleteBoutList(db, competitionId);
    divisions.forEach((registrations) => {
      const entries = registrations.map((r) => ({ registrationId: r.id, clubId: r.club_id }));
      writeDivisionBouts(db, competitionId, registrations[0], buildBracket(entries, rng));
    });
    applySchedule(db, competitionId);
  })();
  return approved.length;
}

// Checks a manual change to one division can go ahead. Returns the division or an error.
function editableDivision(db, competition, key) {
  const division = divisionFromKey(key);
  if (!division) return { ok: false, error: 'Unknown division.' };
  const ids = divisionIds(competition.id, division);
  if (!db.prepare(`SELECT 1 FROM bouts WHERE ${DIVISION_WHERE} LIMIT 1`).get(...ids)) return { ok: false, error: 'That division has no bouts.' };
  if (db.prepare(`SELECT 1 FROM bouts WHERE ${DIVISION_WHERE} AND winner_registration_id IS NOT NULL LIMIT 1`).get(...ids)) {
    return { ok: false, error: 'This division has results. Undo them before changing its bracket.' };
  }
  return { ok: true, division, ids };
}

// The division's first-round slots, top to bottom, as { registrationId, clubId, seed } or null.
function firstRoundSlots(db, ids) {
  const rows = db.prepare(`SELECT * FROM bouts WHERE ${DIVISION_WHERE} AND round = 1 ORDER BY position`).all(...ids);
  const clubOf = (regId) => (regId ? db.prepare('SELECT club_id FROM registrations WHERE id = ?').get(regId).club_id : null);
  const slot = (regId, seed) => (regId ? { registrationId: regId, clubId: clubOf(regId), seed } : null);
  if (rows.length === 1 && rows[0].is_bye && rows[0].total_rounds === 1) return [slot(rows[0].blue_registration_id || rows[0].red_registration_id, 1)];
  return rows.flatMap((r) => [slot(r.blue_registration_id, r.blue_seed), slot(r.red_registration_id, r.red_seed)]);
}

function replaceDivision(db, competitionId, division, ids, slots) {
  db.transaction(() => {
    db.prepare(`DELETE FROM bouts WHERE ${DIVISION_WHERE}`).run(...ids);
    const real = slots.filter(Boolean);
    if (real.length > 0) writeDivisionBouts(db, competitionId, division, roundsFromSlots(slotsAreValid(slots) ? slots : seededSlots(real)));
    applySchedule(db, competitionId);
  })();
}

// Swaps two athletes' places in a division's first round. Seeds belong to the
// places, so each takes the other's seed.
function swapAthletes(db, competition, key, registrationA, registrationB) {
  const check = editableDivision(db, competition, key);
  if (!check.ok) return check;
  const slots = firstRoundSlots(db, check.ids);
  const a = slots.findIndex((s) => s && s.registrationId === Number(registrationA));
  const b = slots.findIndex((s) => s && s.registrationId === Number(registrationB));
  if (a === -1 || b === -1 || a === b) return { ok: false, error: 'Choose two different athletes from this division.' };
  [slots[a], slots[b]] = [{ ...slots[b], seed: slots[a].seed }, { ...slots[a], seed: slots[b].seed }];
  replaceDivision(db, competition.id, check.division, check.ids, slots);
  return { ok: true };
}

// Takes an athlete out of a drawn division. Their first opponent gets a bye. If
// they had the bye themselves, the division is laid out again in seed order.
function withdrawAthlete(db, competition, key, registrationId, note = '') {
  const check = editableDivision(db, competition, key);
  if (!check.ok) return check;
  const slots = firstRoundSlots(db, check.ids);
  const index = slots.findIndex((s) => s && s.registrationId === Number(registrationId));
  if (index === -1) return { ok: false, error: 'That athlete is not in this division.' };
  slots[index] = null;
  const reseeded = !slotsAreValid(slots);
  db.transaction(() => {
    db.prepare("UPDATE registrations SET withdrawn_at = datetime('now'), withdrawal_note = ? WHERE id = ?").run(note, Number(registrationId));
    replaceDivision(db, competition.id, check.division, check.ids, reseeded ? seededSlots(slots.filter(Boolean).sort((x, y) => x.seed - y.seed)) : slots);
  })();
  return { ok: true, reseeded };
}

// Puts a withdrawn athlete back and redraws their division to include them,
// which only works while that division has no results.
function reinstateAthlete(db, competition, registrationId) {
  const registration = db
    .prepare(
      `SELECT r.*, f.gender FROM registrations r JOIN fighters f ON f.id = r.fighter_id
       WHERE r.id = ? AND r.competition_id = ? AND r.withdrawn_at IS NOT NULL`
    )
    .get(Number(registrationId), competition.id);
  if (!registration) return { ok: false, error: 'That athlete is not withdrawn.' };
  const key = divisionKey(registration);
  const ids = divisionIds(competition.id, divisionFromKey(key));
  if (db.prepare(`SELECT 1 FROM bouts WHERE ${DIVISION_WHERE} AND winner_registration_id IS NOT NULL LIMIT 1`).get(...ids)) {
    return { ok: false, error: 'Their division has results, so they can\'t be put back in. Undo its results first.' };
  }
  let redraw;
  db.transaction(() => {
    db.prepare("UPDATE registrations SET withdrawn_at = NULL, withdrawal_note = '' WHERE id = ?").run(registration.id);
    redraw = redrawDivision(db, competition, key);
  })();
  return { ok: true, key, athletes: redraw.athletes };
}

// Draws one division again from its current entries, leaving the others alone.
function redrawDivision(db, competition, key, rng = secureRandom) {
  const division = divisionFromKey(key);
  if (!division) return { ok: false, error: 'Unknown division.' };
  const ids = divisionIds(competition.id, division);
  if (db.prepare(`SELECT 1 FROM bouts WHERE ${DIVISION_WHERE} AND winner_registration_id IS NOT NULL LIMIT 1`).get(...ids)) {
    return { ok: false, error: 'This division has results. Undo them before redrawing it.' };
  }
  const entries = db
    .prepare(
      `SELECT r.id AS registrationId, r.club_id AS clubId FROM registrations r JOIN fighters f ON f.id = r.fighter_id
       WHERE r.competition_id = ? AND f.gender = ? AND r.age_group_id = ? AND r.belt_group_id = ? AND r.weight_class_id = ? AND ${DRAWN}`
    )
    .all(...ids);
  db.transaction(() => {
    db.prepare(`DELETE FROM bouts WHERE ${DIVISION_WHERE}`).run(...ids);
    if (entries.length > 0) writeDivisionBouts(db, competition.id, division, buildBracket(entries, rng));
    applySchedule(db, competition.id);
  })();
  return { ok: true, athletes: entries.length };
}

// A division key's parts, checked against the competition: the age group, belt
// group and weight class must be its own, and the class must belong to that age
// group and gender. Returns the parts, or null.
function realDivision(db, competitionId, key) {
  const d = divisionFromKey(key);
  if (!d) return null;
  const ok = db.prepare('SELECT 1 FROM age_groups WHERE id = ? AND competition_id = ?').get(d.age_group_id, competitionId)
    && db.prepare('SELECT 1 FROM belt_groups WHERE id = ? AND competition_id = ?').get(d.belt_group_id, competitionId)
    && db.prepare('SELECT 1 FROM weight_classes WHERE id = ? AND competition_id = ? AND age_group_id = ? AND gender = ?')
      .get(d.weight_class_id, competitionId, d.age_group_id, d.gender);
  return ok ? d : null;
}

// Moves every active entry (pending or approved) of one division into another
// of the same gender, so a lone athlete gets an opponent. Each entry remembers
// where it came from, for undo. Not while a bout list exists, like approvals.
function mergeDivision(db, competition, fromKey, toKey) {
  if (hasBoutList(db, competition.id)) return { ok: false, error: 'Delete the bout list before moving athletes between divisions.' };
  const from = realDivision(db, competition.id, fromKey);
  const to = realDivision(db, competition.id, toKey);
  if (!from || !to) return { ok: false, error: 'Choose a division from this competition.' };
  if (fromKey === toKey) return { ok: false, error: 'Choose a different division to move them into.' };
  if (from.gender !== to.gender) return { ok: false, error: 'Athletes can only move to a division of the same gender.' };
  const moving = db
    .prepare(
      `SELECT r.id, r.club_id, f.first_name, f.last_name FROM registrations r JOIN fighters f ON f.id = r.fighter_id
       WHERE r.competition_id = ? AND r.status != 'rejected' AND f.gender = ? AND r.age_group_id = ? AND r.belt_group_id = ? AND r.weight_class_id = ?`
    )
    .all(competition.id, from.gender, from.age_group_id, from.belt_group_id, from.weight_class_id);
  if (moving.length === 0) return { ok: false, error: 'That division has no entries to move.' };
  const update = db.prepare(
    `UPDATE registrations SET age_group_id = ?, belt_group_id = ?, weight_class_id = ?, merged_from = COALESCE(merged_from, ?)
     WHERE id = ?`
  );
  db.transaction(() => moving.forEach((r) => update.run(to.age_group_id, to.belt_group_id, to.weight_class_id, fromKey, r.id)))();
  return { ok: true, moved: moving.map((r) => ({ id: r.id, clubId: r.club_id, name: `${r.first_name} ${r.last_name}` })) };
}

// Puts a merged entry back in the division it was moved out of.
function unmergeRegistration(db, competition, registrationId) {
  if (hasBoutList(db, competition.id)) return { ok: false, error: 'Delete the bout list before moving athletes between divisions.' };
  const registration = db
    .prepare('SELECT * FROM registrations WHERE id = ? AND competition_id = ? AND merged_from IS NOT NULL')
    .get(Number(registrationId), competition.id);
  const from = registration && realDivision(db, competition.id, registration.merged_from);
  if (!from) return { ok: false, error: 'That entry was not moved.' };
  db.prepare('UPDATE registrations SET age_group_id = ?, belt_group_id = ?, weight_class_id = ?, merged_from = NULL WHERE id = ?')
    .run(from.age_group_id, from.belt_group_id, from.weight_class_id, registration.id);
  return { ok: true, key: registration.merged_from };
}

// Withdrawn athletes per division key, for the bout list page.
function listWithdrawn(db, competitionId) {
  return db
    .prepare(
      `SELECT r.id, r.withdrawal_note, r.age_group_id, r.belt_group_id, r.weight_class_id, f.gender, f.first_name, f.last_name, c.name AS club_name
       FROM registrations r JOIN fighters f ON f.id = r.fighter_id JOIN clubs c ON c.id = r.club_id
       WHERE r.competition_id = ? AND r.withdrawn_at IS NOT NULL ORDER BY f.last_name, f.first_name`
    )
    .all(competitionId)
    .map((r) => ({ ...r, key: divisionKey(r) }));
}

function ageLabel(row, competition) {
  const year = Number(competition.event_date.slice(0, 4));
  const openEnded = row.max_age >= 90;
  if (competition.age_basis === 'year') {
    return openEnded
      ? `${row.age_group} ${year - row.min_age} & earlier`
      : `${row.age_group} ${year - row.max_age}-${year - row.min_age}`;
  }
  return openEnded ? `${row.age_group} ${row.min_age}+ yrs` : `${row.age_group} ${row.min_age}-${row.max_age} yrs`;
}

// Every real bout (no byes) with its division, day and court, in running order.
// Used by court screens and the results-by-mat page.
function listBouts(db, competitionId) {
  return loadBoutList(db, competitionId)
    .flatMap((division) => division.bouts
      .filter((b) => !b.isBye)
      .map((b) => ({ ...b, title: division.title, day: division.day, court: division.court })))
    .sort((a, b) => a.day - b.day || a.court - b.court || a.number - b.number);
}

// Shapes the stored draw for the web page and the PDF, one entry per division.
function loadBoutList(db, competitionId) {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(competitionId);
  const eventDates = getEventDates(db, competitionId);
  const rows = db
    .prepare(
      `SELECT bt.*, a.name AS age_group, a.min_age, a.max_age, bg.name AS belt_group, w.label AS weight_class,
         fb.first_name AS blue_first, fb.last_name AS blue_last, ${clubLabel('cb')} AS blue_club, cb.id AS blue_club_id,
         fr.first_name AS red_first, fr.last_name AS red_last, ${clubLabel('cr')} AS red_club, cr.id AS red_club_id
       FROM bouts bt
       JOIN age_groups a ON a.id = bt.age_group_id
       JOIN belt_groups bg ON bg.id = bt.belt_group_id
       JOIN weight_classes w ON w.id = bt.weight_class_id
       LEFT JOIN registrations rb ON rb.id = bt.blue_registration_id
       LEFT JOIN fighters fb ON fb.id = rb.fighter_id
       LEFT JOIN clubs cb ON cb.id = rb.club_id
       LEFT JOIN registrations rr ON rr.id = bt.red_registration_id
       LEFT JOIN fighters fr ON fr.id = rr.fighter_id
       LEFT JOIN clubs cr ON cr.id = rr.club_id
       WHERE bt.competition_id = ?
       ORDER BY bg.min_rank, a.min_age, bt.gender DESC, w.max_kg IS NULL, w.max_kg, bt.round, bt.position`
    )
    .all(competitionId);

  const divisions = new Map();
  rows.forEach((row) => {
    const key = divisionKey(row);
    if (!divisions.has(key)) {
      divisions.set(key, {
        key,
        title: `KYORUGI ${row.belt_group.toUpperCase()}, ${ageLabel(row, competition)}, ${GENDERS[row.gender]}, ${row.weight_class}`,
        day: row.day,
        dayLabel: eventDates[row.day - 1] ? `${row.day} (${formatDay(eventDates[row.day - 1])})` : String(row.day),
        court: row.court,
        bouts: [],
      });
    }
    const side = (color) => {
      if (!row[`${color}_registration_id`]) return null;
      return {
        seed: row[`${color}_seed`],
        registrationId: row[`${color}_registration_id`],
        name: `${row[`${color}_last`]} ${row[`${color}_first`]}`,
        club: row[`${color}_club`],
        clubId: row[`${color}_club_id`],
      };
    };
    const blue = side('blue');
    const red = side('red');
    const winnerId = row.winner_registration_id;
    divisions.get(key).bouts.push({
      id: row.id,
      round: row.round,
      totalRounds: row.total_rounds,
      position: row.position,
      number: row.bout_number,
      time: row.start_time,
      isBye: row.is_bye === 1,
      blue,
      red,
      winner: [blue, red].find((s) => s && s.registrationId === winnerId) || null,
      walkover: row.walkover === 1,
      winType: row.win_type,
      score: row.score,
      noContest: row.no_contest === 1,
    });
  });

  return [...divisions.values()].map((division) => {
    const firstRound = division.bouts.filter((b) => b.round === 1);
    const feederLabel = (bout, position) => {
      const feeder = division.bouts.find((b) => b.round === bout.round - 1 && b.position === position);
      return feeder ? `Winner of Bout ${feeder.number}` : '';
    };
    division.bouts.forEach((bout) => {
      bout.bluePlaceholder = bout.blue ? '' : feederLabel(bout, bout.position * 2);
      bout.redPlaceholder = bout.red ? '' : feederLabel(bout, bout.position * 2 + 1);
    });
    return {
      ...division,
      participants: firstRound.reduce((sum, b) => sum + (b.blue ? 1 : 0) + (b.red ? 1 : 0), 0),
      matches: division.bouts.filter((b) => !b.isBye).length,
    };
  });
}

// Settles every bout a weigh-in decides. One side out (a no-show or
// disqualified) gives the other a walkover. Both sides out makes the bout a
// no contest, decided with nobody going through, and then the athlete waiting
// in the next bout gets the walkover instead. It repeats as winners move on,
// so a walkover also follows once an opponent from an earlier bout is known.
// Returns what it settled: [{ id, noContest }].
function applyWalkovers(db, competitionId) {
  const out = new Set(
    db.prepare("SELECT id FROM registrations WHERE competition_id = ? AND weigh_status IN ('no_show', 'disqualified')").all(competitionId).map((r) => r.id)
  );
  const settled = [];
  if (out.size === 0) return settled;
  const win = db.prepare('UPDATE bouts SET winner_registration_id = ?, walkover = 1, win_type = NULL, score = NULL WHERE id = ?');
  const noContest = db.prepare('UPDATE bouts SET no_contest = 1 WHERE id = ?');
  // A walkover goes to someone who is now out too (weigh-ins happen one at a
  // time): it becomes a no contest, unless a real result already depends on it.
  // Walkovers it passed on to the next bout are taken back first.
  const unwind = (bout) => {
    const { next } = nextBoutOf(db, bout);
    if (next && next.no_contest) return false;
    if (next && next.winner_registration_id && (!next.walkover || !clearResult(db, competitionId, next.id).ok)) return false;
    return clearResult(db, competitionId, bout.id).ok;
  };
  let more = true;
  while (more) {
    more = false;
    const stale = db
      .prepare('SELECT * FROM bouts WHERE competition_id = ? AND walkover = 1 ORDER BY round DESC, position')
      .all(competitionId)
      .find((bout) => out.has(bout.winner_registration_id) && unwind(bout));
    if (stale) {
      noContest.run(stale.id);
      settled.push({ id: stale.id, noContest: true });
      more = true;
      continue;
    }
    const bouts = db.prepare('SELECT * FROM bouts WHERE competition_id = ? ORDER BY round, position').all(competitionId);
    const byPlace = new Map(bouts.map((b) => [`${divisionKey(b)}:${b.round}:${b.position}`, b]));
    // 'in', 'out', or 'waiting' for an earlier bout. A side fed by a no contest is out.
    const side = (bout, color, position) => {
      const id = bout[`${color}_registration_id`];
      if (id) return out.has(id) ? 'out' : 'in';
      const feeder = bout.round > 1 && byPlace.get(`${divisionKey(bout)}:${bout.round - 1}:${position}`);
      return feeder && feeder.no_contest ? 'out' : 'waiting';
    };
    for (const bout of bouts) {
      if (bout.is_bye || bout.winner_registration_id || bout.no_contest) continue;
      const blue = side(bout, 'blue', bout.position * 2);
      const red = side(bout, 'red', bout.position * 2 + 1);
      let winner = null;
      if (blue === 'out' && red === 'out') {
        noContest.run(bout.id);
        settled.push({ id: bout.id, noContest: true });
        more = true;
        break;
      } else if (blue === 'out' && red === 'in') winner = bout.red_registration_id;
      else if (red === 'out' && blue === 'in') winner = bout.blue_registration_id;
      if (!winner) continue;
      const { next, column } = nextBoutOf(db, bout);
      if (next && (next.winner_registration_id || next.no_contest)) continue;
      win.run(winner, bout.id);
      if (next) db.prepare(`UPDATE bouts SET ${column} = ? WHERE id = ?`).run(winner, next.id);
      settled.push({ id: bout.id, noContest: false });
      more = true;
      break;
    }
  }
  return settled;
}

function hasResults(db, competitionId) {
  return Boolean(
    db.prepare('SELECT 1 FROM bouts WHERE competition_id = ? AND winner_registration_id IS NOT NULL LIMIT 1').get(competitionId)
  );
}

function nextBoutOf(db, bout) {
  const next = db
    .prepare(
      `SELECT * FROM bouts WHERE competition_id = ? AND gender = ? AND age_group_id = ? AND belt_group_id = ?
         AND weight_class_id = ? AND round = ? AND position = ?`
    )
    .get(bout.competition_id, bout.gender, bout.age_group_id, bout.belt_group_id, bout.weight_class_id, bout.round + 1, Math.floor(bout.position / 2));
  return { next, column: bout.position % 2 === 0 ? 'blue_registration_id' : 'red_registration_id' };
}

// Records a winner and moves them into their next bout. Returns { ok, error? }.
// A result can't change once the next bout has one, or that bout would be wrong.
// details: { winType, score } (both optional, checked by the caller) for how it was won.
function recordResult(db, competitionId, boutId, side, { winType = null, score = null } = {}) {
  return db.transaction(() => {
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ? AND competition_id = ?').get(boutId, competitionId);
    if (!bout || bout.is_bye) return { ok: false, error: 'That bout was not found.' };
    if (!bout.blue_registration_id || !bout.red_registration_id) {
      return { ok: false, error: 'Both fighters must be known before recording this bout.' };
    }
    const winnerId = side === 'blue' ? bout.blue_registration_id : side === 'red' ? bout.red_registration_id : null;
    if (!winnerId) return { ok: false, error: 'Choose a winner.' };

    if (bout.no_contest) return { ok: false, error: 'This bout is a no contest: both athletes were out at the weigh-in.' };
    const { next, column } = nextBoutOf(db, bout);
    if (next && (next.winner_registration_id || next.no_contest)) {
      return { ok: false, error: `Clear the result of Bout ${next.bout_number} first, because it depends on this one.` };
    }
    db.prepare('UPDATE bouts SET winner_registration_id = ?, win_type = ?, score = ? WHERE id = ?').run(winnerId, winType, score, bout.id);
    if (next) db.prepare(`UPDATE bouts SET ${column} = ? WHERE id = ?`).run(winnerId, next.id);
    return { ok: true };
  })();
}

function clearResult(db, competitionId, boutId) {
  return db.transaction(() => {
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ? AND competition_id = ?').get(boutId, competitionId);
    if (!bout || !bout.winner_registration_id) return { ok: false, error: 'That bout has no result.' };
    const { next, column } = nextBoutOf(db, bout);
    if (next && (next.winner_registration_id || next.no_contest)) {
      return { ok: false, error: `Clear the result of Bout ${next.bout_number} first, because it depends on this one.` };
    }
    db.prepare('UPDATE bouts SET winner_registration_id = NULL, walkover = 0, win_type = NULL, score = NULL WHERE id = ?').run(bout.id);
    if (next) db.prepare(`UPDATE bouts SET ${column} = NULL WHERE id = ?`).run(next.id);
    return { ok: true };
  })();
}

// Clears from the last round back, so every fighter returns to where they started.
function clearAllResults(db, competitionId) {
  db.transaction(() => {
    db.prepare('UPDATE bouts SET no_contest = 0 WHERE competition_id = ?').run(competitionId);
    db.prepare('SELECT id FROM bouts WHERE competition_id = ? AND winner_registration_id IS NOT NULL ORDER BY round DESC')
      .all(competitionId)
      .forEach((bout) => clearResult(db, competitionId, bout.id));
    // Walkovers come from the weigh-in, not from a result, so they stay.
    applyWalkovers(db, competitionId);
  })();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Returns a token to email, or null if one was issued moments ago, which stops
// anyone flooding a person's inbox.
function createPasswordReset(db, userId, now = Date.now()) {
  const recent = db.prepare('SELECT 1 FROM password_resets WHERE user_id = ? AND created_at > ?').get(userId, now - RESET_COOLDOWN_MS);
  if (recent) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.transaction(() => {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, hashToken(token), now + RESET_LIFETIME_MS, now);
  })();
  return token;
}

function findPasswordReset(db, token, now = Date.now()) {
  return db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), now) || null;
}

// Sets the new password, uses up the token, and logs the person out everywhere.
async function completePasswordReset(db, token, password) {
  const reset = findPasswordReset(db, token);
  if (!reset) return false;
  const hash = await bcrypt.hash(password, 12);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, reset.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.user_id);
    db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(reset.user_id);
  })();
  return true;
}

// The site's first admin, made at start-up, is its owner.
async function createAdmin(db, email, password) {
  const hash = await bcrypt.hash(password, 12);
  const owner = db.prepare('SELECT 1 FROM users WHERE owner = 1').get() ? 0 : 1;
  db.prepare("INSERT INTO users (email, password_hash, role, owner) VALUES (?, ?, 'admin', ?)").run(email, hash, owner);
}

// A one-time password for an emailed invite: 12 letters and digits, without
// look-alikes (0/O, 1/l/I), so it can be typed from the email.
function oneTimePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (byte) => alphabet[byte % alphabet.length]).join('');
}

// A sub-admin: the same powers as an admin, minus the owner's few. They log in
// with the emailed one-time password and must choose their own straight away.
// Returns { id, password }.
async function createSubAdmin(db, { full_name, email }) {
  const password = oneTimePassword();
  const hash = await bcrypt.hash(password, 12);
  const id = Number(db.prepare("INSERT INTO users (email, password_hash, role, full_name, must_change_password) VALUES (?, ?, 'admin', ?, 1)")
    .run(email, hash, full_name).lastInsertRowid);
  return { id, password };
}

// Removes a sub-admin, never the owner. Returns them, or null.
function removeSubAdmin(db, userId) {
  const admin = db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role = 'admin' AND owner = 0").get(userId);
  if (!admin) return null;
  db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
  return admin;
}

async function ensureAdmin(db, email, password) {
  const exists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (exists) return false;
  await createAdmin(db, email, password);
  return true;
}

// city is no longer asked for; the column stays for clubs that have one.
function createClub(db, { name, city = '', country = '' }) {
  return Number(db.prepare('INSERT INTO clubs (name, city, country) VALUES (?, ?, ?)').run(name, city, country).lastInsertRowid);
}

async function createCoachAccount(db, { full_name, phone, email, password }) {
  const hash = await bcrypt.hash(password, 12);
  return Number(
    db
      .prepare("INSERT INTO users (email, password_hash, role, full_name, phone) VALUES (?, ?, 'coach', ?, ?)")
      .run(email, hash, full_name, phone).lastInsertRowid
  );
}

// Officials run the weigh-in, record results and use court screens. An admin
// creates them with a starting password, which they can change on My account.
async function createOfficialAccount(db, { full_name, email, password }) {
  const hash = await bcrypt.hash(password, 12);
  return Number(
    db
      .prepare("INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'official', ?)")
      .run(email, hash, full_name).lastInsertRowid
  );
}

// Deletes a coach's account. Their club keeps its athletes and registrations,
// which belong to the club, and the activity log keeps their name. Their
// applications and reset links go with them. Returns the coach, or null.
function deleteCoachAccount(db, userId) {
  const coach = db
    .prepare("SELECT u.id, u.full_name, u.email, c.name AS club FROM users u LEFT JOIN clubs c ON c.id = u.club_id WHERE u.id = ? AND u.role = 'coach'")
    .get(userId);
  if (!coach) return null;
  db.prepare('DELETE FROM users WHERE id = ?').run(coach.id);
  return coach;
}

// What deleting a competition would remove, for the confirm page.
function competitionFootprint(db, competitionId) {
  const count = (sql) => db.prepare(sql).get(competitionId).n;
  return {
    registrations: count('SELECT COUNT(*) AS n FROM registrations WHERE competition_id = ?'),
    poomsae: count('SELECT COUNT(*) AS n FROM poomsae_entries WHERE competition_id = ?'),
    bouts: count('SELECT COUNT(*) AS n FROM bouts WHERE competition_id = ? AND is_bye = 0'),
    results: count('SELECT COUNT(*) AS n FROM bouts WHERE competition_id = ? AND winner_registration_id IS NOT NULL'),
    files: count('SELECT COUNT(*) AS n FROM competition_files WHERE competition_id = ?'),
  };
}

// Deletes a competition and everything in it: bouts, registrations, divisions,
// dates, logo and files. Bouts point at registrations, and registrations at
// weight classes, so they go first, in that order. Athletes stay with their
// clubs, and the activity log keeps its history.
function deleteCompetition(db, competitionId) {
  db.transaction(() => {
    db.prepare('DELETE FROM bouts WHERE competition_id = ?').run(competitionId);
    db.prepare('DELETE FROM division_days WHERE competition_id = ?').run(competitionId);
    db.prepare('DELETE FROM poomsae_bouts WHERE competition_id = ?').run(competitionId);
    db.prepare('DELETE FROM registrations WHERE competition_id = ?').run(competitionId);
    db.prepare('DELETE FROM poomsae_entries WHERE competition_id = ?').run(competitionId);
    db.prepare('DELETE FROM competitions WHERE id = ?').run(competitionId);
  })();
}

// Removes an official's account. Any open session ends with it, because each
// request looks the user up afresh. Activity log entries keep their name.
function removeOfficial(db, userId) {
  const official = db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role = 'official'").get(userId);
  if (!official) return null;
  db.prepare('DELETE FROM users WHERE id = ?').run(official.id);
  return official;
}

// Returns { ok, error? }. A coach belongs to one club and has one open application.
// A coach already in a club can apply to another; they move only once approved.
function applyToClub(db, userId, clubId) {
  const user = db.prepare('SELECT club_id FROM users WHERE id = ?').get(userId);
  if (!db.prepare('SELECT 1 FROM clubs WHERE id = ?').get(clubId)) return { ok: false, error: 'Select a club.' };
  if (user.club_id === clubId) return { ok: false, error: 'You are already in that club.' };
  if (db.prepare("SELECT 1 FROM club_applications WHERE user_id = ? AND status = 'pending'").get(userId)) {
    return { ok: false, error: 'You already have an application waiting for approval.' };
  }
  db.prepare('INSERT INTO club_applications (user_id, club_id) VALUES (?, ?)').run(userId, clubId);
  return { ok: true };
}

function approveApplication(db, applicationId) {
  return db.transaction(() => {
    const application = db
      .prepare("SELECT * FROM club_applications WHERE id = ? AND status = 'pending'")
      .get(applicationId);
    if (!application) return false;
    // A coach changing clubs leaves their old one.
    db.prepare(
      "UPDATE club_applications SET status = 'removed', reviewed_at = datetime('now') WHERE user_id = ? AND status = 'approved'"
    ).run(application.user_id);
    db.prepare("UPDATE club_applications SET status = 'approved', reviewed_at = datetime('now') WHERE id = ?").run(applicationId);
    db.prepare('UPDATE users SET club_id = ? WHERE id = ?').run(application.club_id, application.user_id);
    return true;
  })();
}

function rejectApplication(db, applicationId, note) {
  return (
    db
      .prepare(
        `UPDATE club_applications SET status = 'rejected', review_note = ?, reviewed_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(note, applicationId).changes > 0
  );
}

// The club keeps its fighters and registrations when a coach is removed.
function removeCoach(db, userId) {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE users SET club_id = NULL WHERE id = ? AND role = 'coach' AND club_id IS NOT NULL").run(userId).changes;
    if (changed > 0) {
      db.prepare(
        `UPDATE club_applications SET status = 'removed', reviewed_at = datetime('now')
         WHERE user_id = ? AND status = 'approved'`
      ).run(userId);
    }
    return changed > 0;
  })();
}

// Deletes athlete documents uploaded more than `days` ago, unless the athlete is
// entered in a competition that ended less than `days` ago or hasn't happened
// yet. Coaches upload a fresh one for their next entry. Returns how many went.
function cleanUpDocuments(db, days) {
  const cutoff = `-${Number(days)} days`;
  return db.prepare(
    `DELETE FROM fighter_documents
     WHERE uploaded_at < datetime('now', @cutoff)
       AND fighter_id NOT IN (
         SELECT x.fighter_id FROM (
           SELECT fighter_id, competition_id FROM registrations WHERE status != 'rejected'
           UNION SELECT m.fighter_id, e.competition_id FROM poomsae_members m JOIN poomsae_entries e ON e.id = m.entry_id WHERE e.status != 'rejected'
         ) x
         WHERE (SELECT MAX(d.event_date) FROM competition_dates d WHERE d.competition_id = x.competition_id) >= date('now', @cutoff)
       )`
  ).run({ cutoff }).changes;
}

module.exports = {
  listCompetitionPhotos,
  getCompetitionPhoto,
  addCompetitionPhoto,
  deleteCompetitionPhoto,
  createSubAdmin,
  removeSubAdmin,
  saveFighterPhoto,
  getFighterPhoto,
  deleteFighterPhoto,
  cleanUpDocuments,
  today,
  isRegistrationOpen,
  loadDivisionSetup,
  countRegistrations,
  saveDivisionSetup,
  savePoomsaeAgeGroups,
  getEventDates,
  saveEventDates,
  createCompetition,
  enterFighter,
  saveFighterDocument,
  getFighterDocument,
  saveClubIcon,
  getClubIcon,
  deleteClubIcon,
  clubIconVersions,
  saveCompetitionLogo,
  getCompetitionLogo,
  hasCompetitionLogo,
  competitionLogoVersions,
  listCompetitionFiles,
  getCompetitionFile,
  addCompetitionFile,
  deleteCompetitionFile,
  listNews,
  getNews,
  createNews,
  updateNews,
  deleteNews,
  hasApprovedRegistration,
  hasActiveRegistration,
  hasEntryHistory,
  listPoomsaeEntries,
  getPoomsaeEntry,
  enterPoomsae,
  withdrawPoomsae,
  reviewPoomsae,
  recordPoomsaeScore,
  hasPoomsaeScores,
  hasPoomsaeResults,
  loadJudgeMarks,
  loadPoomsaeBrackets,
  loadPoomsaeSettings,
  savePoomsaeSchedule,
  savePoomsaeDivision,
  applyPoomsaeSchedule,
  generatePoomsaeOrder,
  clearPoomsaeOrder,
  poomsaeBoutList,
  poomsaeCourtItems,
  poomsaeCourtQueue,
  competitionResults,
  competitionProgramme,
  submitJudgeMark,
  drawPoomsaeBracket,
  deletePoomsaeBracket,
  recordPoomsaeBout,
  poomsaeDivisions,
  hasBoutList,
  deleteBoutList,
  generateBoutList,
  swapAthletes,
  withdrawAthlete,
  reinstateAthlete,
  redrawDivision,
  listWithdrawn,
  mergeDivision,
  unmergeRegistration,
  listWeighIns,
  weighInCounts,
  classesForRegistration,
  recordWeighIn,
  applySchedule,
  loadDivisionDays,
  saveDivisionDays,
  loadBoutList,
  listBouts,
  hasResults,
  recordResult,
  clearResult,
  applyWalkovers,
  clearAllResults,
  createPasswordReset,
  findPasswordReset,
  completePasswordReset,
  REGISTRATION_SELECT,
  DIVISION_ORDER,
  ensureAdmin,
  createClub,
  createCoachAccount,
  createOfficialAccount,
  removeOfficial,
  deleteCoachAccount,
  competitionFootprint,
  deleteCompetition,
  applyToClub,
  approveApplication,
  rejectApplication,
  removeCoach,
  localNow,
  deadlinePassed,
  closeExpiredCompetitions,
  timeLeft,
};
