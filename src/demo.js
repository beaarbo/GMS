// A ready-to-show demo competition for the live site: three clubs with a coach
// each, about thirty athletes, and a competition with kyorugi and poomsae that is
// closed, drawn, given its poomsae and published, with no results yet, so results,
// screens and bout calling can be shown live. Everything it makes is listed in
// site_settings.demo_data, so removeDemoData deletes exactly that and nothing else.
// Coach emails use the reserved .invalid domain, so no email reaches a real person.
const crypto = require('crypto');
const zlib = require('zlib');
const {
  createCompetition, createClub, createCoachAccount, applyToClub, approveApplication, enterFighter, enterPoomsae,
  loadDivisionSetup, saveFighterDocument, saveCompetitionLogo, saveClubIcon, generateBoutList, savePoomsaeDivision,
  drawPoomsaeBracket, generatePoomsaeOrder, drawDivisionPoomsae, deleteCompetition, listPoomsaeEntries,
} = require('./services');
const { divisionOptions, findWeightClass } = require('./divisions');

const KEY = 'demo_data';
const DAY = 86400000;

// A small PNG made with zlib alone (RGBA, no filter), for the logo and club badges.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(size, colourAt) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) colourAt(x, y).forEach((v, i) => { rows[y * (size * 4 + 1) + 1 + x * 4 + i] = v; });
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// A disc: red over blue across the diagonal (the site's mark), or one colour with a white ring.
function badge(size, top, bottom = top) {
  const r = size / 2;
  return png(size, (x, y) => {
    const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
    if (d > r - 1) return [0, 0, 0, 0];
    if (d > r * 0.8 && d < r * 0.88) return [250, 250, 248, 255];
    return [...hex(x + y < size ? top : bottom), 255];
  });
}

const CLUBS = [
  { name: 'Lion City Taekwondo', country: 'SGP', colour: '#C62828', coach: 'Coach Lim', email: 'lioncity.coach@demo.invalid',
    M: ['Ethan Tan', 'Ryan Ng', 'Aaron Lee', 'Daniel Wong', 'Lucas Goh', 'Marcus Ong', 'Jayden Koh', 'Isaac Teo'],
    F: ['Chloe Lim', 'Megan Koh', 'Sophia Teo', 'Isabelle Chua', 'Hannah Seah'] },
  { name: 'Harimau Taekwondo Club', country: 'MAS', colour: '#1565C0', coach: 'Coach Rahman', email: 'harimau.coach@demo.invalid',
    M: ['Aiman Rahman', 'Haziq Ismail', 'Danial Yusof', 'Irfan Hakim', 'Wei Jie Lim', 'Arjun Raj', 'Hafiz Omar', 'Zul Azman'],
    F: ['Nur Aisyah', 'Siti Hajar', 'Farah Idris', 'Balqis Azman', 'Kavitha Raj'] },
  { name: 'Garuda Taekwondo', country: 'INA', colour: '#2E7D32', coach: 'Coach Santoso', email: 'garuda.coach@demo.invalid',
    M: ['Budi Santoso', 'Rizky Pratama', 'Agus Wijaya', 'Fajar Nugroho', 'Dimas Saputra', 'Eko Prasetyo', 'Yusuf Hidayat', 'Bayu Firmansyah'],
    F: ['Putri Lestari', 'Dewi Anggraini', 'Sari Wulandari', 'Ayu Kartika', 'Intan Permata'] },
];

// Who fights: gender, age at the event, belt (1 Blue, 2 Red, 3 Black), and one
// weight per athlete (the same weight puts them in the same division). poomsae:
// these athletes also enter individual poomsae; 'bracket' makes that a head-to-head division.
const COHORTS = [
  { gender: 'M', age: 9, belt: 1, weights: [27, 27, 27], poomsae: 'list' },
  { gender: 'F', age: 10, belt: 1, weights: [30, 30] },
  { gender: 'M', age: 13, belt: 2, weights: [45, 45, 45, 45], poomsae: 'list' },
  { gender: 'F', age: 13, belt: 2, weights: [44, 44, 44] },
  { gender: 'M', age: 16, belt: 3, weights: [58, 58, 58, 58, 58] },
  { gender: 'M', age: 16, belt: 3, weights: [68, 68, 68] },
  { gender: 'F', age: 16, belt: 3, weights: [49, 49, 49, 49], poomsae: 'bracket' },
  { gender: 'M', age: 22, belt: 3, weights: [74, 74, 74, 74], poomsae: 'list' },
  { gender: 'F', age: 22, belt: 3, weights: [57, 57, 57] },
];

const DOCUMENT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function loadDemo(db) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : null;
}

