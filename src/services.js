// Database operations shared by routes, the seed script and tests.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  DEFAULT_AGE_GROUPS,
  DEFAULT_BELT_GROUPS,
  GENDERS,
  assignDivision,
  parseWeightLimits,
  formatDay,
} = require('./divisions');
const { buildBracket, assignCourts, formatTime } = require('./bracket');
const { logActivity } = require('./activity');
const { documentLabel, documentTypeFor } = require('./documents');

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
  };
}

function countRegistrations(db, competitionId) {
  return db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE competition_id = ?').get(competitionId).n;
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

function createCompetition(db, { event_dates: eventDates, ...fields }) {
  return db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO competitions (name, event_date, registration_deadline, registration_deadline_time, venue, description, age_basis, status)
         VALUES (@name, @event_date, @registration_deadline, @registration_deadline_time, @venue, @description, @age_basis, @status)`
      )
      .run({ description: '', age_basis: 'year', status: 'draft', registration_deadline_time: '23:59', ...fields }).lastInsertRowid;
    saveEventDates(db, id, eventDates || [fields.event_date]);
    saveDivisionSetup(db, id, { ageGroups: DEFAULT_AGE_GROUPS, beltGroups: DEFAULT_BELT_GROUPS });
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

  if (!db.prepare('SELECT 1 FROM fighter_documents WHERE fighter_id = ?').get(fighter.id)) {
    return { ok: false, error: `Upload their ${documentLabel(documentTypeFor(fighter.belt_rank))} first.` };
  }

  const existing = db
    .prepare('SELECT id, status FROM registrations WHERE competition_id = ? AND fighter_id = ?')
    .get(competition.id, fighter.id);
  if (existing && existing.status !== 'rejected') {
    return { ok: false, error: 'Already registered for this competition.' };
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

function getFighterDocument(db, fighterId) {
  return db.prepare('SELECT * FROM fighter_documents WHERE fighter_id = ?').get(fighterId) || null;
}

// An approved registration was checked against this document, so it stays as is.
function hasApprovedRegistration(db, fighterId) {
  return Boolean(db.prepare("SELECT 1 FROM registrations WHERE fighter_id = ? AND status = 'approved' LIMIT 1").get(fighterId));
}

function hasActiveRegistration(db, fighterId) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM registrations WHERE fighter_id = ? AND status IN ('pending', 'approved') LIMIT 1")
      .get(fighterId)
  );
}

const REGISTRATION_SELECT = `
  SELECT r.*, f.first_name, f.last_name, f.gender, f.date_of_birth, f.belt_rank,
         c.name AS club_name, a.name AS age_group, a.min_age,
         b.name AS belt_group, b.min_rank, w.label AS weight_class, w.max_kg,
         (SELECT d.doc_type FROM fighter_documents d WHERE d.fighter_id = r.fighter_id) AS document_type
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

// Sets each division's day and court, then numbers and times its bouts. Numbering
// restarts for each court on each day. Doesn't change who fights whom.
function applySchedule(db, competitionId) {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(competitionId);
  const rows = db
    .prepare(
      `SELECT bt.id, bt.gender, bt.age_group_id, bt.belt_group_id, bt.weight_class_id, bt.is_bye
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
    const key = [row.gender, row.age_group_id, row.belt_group_id, row.weight_class_id].join('-');
    divisions.set(key, [...(divisions.get(key) || []), row]);
  });

  const list = [...divisions.values()];
  const places = assignCourts(
    list.map((bouts) => bouts.filter((b) => !b.is_bye).length),
    { courts: competition.bout_courts, days: getEventDates(db, competitionId).length }
  );
  const [startHours, startMinutes] = competition.bout_start.split(':').map(Number);
  const start = startHours * 60 + startMinutes;
  const used = new Map();
  const update = db.prepare('UPDATE bouts SET day = ?, court = ?, bout_number = ?, start_time = ? WHERE id = ?');

  db.transaction(() => {
    list.forEach((bouts, i) => {
      const { day, court } = places[i];
      bouts.forEach((bout) => {
        if (bout.is_bye) {
          update.run(day, court, null, null, bout.id);
          return;
        }
        const key = `${day}:${court}`;
        const number = (used.get(key) || 0) + 1;
        used.set(key, number);
        update.run(day, court, number, formatTime(start + (number - 1) * competition.bout_minutes), bout.id);
      });
    });
  })();
}

// Draws every division from the approved registrations, replacing any earlier
// draw. Returns the number of fighters drawn.
function generateBoutList(db, competitionId, rng = secureRandom) {
  const approved = db
    .prepare(`${REGISTRATION_SELECT} WHERE r.competition_id = ? AND r.status = 'approved' ORDER BY ${DIVISION_ORDER}`)
    .all(competitionId);

  const divisions = new Map();
  approved.forEach((r) => {
    const key = [r.gender, r.age_group_id, r.belt_group_id, r.weight_class_id].join('-');
    divisions.set(key, [...(divisions.get(key) || []), r]);
  });

  const insert = db.prepare(
    `INSERT INTO bouts (competition_id, gender, age_group_id, belt_group_id, weight_class_id, round, total_rounds,
       position, blue_registration_id, red_registration_id, is_bye, blue_seed, red_seed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    deleteBoutList(db, competitionId);
    divisions.forEach((registrations) => {
      const [first] = registrations;
      const entries = registrations.map((r) => ({ registrationId: r.id, clubId: r.club_id }));
      const rounds = buildBracket(entries, rng);
      rounds.forEach((bouts, roundIndex) => {
        bouts.forEach((bout, position) => {
          insert.run(
            competitionId,
            first.gender,
            first.age_group_id,
            first.belt_group_id,
            first.weight_class_id,
            roundIndex + 1,
            rounds.length,
            position,
            bout.blue ? bout.blue.registrationId : null,
            bout.red ? bout.red.registrationId : null,
            bout.isBye ? 1 : 0,
            bout.blue ? bout.blue.seed : null,
            bout.red ? bout.red.seed : null
          );
        });
      });
    });
    applySchedule(db, competitionId);
  })();
  return approved.length;
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

// Shapes the stored draw for the web page and the PDF, one entry per division.
function loadBoutList(db, competitionId) {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(competitionId);
  const eventDates = getEventDates(db, competitionId);
  const rows = db
    .prepare(
      `SELECT bt.*, a.name AS age_group, a.min_age, a.max_age, bg.name AS belt_group, w.label AS weight_class,
         fb.first_name AS blue_first, fb.last_name AS blue_last, cb.name AS blue_club, cb.id AS blue_club_id,
         fr.first_name AS red_first, fr.last_name AS red_last, cr.name AS red_club, cr.id AS red_club_id
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
    const key = [row.gender, row.age_group_id, row.belt_group_id, row.weight_class_id].join('-');
    if (!divisions.has(key)) {
      divisions.set(key, {
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
function recordResult(db, competitionId, boutId, side) {
  return db.transaction(() => {
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ? AND competition_id = ?').get(boutId, competitionId);
    if (!bout || bout.is_bye) return { ok: false, error: 'That bout was not found.' };
    if (!bout.blue_registration_id || !bout.red_registration_id) {
      return { ok: false, error: 'Both fighters must be known before recording this bout.' };
    }
    const winnerId = side === 'blue' ? bout.blue_registration_id : side === 'red' ? bout.red_registration_id : null;
    if (!winnerId) return { ok: false, error: 'Choose a winner.' };

    const { next, column } = nextBoutOf(db, bout);
    if (next && next.winner_registration_id) {
      return { ok: false, error: `Clear the result of Bout ${next.bout_number} first, because it depends on this one.` };
    }
    db.prepare('UPDATE bouts SET winner_registration_id = ? WHERE id = ?').run(winnerId, bout.id);
    if (next) db.prepare(`UPDATE bouts SET ${column} = ? WHERE id = ?`).run(winnerId, next.id);
    return { ok: true };
  })();
}

function clearResult(db, competitionId, boutId) {
  return db.transaction(() => {
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ? AND competition_id = ?').get(boutId, competitionId);
    if (!bout || !bout.winner_registration_id) return { ok: false, error: 'That bout has no result.' };
    const { next, column } = nextBoutOf(db, bout);
    if (next && next.winner_registration_id) {
      return { ok: false, error: `Clear the result of Bout ${next.bout_number} first, because it depends on this one.` };
    }
    db.prepare('UPDATE bouts SET winner_registration_id = NULL WHERE id = ?').run(bout.id);
    if (next) db.prepare(`UPDATE bouts SET ${column} = NULL WHERE id = ?`).run(next.id);
    return { ok: true };
  })();
}

// Clears from the last round back, so every fighter returns to where they started.
function clearAllResults(db, competitionId) {
  db.transaction(() => {
    db.prepare('SELECT id FROM bouts WHERE competition_id = ? AND winner_registration_id IS NOT NULL ORDER BY round DESC')
      .all(competitionId)
      .forEach((bout) => clearResult(db, competitionId, bout.id));
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
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, reset.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.user_id);
    db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(reset.user_id);
  })();
  return true;
}

async function createAdmin(db, email, password) {
  const hash = await bcrypt.hash(password, 12);
  db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')").run(email, hash);
}

async function ensureAdmin(db, email, password) {
  const exists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (exists) return false;
  await createAdmin(db, email, password);
  return true;
}

function createClub(db, { name, city }) {
  return Number(db.prepare('INSERT INTO clubs (name, city) VALUES (?, ?)').run(name, city).lastInsertRowid);
}

async function createCoachAccount(db, { full_name, phone, email, password }) {
  const hash = await bcrypt.hash(password, 12);
  return Number(
    db
      .prepare("INSERT INTO users (email, password_hash, role, full_name, phone) VALUES (?, ?, 'coach', ?, ?)")
      .run(email, hash, full_name, phone).lastInsertRowid
  );
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

module.exports = {
  today,
  isRegistrationOpen,
  loadDivisionSetup,
  countRegistrations,
  saveDivisionSetup,
  getEventDates,
  saveEventDates,
  createCompetition,
  enterFighter,
  saveFighterDocument,
  getFighterDocument,
  hasApprovedRegistration,
  hasActiveRegistration,
  hasBoutList,
  deleteBoutList,
  generateBoutList,
  applySchedule,
  loadBoutList,
  hasResults,
  recordResult,
  clearResult,
  clearAllResults,
  createPasswordReset,
  findPasswordReset,
  completePasswordReset,
  REGISTRATION_SELECT,
  DIVISION_ORDER,
  ensureAdmin,
  createClub,
  createCoachAccount,
  applyToClub,
  approveApplication,
  rejectApplication,
  removeCoach,
  localNow,
  deadlinePassed,
  closeExpiredCompetitions,
  timeLeft,
};
