// Local demo data. Refuses to run in production.
// Demo logins (all use the password below):
//   admin@demo.test, tigers@demo.test, dragons@demo.test (approved coaches),
//   newcoach@demo.test (a coach waiting for approval)
require('dotenv').config();

const { openDb } = require('../src/db');
const {
  createCompetition,
  createClub,
  createCoachAccount,
  applyToClub,
  approveApplication,
  ensureAdmin,
  enterFighter,
  loadDivisionSetup,
  saveFighterDocument,
} = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');

const DEMO_PASSWORD = 'demo-password-123';
// A 1x1 PNG, standing in for a photographed grading card or certificate.
const DEMO_DOCUMENT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('The seed script does not run in production.');
    process.exit(1);
  }

  const db = openDb(process.env.DATABASE_PATH || './data/gms.sqlite');
  if (db.prepare('SELECT 1 FROM competitions LIMIT 1').get()) {
    console.log('The database already has competitions, so nothing was changed.');
    return;
  }

  await ensureAdmin(db, 'admin@demo.test', DEMO_PASSWORD);

  const compId = createCompetition(db, {
    name: 'City Open Taekwondo Championship',
    event_date: isoDaysFromNow(60),
    registration_deadline: isoDaysFromNow(45),
    venue: 'City Sports Complex',
    description: 'Demo competition. Kyorugi only.',
    status: 'open',
  });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(compId);

  const year = new Date().getFullYear();
  const clubs = [
    {
      club: { name: 'Tigers Taekwondo Club', city: 'Demo City', country: 'SGP' },
      coach: { full_name: 'Demo Coach A', phone: '555-0101', email: 'tigers@demo.test' },
      fighters: [
        ['Alex', 'Reyes', 'M', `${year - 16}-03-14`, 3, 58],
        ['Ben', 'Uy', 'M', `${year - 16}-08-21`, 3, 58.5],
        ['Max', 'Go', 'M', `${year - 16}-12-05`, 3, 56],
        ['Sam', 'Cruz', 'F', `${year - 16}-07-02`, 3, 48.5],
        ['Jamie', 'Santos', 'M', `${year - 13}-11-20`, 1, 44],
        ['Robin', 'Lim', 'F', `${year - 25}-01-09`, 3, 56.2],
      ],
    },
    {
      club: { name: 'Dragons Martial Arts', city: 'Demo City', country: 'MAS' },
      coach: { full_name: 'Demo Coach B', phone: '555-0102', email: 'dragons@demo.test' },
      fighters: [
        ['Kai', 'Tan', 'M', `${year - 16}-05-30`, 3, 57.5],
        ['Leo', 'Chua', 'M', `${year - 16}-10-18`, 3, 58.2],
        ['Noor', 'Garcia', 'F', `${year - 16}-09-12`, 3, 47],
        ['Drew', 'Ong', 'M', `${year - 9}-02-25`, 1, 27],
      ],
    },
  ];

  for (const club of clubs) {
    const clubId = createClub(db, club.club);
    const userId = await createCoachAccount(db, { ...club.coach, password: DEMO_PASSWORD });
    applyToClub(db, userId, clubId);
    approveApplication(db, db.prepare("SELECT id FROM club_applications WHERE user_id = ? AND status = 'pending'").get(userId).id);
    club.fighters.forEach(([first, last, gender, dob, belt, weight]) => {
      const id = db
        .prepare('INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, ?, ?, ?, ?)')
        .run(clubId, first, last, gender, dob, belt).lastInsertRowid;
      const fighter = db.prepare('SELECT * FROM fighters WHERE id = ?').get(id);
      saveFighterDocument(db, fighter, { data: DEMO_DOCUMENT, contentType: 'image/png' });
      const options = divisionOptions({ fighter, competition, ...loadDivisionSetup(db, compId) });
      const result = enterFighter(db, competition, fighter, findWeightClass(options.classes, weight).id);
      if (!result.ok) throw new Error(`${first} ${last}: ${result.error}`);
    });
  }

  const newCoach = await createCoachAccount(db, {
    full_name: 'Demo Coach C',
    phone: '555-0103',
    email: 'newcoach@demo.test',
    password: DEMO_PASSWORD,
  });
  applyToClub(db, newCoach, db.prepare('SELECT id FROM clubs ORDER BY id').get().id);

  console.log('Demo data created. Logins are listed at the top of scripts/seed.js.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