// Builds the demo. Refuses while one exists. Returns { ok, competitionId, coaches: [{ email, club }], password }.
async function createDemoCompetition(db) {
  if (loadDemo(db)) return { ok: false, error: 'A demo competition already exists. Remove it first to make a new one.' };
  const today = new Date();
  const iso = (days) => new Date(today.getTime() + days * DAY).toISOString().slice(0, 10);
  const eventDate = iso(30);
  const eventYear = Number(eventDate.slice(0, 4));
  const password = crypto.randomBytes(9).toString('base64url');
  const made = { competitionId: null, clubIds: [], userIds: [] };

  // Coaches first (hashing is slow), outside the transaction that builds the rest.
  const coachIds = [];
  for (const club of CLUBS) coachIds.push(await createCoachAccount(db, { full_name: club.coach, phone: '', email: club.email, password }));
  made.userIds = coachIds;

  try {
    db.transaction(() => {
      const id = createCompetition(db, {
        name: `Demo Open ${eventYear}`,
        event_date: eventDate,
        registration_deadline: iso(20),
        venue: 'Demo Sports Hall',
        description: 'A demonstration competition with made-up clubs and athletes, to show how the site runs a competition from entry to medal. Kyorugi and poomsae share two courts.',
        status: 'open',
        events: 'both',
        poomsae_format: 'score',
        bout_courts: 2,
        poomsae_courts: 1,
      });
      made.competitionId = id;
      saveCompetitionLogo(db, id, { data: badge(256, '#C62828', '#1565C0'), contentType: 'image/png' });
      const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
      const setup = loadDivisionSetup(db, id);

      const clubs = CLUBS.map((club, i) => {
        const clubId = createClub(db, { name: club.name, country: club.country });
        made.clubIds.push(clubId);
        saveClubIcon(db, clubId, { data: badge(128, club.colour), contentType: 'image/png' });
        applyToClub(db, coachIds[i], clubId);
        approveApplication(db, db.prepare("SELECT id FROM club_applications WHERE user_id = ? AND status = 'pending'").get(coachIds[i]).id);
        return { ...club, id: clubId, next: { M: 0, F: 0 } };
      });

      let turn = 0;
      COHORTS.forEach((cohort) => {
        const athletes = cohort.weights.map((weight) => {
          const club = clubs[turn % clubs.length];
          turn += 1;
          const [first, last] = club[cohort.gender][club.next[cohort.gender]++].split(' ');
          const fighterId = db.prepare('INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, ?, ?, ?, ?)')
            .run(club.id, first, last, cohort.gender, `${eventYear - cohort.age}-06-15`, cohort.belt).lastInsertRowid;
          const fighter = db.prepare('SELECT * FROM fighters WHERE id = ?').get(fighterId);
          saveFighterDocument(db, fighter, { data: DOCUMENT, contentType: 'image/png' });
          const weightClass = findWeightClass(divisionOptions({ fighter, competition, ...setup }).classes, weight);
          if (!weightClass) throw new Error(`No weight class for ${first} ${last} at ${weight} kg.`);
          const entered = enterFighter(db, competition, fighter, weightClass.id);
          if (!entered.ok) throw new Error(`${first} ${last}: ${entered.error}`);
          return { fighter, clubId: club.id };
        });
        if (cohort.poomsae) {
          athletes.forEach(({ fighter, clubId }) => {
            const entered = enterPoomsae(db, competition, clubId, 'individual', [fighter]);
            if (!entered.ok) throw new Error(`${fighter.first_name} ${fighter.last_name} (poomsae): ${entered.error}`);
          });
        }
      });

      // Everyone approved, registration closed, both events drawn and published.
      db.prepare("UPDATE registrations SET status = 'approved' WHERE competition_id = ?").run(id);
      db.prepare("UPDATE poomsae_entries SET status = 'approved' WHERE competition_id = ?").run(id);
      db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
      generateBoutList(db, id);
      const closed = () => db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
      const keyOf = (e) => [e.event, e.gender, e.age_group_id, e.belt_group_id].join('-');
      const bracketAthletes = new Set(COHORTS.filter((c) => c.poomsae === 'bracket').map((c) => `${c.gender}:${c.age}`));
      const divisionKeys = [...new Set(listPoomsaeEntries(db, id).map(keyOf))];
      divisionKeys.forEach((key) => {
        const entry = listPoomsaeEntries(db, id).find((e) => keyOf(e) === key);
        if (bracketAthletes.has(`${entry.gender}:${entry.athletes[0].age_at_event}`)) {
          savePoomsaeDivision(db, closed(), key, { format: 'elimination', cut: null, day: null });
          drawPoomsaeBracket(db, closed(), key);
          drawDivisionPoomsae(db, closed(), key, 'bracket');
        }
      });
      generatePoomsaeOrder(db, closed(), 'all');
      divisionKeys.forEach((key) => drawDivisionPoomsae(db, closed(), key, 'list'));
      db.prepare("UPDATE competitions SET bouts_published_at = datetime('now'), poomsae_published_at = datetime('now'), poomsae_brackets_published_at = datetime('now') WHERE id = ?").run(id);
      db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(made));
    })();
  } catch (error) {
    // Nothing half-made stays behind: the transaction rolled back, so only the coaches remain.
    db.prepare(`DELETE FROM users WHERE role = 'coach' AND id IN (${coachIds.map(() => '?').join(',')})`).run(...coachIds);
    throw error;
  }
  return { ok: true, competitionId: made.competitionId, password, coaches: CLUBS.map((c) => ({ email: c.email, club: c.name })) };
}

// Deletes everything the demo made: its competition, clubs (and their athletes) and coaches.
function removeDemoData(db) {
  const demo = loadDemo(db);
  if (!demo) return { ok: false, error: 'There is no demo competition to remove.' };
  db.transaction(() => {
    if (demo.competitionId && db.prepare('SELECT 1 FROM competitions WHERE id = ?').get(demo.competitionId)) deleteCompetition(db, demo.competitionId);
    const list = (ids) => ids.map(() => '?').join(',') || 'NULL';
    db.prepare(`DELETE FROM users WHERE role = 'coach' AND id IN (${list(demo.userIds)})`).run(...demo.userIds);
    // A demo athlete entered in a real competition since would block this; that's left to the admin.
    db.prepare(`DELETE FROM clubs WHERE id IN (${list(demo.clubIds)})`).run(...demo.clubIds);
    db.prepare('DELETE FROM site_settings WHERE key = ?').run(KEY);
  })();
  return { ok: true };
}

module.exports = { createDemoCompetition, removeDemoData, loadDemo, png };
