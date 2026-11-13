const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULT_BELT_GROUPS } = require('./divisions');
const { DEFAULT_POOMSAE_AGE_GROUPS } = require('./poomsae');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  city TEXT NOT NULL,
  -- Three-letter code from src/countries.js (SGP, MAS…), shown with its athletes. Blank: none.
  country TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'coach', 'official')),
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- My settings: 'auto', 'dark' or 'light', and which emails they want (JSON of opt-outs).
  theme TEXT NOT NULL DEFAULT 'auto',
  email_opt_out TEXT NOT NULL DEFAULT '[]',
  -- Two-step login: the authenticator secret, and hashes of one-time recovery codes.
  totp_secret TEXT,
  totp_recovery TEXT NOT NULL DEFAULT '[]',
  -- The one main admin: only they add or remove other admins, and no one else can remove them.
  owner INTEGER NOT NULL DEFAULT 0,
  -- Set for a new sub-admin, whose emailed one-time password must be replaced at first login.
  must_change_password INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS club_applications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_application ON club_applications(user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS fighters (
  id INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('M', 'F')),
  date_of_birth TEXT NOT NULL,
  belt_rank INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fighters_club ON fighters(club_id);

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  registration_deadline TEXT NOT NULL,
  registration_deadline_time TEXT NOT NULL DEFAULT '23:59',
  venue TEXT NOT NULL,
  -- Where Google Maps finds the venue (address, place name or "lat,lng"). Blank: no map.
  map_query TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  age_basis TEXT NOT NULL DEFAULT 'year' CHECK (age_basis IN ('year', 'date')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  bout_courts INTEGER NOT NULL DEFAULT 2,
  bout_start TEXT NOT NULL DEFAULT '09:00',
  bout_minutes INTEGER NOT NULL DEFAULT 10,
  bout_rest_minutes INTEGER NOT NULL DEFAULT 0,
  -- Most entries one club may have in a single division. NULL: no limit.
  max_per_club_division INTEGER,
  -- Which events clubs can enter. Fixed once entries exist.
  events TEXT NOT NULL DEFAULT 'kyorugi' CHECK (events IN ('kyorugi', 'poomsae', 'both')),
  -- How poomsae divisions are decided, and how many go from a score round into the bracket.
  poomsae_format TEXT NOT NULL DEFAULT 'score' CHECK (poomsae_format IN ('score', 'elimination', 'cut')),
  poomsae_cut INTEGER NOT NULL DEFAULT 16,
  -- Poomsae brackets run on their own courts, numbered "Poomsae court 1" and up.
  poomsae_courts INTEGER NOT NULL DEFAULT 1,
  poomsae_start TEXT NOT NULL DEFAULT '09:00',
  poomsae_minutes INTEGER NOT NULL DEFAULT 5,
  poomsae_rest_minutes INTEGER NOT NULL DEFAULT 0,
  -- Judges scoring each poomsae performance. One: the official enters the final score.
  poomsae_judges INTEGER NOT NULL DEFAULT 1,
  -- When the poomsae performance lists, and separately the brackets, were published.
  poomsae_published_at TEXT,
  poomsae_brackets_published_at TEXT,
  bouts_published_at TEXT,
  reminder_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each athlete's belt proof. Kept in the database so one backup covers everything.
-- Select the data column only when serving a file.
CREATE TABLE IF NOT EXISTS fighter_documents (
  fighter_id INTEGER PRIMARY KEY REFERENCES fighters(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plain ids, not foreign keys, so entries outlive whatever they describe.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  competition_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activity_competition ON activity_log(competition_id);

-- Only a hash of each token is stored, so a database leak can't reset passwords.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every day of a competition. competitions.event_date stays as the first day,
-- which ages are calculated from.
CREATE TABLE IF NOT EXISTS competition_dates (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  event_date TEXT NOT NULL,
  PRIMARY KEY (competition_id, event_date)
);

CREATE TABLE IF NOT EXISTS age_groups (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  min_age INTEGER NOT NULL,
  max_age INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS belt_groups (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  min_rank INTEGER NOT NULL,
  max_rank INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS weight_classes (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  age_group_id INTEGER NOT NULL REFERENCES age_groups(id) ON DELETE CASCADE,
  gender TEXT NOT NULL CHECK (gender IN ('M', 'F')),
  label TEXT NOT NULL,
  max_kg REAL
);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  fighter_id INTEGER NOT NULL REFERENCES fighters(id) ON DELETE RESTRICT,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  age_at_event INTEGER NOT NULL,
  age_group_id INTEGER NOT NULL REFERENCES age_groups(id),
  belt_group_id INTEGER NOT NULL REFERENCES belt_groups(id),
  weight_class_id INTEGER NOT NULL REFERENCES weight_classes(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Weigh-in result. Only the outcome is kept, never the weight itself.
  weigh_status TEXT CHECK (weigh_status IN ('passed', 'no_show', 'disqualified')),
  weighed_at TEXT,
  -- The class the coach entered, kept when the athlete is moved at weigh-in.
  entered_weight_class_id INTEGER REFERENCES weight_classes(id),
  -- The division (gender-age-belt-weight ids) an admin moved this entry out of,
  -- to give a lone athlete an opponent. Undo restores it.
  merged_from TEXT,
  -- Taken out of a drawn bout list by an admin, for example after an injury.
  withdrawn_at TEXT,
  withdrawal_note TEXT NOT NULL DEFAULT '',
  UNIQUE (competition_id, fighter_id)
);
CREATE INDEX IF NOT EXISTS idx_registrations_club ON registrations(club_id);

CREATE TABLE IF NOT EXISTS bouts (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  gender TEXT NOT NULL,
  age_group_id INTEGER NOT NULL REFERENCES age_groups(id),
  belt_group_id INTEGER NOT NULL REFERENCES belt_groups(id),
  weight_class_id INTEGER NOT NULL REFERENCES weight_classes(id),
  round INTEGER NOT NULL,
  total_rounds INTEGER NOT NULL,
  position INTEGER NOT NULL,
  bout_number INTEGER,
  blue_registration_id INTEGER REFERENCES registrations(id),
  red_registration_id INTEGER REFERENCES registrations(id),
  is_bye INTEGER NOT NULL DEFAULT 0,
  blue_seed INTEGER,
  red_seed INTEGER,
  day INTEGER,
  court INTEGER,
  start_time TEXT,
  winner_registration_id INTEGER REFERENCES registrations(id),
  -- Won without a fight, because the other athlete failed or missed the weigh-in.
  walkover INTEGER NOT NULL DEFAULT 0,
  -- How the bout was won (a WIN_TYPES code) and its score, such as "2-1". Optional.
  win_type TEXT,
  score TEXT,
  -- Neither athlete could fight (both out at the weigh-in): decided with no winner.
  no_contest INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bouts_competition ON bouts(competition_id);

-- Admin news posts. "public" posts show to everyone, "members" posts only to
-- logged-in coaches and admins. Bodies are plain text, shown escaped.
CREATE TABLE IF NOT EXISTS news_posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'public' CHECK (audience IN ('public', 'members')),
  pinned INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_created ON news_posts(created_at);

-- Each competition's logo, required before it opens for registration.
CREATE TABLE IF NOT EXISTS competition_logos (
  competition_id INTEGER PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Files the admin attaches to a competition (prospectus, rules, forms). Anyone who
-- can see the competition can download them. Never SELECT data in lists.
CREATE TABLE IF NOT EXISTS competition_files (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_competition_files ON competition_files(competition_id);

-- Each club's icon, set by its coaches. Select the data column only when serving it.
-- An athlete's photo, for the club's list, the officials' athlete page and the
-- printed athlete card. Never shown on public pages: many athletes are minors.
CREATE TABLE IF NOT EXISTS fighter_photos (
  fighter_id INTEGER PRIMARY KEY REFERENCES fighters(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS club_icons (
  club_id INTEGER PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Divisions the admin pinned to an event day. The rest are placed automatically.
-- Kept apart from bouts so a redraw keeps the choice. Day is a position in the
-- sorted competition_dates list, like bouts.day.
CREATE TABLE IF NOT EXISTS division_days (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  gender TEXT NOT NULL,
  age_group_id INTEGER NOT NULL REFERENCES age_groups(id) ON DELETE CASCADE,
  belt_group_id INTEGER NOT NULL REFERENCES belt_groups(id) ON DELETE CASCADE,
  weight_class_id INTEGER NOT NULL REFERENCES weight_classes(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  PRIMARY KEY (competition_id, gender, age_group_id, belt_group_id, weight_class_id)
);

-- Poomsae has its own age groups (Under 30, Under 40...), apart from kyorugi's.
CREATE TABLE IF NOT EXISTS poomsae_age_groups (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  min_age INTEGER NOT NULL,
  max_age INTEGER NOT NULL
);

-- Poomsae entries: one athlete (individual), two (pair) or three (team) from
-- one club. Divisions are event + gender (X: mixed) + age group + belt group,
-- stored at entry time like registrations. score is the final judged score.
CREATE TABLE IF NOT EXISTS poomsae_entries (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('individual', 'pair', 'team')),
  gender TEXT NOT NULL CHECK (gender IN ('M', 'F', 'X')),
  age_group_id INTEGER NOT NULL REFERENCES poomsae_age_groups(id),
  belt_group_id INTEGER NOT NULL REFERENCES belt_groups(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  score REAL,
  scored_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Place in its division's random performance order, and when it performs.
  perform_order INTEGER,
  perform_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_poomsae_entries_competition ON poomsae_entries(competition_id);

-- Each judge's mark for a poomsae entry. The entry's score is worked out from them.
CREATE TABLE IF NOT EXISTS poomsae_judge_scores (
  entry_id INTEGER NOT NULL REFERENCES poomsae_entries(id) ON DELETE CASCADE,
  judge INTEGER NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (entry_id, judge)
);

CREATE TABLE IF NOT EXISTS poomsae_members (
  entry_id INTEGER NOT NULL REFERENCES poomsae_entries(id) ON DELETE CASCADE,
  fighter_id INTEGER NOT NULL REFERENCES fighters(id) ON DELETE RESTRICT,
  age_at_event INTEGER NOT NULL,
  PRIMARY KEY (entry_id, fighter_id)
);
CREATE INDEX IF NOT EXISTS idx_poomsae_members_fighter ON poomsae_members(fighter_id);

-- Single-elimination poomsae brackets, one per division (division_key is
-- event-gender-age-belt ids). Winners fill the next bout's slot, as in kyorugi.
CREATE TABLE IF NOT EXISTS poomsae_bouts (
  id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_key TEXT NOT NULL,
  round INTEGER NOT NULL,
  total_rounds INTEGER NOT NULL,
  position INTEGER NOT NULL,
  bout_number INTEGER,
  blue_entry_id INTEGER REFERENCES poomsae_entries(id),
  red_entry_id INTEGER REFERENCES poomsae_entries(id),
  is_bye INTEGER NOT NULL DEFAULT 0,
  blue_seed INTEGER,
  red_seed INTEGER,
  winner_entry_id INTEGER REFERENCES poomsae_entries(id),
  day INTEGER,
  court INTEGER,
  start_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_poomsae_bouts_division ON poomsae_bouts(competition_id, division_key);

-- A poomsae division's own choices. NULL keeps the competition's format and cut,
-- and an automatic day.
CREATE TABLE IF NOT EXISTS poomsae_divisions (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_key TEXT NOT NULL,
  format TEXT CHECK (format IN ('score', 'elimination', 'cut')),
  cut INTEGER,
  day INTEGER,
  -- Scheduling: the order lists and brackets were made in, and where the list runs.
  list_seq INTEGER,
  bracket_seq INTEGER,
  list_day INTEGER,
  list_court INTEGER,
  PRIMARY KEY (competition_id, division_key)
);

-- The Settings page. Keys are listed with their defaults in src/settings.js.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The organiser's logo for the top bar, set on the Settings page.
CREATE TABLE IF NOT EXISTS site_logo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

// Version 1: nine belts become Blue, Red and Black. White to Blue become Blue,
// Purple to Red become Red. Registrations move to the matching new belt group.
function migrateBelts(db) {
  db.transaction(() => {
    db.exec('UPDATE fighters SET belt_rank = CASE WHEN belt_rank <= 5 THEN 1 WHEN belt_rank <= 8 THEN 2 ELSE 3 END');

    const insertGroup = db.prepare('INSERT INTO belt_groups (competition_id, name, min_rank, max_rank) VALUES (?, ?, ?, ?)');
    const moveRegistrations = db.prepare(
      `UPDATE registrations SET belt_group_id = ?
       WHERE competition_id = ? AND fighter_id IN (SELECT id FROM fighters WHERE belt_rank = ?)`
    );
    db.prepare('SELECT id FROM competitions').all().forEach(({ id }) => {
      const oldIds = db.prepare('SELECT id FROM belt_groups WHERE competition_id = ?').all(id).map((g) => g.id);
      DEFAULT_BELT_GROUPS.forEach((group) => {
        const newId = insertGroup.run(id, group.name, group.min_rank, group.max_rank).lastInsertRowid;
        moveRegistrations.run(newId, id, group.min_rank);
      });
      oldIds.forEach((oldId) => db.prepare('DELETE FROM belt_groups WHERE id = ?').run(oldId));
    });
    db.pragma('user_version = 1');
  })();
}

function addColumnIfMissing(db, table, column, definition) {
  const exists = db.pragma(`table_info(${table})`).some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Version 2: bracket-style bout lists need seeds and a schedule. Draws made before
// this have neither, so they are cleared and must be generated again.
function migrateSchedule(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'bout_courts', 'INTEGER NOT NULL DEFAULT 2');
    addColumnIfMissing(db, 'competitions', 'bout_days', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'competitions', 'bout_start', "TEXT NOT NULL DEFAULT '09:00'");
    addColumnIfMissing(db, 'competitions', 'bout_minutes', 'INTEGER NOT NULL DEFAULT 10');
    ['blue_seed INTEGER', 'red_seed INTEGER', 'day INTEGER', 'court INTEGER', 'start_time TEXT'].forEach((column) => {
      const [name, type] = column.split(' ');
      addColumnIfMissing(db, 'bouts', name, type);
    });
    db.exec('DELETE FROM bouts');
    db.pragma('user_version = 2');
  })();
}

// Version 3: club accounts become coach accounts, each approved for their club.
// Clubs keep their fighters. Contact details move from the club to the coach.
function migrateCoaches(db) {
  db.transaction(() => {
    const userColumns = db.pragma('table_info(users)').map((c) => c.name);
    const clubColumns = db.pragma('table_info(clubs)').map((c) => c.name);

    if (!userColumns.includes('full_name')) {
      const hasContact = clubColumns.includes('coach_name');
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'coach')),
          full_name TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users_new (id, email, password_hash, role, full_name, phone, club_id, created_at)
          SELECT u.id, u.email, u.password_hash, CASE u.role WHEN 'club' THEN 'coach' ELSE u.role END,
                 ${hasContact ? "COALESCE(c.coach_name, '')" : "''"}, ${hasContact ? "COALESCE(c.phone, '')" : "''"},
                 u.club_id, u.created_at
          FROM users u LEFT JOIN clubs c ON c.id = u.club_id;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        INSERT INTO club_applications (user_id, club_id, status, reviewed_at)
          SELECT id, club_id, 'approved', datetime('now') FROM users WHERE club_id IS NOT NULL;
      `);
    }
    if (clubColumns.includes('coach_name')) db.exec('ALTER TABLE clubs DROP COLUMN coach_name');
    if (clubColumns.includes('phone')) db.exec('ALTER TABLE clubs DROP COLUMN phone');
    addColumnIfMissing(db, 'competitions', 'registration_deadline_time', "TEXT NOT NULL DEFAULT '23:59'");
    db.pragma('user_version = 3');
  })();
}

// Version 4: competitions list their actual dates, replacing a count of days.
// A count of N becomes N consecutive dates from the event date.
function migrateEventDates(db) {
  db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO competition_dates (competition_id, event_date) VALUES (?, ?)');
    db.prepare('SELECT * FROM competitions').all().forEach((competition) => {
      const start = new Date(`${competition.event_date}T00:00:00Z`);
      for (let i = 0; i < (competition.bout_days || 1); i += 1) {
        const day = new Date(start.getTime() + i * 86400000);
        insert.run(competition.id, day.toISOString().slice(0, 10));
      }
    });
    if (db.pragma('table_info(competitions)').some((c) => c.name === 'bout_days')) {
      db.exec('ALTER TABLE competitions DROP COLUMN bout_days');
    }
    db.pragma('user_version = 4');
  })();
}

// Version 5: coaches pick a weight class instead of declaring a weight, bouts
// record winners, and bout lists can be published to coaches.
function migrateResults(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'bouts_published_at', 'TEXT');
    addColumnIfMissing(db, 'competitions', 'reminder_sent_at', 'TEXT');
    addColumnIfMissing(db, 'bouts', 'winner_registration_id', 'INTEGER REFERENCES registrations(id)');
    if (db.pragma('table_info(registrations)').some((c) => c.name === 'declared_weight_kg')) {
      db.exec('ALTER TABLE registrations DROP COLUMN declared_weight_kg');
    }
    db.pragma('user_version = 5');
  })();
}

// Version 6: a minimum rest between a fighter's bouts. Existing competitions get
// none, so their schedules stay as they are until the admin sets one.
function migrateRest(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'bout_rest_minutes', 'INTEGER NOT NULL DEFAULT 0');
    db.pragma('user_version = 6');
  })();
}

// Version 7: weigh-in results on registrations. Nobody has been weighed yet, so
// existing registrations start empty and still go into the draw.
function migrateWeighIn(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'registrations', 'weigh_status', "TEXT CHECK (weigh_status IN ('passed', 'no_show', 'disqualified'))");
    addColumnIfMissing(db, 'registrations', 'weighed_at', 'TEXT');
    addColumnIfMissing(db, 'registrations', 'entered_weight_class_id', 'INTEGER REFERENCES weight_classes(id)');
    db.pragma('user_version = 7');
  })();
}

// Version 8: an "official" role. SQLite can't change a CHECK constraint, so the
// users table is rebuilt the way SQLite documents: with foreign keys off, so the
// tables pointing at users (applications, resets, news) keep their rows.
function migrateOfficialRole(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!sql.includes("'official'")) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE users_new (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL COLLATE NOCASE UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'coach', 'official')),
            full_name TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO users_new (id, email, password_hash, role, full_name, phone, club_id, created_at)
            SELECT id, email, password_hash, role, full_name, phone, club_id, created_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
        const broken = db.pragma('foreign_key_check');
        if (broken.length > 0) throw new Error(`Rebuilding users broke ${broken.length} foreign key(s).`);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  db.pragma('user_version = 8');
}

// Version 9: athletes can be withdrawn from a drawn bout list. Nobody is yet.
function migrateWithdrawals(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'registrations', 'withdrawn_at', 'TEXT');
    addColumnIfMissing(db, 'registrations', 'withdrawal_note', "TEXT NOT NULL DEFAULT ''");
    db.pragma('user_version = 9');
  })();
}

// Version 10: entries can be moved into another division to give a lone athlete
// an opponent. None have been yet.
function migrateMerges(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'registrations', 'merged_from', 'TEXT');
    db.pragma('user_version = 10');
  })();
}

// Version 11: an optional cap on entries per club in each division. Existing
// competitions get none, so nothing they already accept changes.
function migrateClubLimit(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'max_per_club_division', 'INTEGER');
    db.pragma('user_version = 11');
  })();
}

// Version 12: competitions can hold poomsae. Existing ones are kyorugi only, as
// before. The poomsae tables are new, so the schema above creates them.
function migrateEvents(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'events', "TEXT NOT NULL DEFAULT 'kyorugi' CHECK (events IN ('kyorugi', 'poomsae', 'both'))");
    db.pragma('user_version = 12');
  })();
}

// Version 13: poomsae gets its own age groups. Each competition gets the
// default brackets, and entries made under version 12 (which used the kyorugi
// age groups) move to the bracket of their oldest athlete, or the nearest one.
// The entries table is rebuilt to point at the new groups, with foreign keys off
// so poomsae_members keeps its rows, as in version 8.
function migratePoomsaeAges(db) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO poomsae_age_groups (competition_id, name, min_age, max_age) VALUES (?, ?, ?, ?)');
      db.prepare('SELECT id FROM competitions WHERE id NOT IN (SELECT competition_id FROM poomsae_age_groups)').all().forEach(({ id }) => {
        DEFAULT_POOMSAE_AGE_GROUPS.forEach((g) => insert.run(id, g.name, g.min_age, g.max_age));
      });
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'poomsae_entries'").get();
      if (!sql.includes('poomsae_age_groups')) {
        db.exec(`
          CREATE TABLE poomsae_entries_new (
            id INTEGER PRIMARY KEY,
            competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
            club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
            event TEXT NOT NULL CHECK (event IN ('individual', 'pair', 'team')),
            gender TEXT NOT NULL CHECK (gender IN ('M', 'F', 'X')),
            age_group_id INTEGER NOT NULL REFERENCES poomsae_age_groups(id),
            belt_group_id INTEGER NOT NULL REFERENCES belt_groups(id),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
            review_note TEXT NOT NULL DEFAULT '',
            reviewed_at TEXT,
            score REAL,
            scored_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO poomsae_entries_new SELECT id, competition_id, club_id, event, gender, age_group_id, belt_group_id,
            status, review_note, reviewed_at, score, scored_at, created_at FROM poomsae_entries;
          DROP TABLE poomsae_entries;
          ALTER TABLE poomsae_entries_new RENAME TO poomsae_entries;
          CREATE INDEX IF NOT EXISTS idx_poomsae_entries_competition ON poomsae_entries(competition_id);
        `);
        const groups = db.prepare('SELECT * FROM poomsae_age_groups WHERE competition_id = ?');
        const move = db.prepare('UPDATE poomsae_entries SET age_group_id = ? WHERE id = ?');
        db.prepare(
          'SELECT e.id, e.competition_id, MAX(m.age_at_event) AS age FROM poomsae_entries e JOIN poomsae_members m ON m.entry_id = e.id GROUP BY e.id'
        ).all().forEach((entry) => {
          const gap = (g) => (entry.age < g.min_age ? g.min_age - entry.age : entry.age > g.max_age ? entry.age - g.max_age : 0);
          const [best] = groups.all(entry.competition_id).sort((a, b) => gap(a) - gap(b));
          move.run(best.id, entry.id);
        });
      }
      const broken = db.pragma('foreign_key_check');
      if (broken.length > 0) throw new Error(`Moving poomsae entries broke ${broken.length} foreign key(s).`);
      db.pragma('user_version = 13');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// Version 14: poomsae can be single elimination, or a score round then a
// bracket. Existing competitions keep ranking by score.
function migratePoomsaeFormat(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'poomsae_format', "TEXT NOT NULL DEFAULT 'score' CHECK (poomsae_format IN ('score', 'elimination', 'cut'))");
    addColumnIfMissing(db, 'competitions', 'poomsae_cut', 'INTEGER NOT NULL DEFAULT 16');
    db.pragma('user_version = 14');
  })();
}

// Version 15: poomsae brackets get a day, court and time, and each division can
// choose its own format, cut and day. Brackets drawn before have no times yet;
// the admin's next draw or schedule save gives them one.
function migratePoomsaeSchedule(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'poomsae_courts', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'competitions', 'poomsae_start', "TEXT NOT NULL DEFAULT '09:00'");
    addColumnIfMissing(db, 'competitions', 'poomsae_minutes', 'INTEGER NOT NULL DEFAULT 5');
    addColumnIfMissing(db, 'competitions', 'poomsae_rest_minutes', 'INTEGER NOT NULL DEFAULT 0');
    ['day INTEGER', 'court INTEGER', 'start_time TEXT'].forEach((column) => {
      const [name, type] = column.split(' ');
      addColumnIfMissing(db, 'poomsae_bouts', name, type);
    });
    db.pragma('user_version = 15');
  })();
}

// Version 16: random performance orders for ranked poomsae and score rounds,
// timed on the poomsae courts with the brackets, and published to coaches.
function migratePoomsaeOrder(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'poomsae_published_at', 'TEXT');
    addColumnIfMissing(db, 'poomsae_entries', 'perform_order', 'INTEGER');
    addColumnIfMissing(db, 'poomsae_entries', 'perform_time', 'TEXT');
    ['list_seq', 'bracket_seq', 'list_day', 'list_court'].forEach((column) => addColumnIfMissing(db, 'poomsae_divisions', column, 'INTEGER'));
    db.pragma('user_version = 16');
  })();
}

// Version 17: poomsae brackets are published apart from the performance lists,
// since brackets come later. Lists already published keep their brackets shown.
function migratePoomsaeStages(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'poomsae_brackets_published_at', 'TEXT');
    db.exec('UPDATE competitions SET poomsae_brackets_published_at = poomsae_published_at WHERE poomsae_brackets_published_at IS NULL');
    db.pragma('user_version = 17');
  })();
}

// Version 18: the weigh-in can run after the draw, and an athlete who fails it
// gives their opponent a walkover. No bout has been won that way yet.
function migrateWalkovers(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'bouts', 'walkover', 'INTEGER NOT NULL DEFAULT 0');
    db.pragma('user_version = 18');
  })();
}

// Version 19: poomsae can be scored by several judges. Existing competitions keep
// one final score per performance; the judges' marks table is new.
function migrateJudges(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'poomsae_judges', 'INTEGER NOT NULL DEFAULT 1');
    db.pragma('user_version = 19');
  })();
}

// Version 20: competitions can show their venue on a map. None has one yet.
function migrateMapLocation(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'competitions', 'map_query', "TEXT NOT NULL DEFAULT ''");
    db.pragma('user_version = 20');
  })();
}

// Version 21: kyorugi results can record how a bout was won and its score, and
// a bout with both athletes out at the weigh-in becomes a no contest. None yet.
function migrateWinsAndJudgeLinks(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'bouts', 'win_type', 'TEXT');
    addColumnIfMissing(db, 'bouts', 'score', 'TEXT');
    addColumnIfMissing(db, 'bouts', 'no_contest', 'INTEGER NOT NULL DEFAULT 0');
    db.pragma('user_version = 21');
  })();
}

// Version 22: poomsae judges score through official accounts, so the private
// judges' links from version 21 go. The links table only ever held those links.
function migrateDropJudgeLinks(db) {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS poomsae_judge_links');
    db.pragma('user_version = 22');
  })();
}

// Version 23: site settings and each user's own settings (theme, emails,
// two-step login). Nothing is set yet, so everything keeps working as before.
function migrateSettings(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'users', 'theme', "TEXT NOT NULL DEFAULT 'auto'");
    addColumnIfMissing(db, 'users', 'email_opt_out', "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(db, 'users', 'totp_secret', 'TEXT');
    addColumnIfMissing(db, 'users', 'totp_recovery', "TEXT NOT NULL DEFAULT '[]'");
    db.pragma('user_version = 23');
  })();
}

// Version 24: each club's country. Existing clubs have none until an admin sets it.
function migrateClubCountry(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'clubs', 'country', "TEXT NOT NULL DEFAULT ''");
    db.pragma('user_version = 24');
  })();
}

// Version 25: the first admin becomes the owner; any other admins become sub-admins.
function migrateOwner(db) {
  db.transaction(() => {
    addColumnIfMissing(db, 'users', 'owner', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
    db.prepare("UPDATE users SET owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin') AND NOT EXISTS (SELECT 1 FROM users WHERE owner = 1)").run();
    db.pragma('user_version = 25');
  })();
}

function migrate(db) {
  if (db.pragma('user_version', { simple: true }) < 1) migrateBelts(db);
  if (db.pragma('user_version', { simple: true }) < 2) migrateSchedule(db);
  if (db.pragma('user_version', { simple: true }) < 3) migrateCoaches(db);
  if (db.pragma('user_version', { simple: true }) < 4) migrateEventDates(db);
  if (db.pragma('user_version', { simple: true }) < 5) migrateResults(db);
  if (db.pragma('user_version', { simple: true }) < 6) migrateRest(db);
  if (db.pragma('user_version', { simple: true }) < 7) migrateWeighIn(db);
  if (db.pragma('user_version', { simple: true }) < 8) migrateOfficialRole(db);
  if (db.pragma('user_version', { simple: true }) < 9) migrateWithdrawals(db);
  if (db.pragma('user_version', { simple: true }) < 10) migrateMerges(db);
  if (db.pragma('user_version', { simple: true }) < 11) migrateClubLimit(db);
  if (db.pragma('user_version', { simple: true }) < 12) migrateEvents(db);
  if (db.pragma('user_version', { simple: true }) < 13) migratePoomsaeAges(db);
  if (db.pragma('user_version', { simple: true }) < 14) migratePoomsaeFormat(db);
  if (db.pragma('user_version', { simple: true }) < 15) migratePoomsaeSchedule(db);
  if (db.pragma('user_version', { simple: true }) < 16) migratePoomsaeOrder(db);
  if (db.pragma('user_version', { simple: true }) < 17) migratePoomsaeStages(db);
  if (db.pragma('user_version', { simple: true }) < 18) migrateWalkovers(db);
  if (db.pragma('user_version', { simple: true }) < 19) migrateJudges(db);
  if (db.pragma('user_version', { simple: true }) < 20) migrateMapLocation(db);
  if (db.pragma('user_version', { simple: true }) < 21) migrateWinsAndJudgeLinks(db);
  if (db.pragma('user_version', { simple: true }) < 22) migrateDropJudgeLinks(db);
  if (db.pragma('user_version', { simple: true }) < 23) migrateSettings(db);
  if (db.pragma('user_version', { simple: true }) < 24) migrateClubCountry(db);
  if (db.pragma('user_version', { simple: true }) < 25) migrateOwner(db);
}

// Safe on old databases: only tables that don't exist yet are created.
function initialise(db) {
  db.exec(SCHEMA);
  migrate(db);
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initialise(db);
  return db;
}

module.exports = { openDb, migrate, initialise };
