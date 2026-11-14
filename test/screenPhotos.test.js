const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const {
  ensureAdmin, createCompetition, createClub, enterFighter, loadDivisionSetup, generateBoutList,
  saveFighterPhoto, createCoachAccount, saveClubIcon,
} = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');
const { saveSettings } = require('../src/settings');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function login(app, email) {
  const agent = request.agent(app);
  const csrf = (await agent.get('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent.post('/login').type('form').send({ _csrf: csrf, email, password: PASSWORD });
  return agent;
}

test('athlete photos show on Review registrations and on staff court screens, never on a coach\'s screen', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Photo Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open' });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const add = (first) => db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'X', 'F', ?, 3)").run(clubId, first, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  const ana = add('Ana');
  const mia = add('Mia');
  const { classes } = divisionOptions({ fighter: ana, competition, ...loadDivisionSetup(db, id) });
  const weight = findWeightClass(classes, 48).id;
  assert.ok(enterFighter(db, competition, ana, weight).ok);
  assert.ok(enterFighter(db, competition, mia, weight).ok);
  saveFighterPhoto(db, ana.id, { data: PNG, contentType: 'image/png' });
  const photo = new RegExp(`src="/admin/competitions/${id}/athletes/${ana.id}/photo\\?v=`);

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = await login(app, 'admin@test.test');
  const review = (await admin.get(`/admin/competitions/${id}/registrations`)).text;
  assert.match(review, photo, 'Ana\'s photo');
  assert.match(review, /athlete-photo sm placeholder/, 'Mia has none yet');

  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed', bouts_published_at = datetime('now') WHERE id = ?").run(id);
  generateBoutList(db, id);
  const { day, court } = db.prepare('SELECT day, court FROM bouts WHERE competition_id = ? AND bout_number IS NOT NULL').get(id);
  const screen = `/screens/${id}/${day}/${court}`;
  assert.match((await admin.get(screen)).text, photo, 'staff see photos on the screen');

  // The club's icon beside its name in each corner, and on the athlete cards.
  const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  saveClubIcon(db, clubId, { data: onePixel, contentType: 'image/png' });
  assert.match((await admin.get(screen)).text, new RegExp(`class="screen-club">\\s*<img class="club-icon md" src="/club-icons/${clubId}\\?v=`));
  const cards = await admin.get(`/admin/competitions/${id}/cards.pdf`).buffer(true).parse((res, done) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
  assert.equal(cards.status, 200);
  assert.ok(cards.body.length > 1000 && cards.body.includes('/Subtype /Image'), 'the icon is drawn');

  await createCoachAccount(db, { full_name: 'Coach', phone: '', email: 'coach@test.test', password: PASSWORD });
  db.prepare("UPDATE users SET club_id = ? WHERE email = 'coach@test.test'").run(clubId);
  const coachScreen = (await (await login(app, 'coach@test.test')).get(screen));
  assert.equal(coachScreen.status, 200);
  assert.doesNotMatch(coachScreen.text, /athlete-photo/, 'coaches see no photos');
});
