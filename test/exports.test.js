const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { readSheet } = require('read-excel-file/node');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const {
  ensureAdmin, createCompetition, createClub, createOfficialAccount, enterFighter, loadDivisionSetup, generateBoutList, listBouts, recordResult,
} = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');
const { saveSettings } = require('../src/settings');
const { entriesSheets, resultsSheets, toXlsx } = require('../src/exports');
const { cardAthletes, cardUrl } = require('../src/athleteCards');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;

async function csrfFrom(agent, path) {
  const match = (await agent.get(path)).text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `no CSRF token on ${path}`);
  return match[1];
}

// A closed competition with two approved juniors in one division, drawn.
async function setup() {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  await createOfficialAccount(db, { full_name: 'Ref', email: 'ref@test.test', password: PASSWORD });
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers', city: 'City' });
  const otherId = createClub(db, { name: '=Lions', city: 'City' });
  const compId = createCompetition(db, { name: 'Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open' });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(compId);
  const add = (club, first, last) => {
    const id = Number(db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, ?, 'F', ?, 3)").run(club, first, last, `${YEAR - 16}-03-01`).lastInsertRowid);
    const fighter = db.prepare('SELECT * FROM fighters WHERE id = ?').get(id);
    const { classes } = divisionOptions({ fighter, competition, ...loadDivisionSetup(db, compId) });
    assert.ok(enterFighter(db, competition, fighter, findWeightClass(classes, 48).id).ok);
    return id;
  };
  const ana = add(clubId, 'Ana', 'Reyes');
  add(otherId, 'Mia', 'Lee');
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(compId);
  generateBoutList(db, compId);
  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} }, publicUrl: 'https://gms.test' });
  return { db, app, compId, competition: db.prepare('SELECT * FROM competitions WHERE id = ?').get(compId), ana };
}

async function login(app, email, firstPath = '/login') {
  const agent = request.agent(app);
  await agent.get(firstPath);
  const _csrf = await csrfFrom(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf, email, password: PASSWORD });
  return { agent, res };
}

test('the entries and results workbooks hold every entry and medallist, as plain text', async () => {
  const { db, compId, competition } = await setup();
  const [kyorugi] = entriesSheets(db, competition);
  assert.equal(kyorugi.sheet, 'Kyorugi');
  const rows = await readSheet(await toXlsx([kyorugi]));
  assert.deepEqual(rows[0].slice(0, 5), ['Club', 'Last name', 'First name', 'Gender', 'Date of birth']);
  // A club name starting with "=" stays text, never a formula.
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[1], r[11]]), [['=Lions', 'Lee', 'Waiting'], ['Tigers', 'Reyes', 'Waiting']]);

  const [bout] = listBouts(db, compId);
  recordResult(db, compId, bout.id, 'blue');
  const [medallists, table] = resultsSheets(db, competition);
  assert.deepEqual(medallists.data.slice(1).map((r) => r[3].value), ['Gold', 'Silver']);
  assert.equal(table.data.length, 3);
});

test('admins download entries and cards; officials get the weigh-in list but not entries', async () => {
  const { app, compId } = await setup();
  const { agent: admin } = await login(app, 'admin@test.test');
  const entries = await admin.get(`/admin/competitions/${compId}/entries.xlsx`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.equal(entries.status, 200);
  assert.match(entries.headers['content-type'], /spreadsheetml/);
  const cards = await admin.get(`/admin/competitions/${compId}/cards.pdf`);
  assert.equal(cards.status, 200);
  assert.equal(cards.headers['content-type'], 'application/pdf');

  const { agent: official } = await login(app, 'ref@test.test');
  assert.equal((await official.get(`/admin/competitions/${compId}/entries.xlsx`)).status, 403);
  assert.equal((await official.get(`/admin/competitions/${compId}/cards.pdf`)).status, 403);
  assert.equal((await official.get(`/admin/competitions/${compId}/weigh-in/list.xlsx`)).status, 200);
  assert.equal((await official.get(`/admin/competitions/${compId}/results/export.xlsx`)).status, 200);
  assert.equal((await request(app).get(`/admin/competitions/${compId}/weigh-in/list.xlsx`)).status, 302);
});

test('a card links to the athlete page, which an official reaches after logging in', async () => {
  const { db, app, compId, competition, ana } = await setup();
  const athletes = cardAthletes(db, competition);
  assert.deepEqual(athletes.map((a) => a.lastName), ['Lee', 'Reyes']);
  assert.match(athletes[1].lines[0], /^Kyorugi: Junior · Female · Black Belt · -49 kg$/);
  const link = cardUrl('https://gms.test', compId, ana).replace('https://gms.test', '');

  const { agent, res } = await login(app, 'ref@test.test', link);
  assert.equal(res.headers.location, link);
  const page = await agent.get(link);
  assert.equal(page.status, 200);
  assert.match(page.text, /Reyes Ana/);
  assert.match(page.text, /href="\/admin\/competitions\/\d+\/weigh-in\?q=Ana\+Reyes#reg-\d+"/);
  assert.match(page.text, /Lee Mia \(=Lions\)/);
  assert.equal((await agent.get(`/admin/competitions/${compId}/athletes/9999`)).status, 404);
});

test('athlete photos: the club uploads one, officials see it, other clubs and visitors never do, and the card carries it', async () => {
  const { createCoachAccount, applyToClub, approveApplication, createClub: makeClub } = require('../src/services');
  const { db, app, compId, ana } = await setup();
  const clubId = db.prepare('SELECT club_id FROM fighters WHERE id = ?').get(ana).club_id;
  const coachId = await createCoachAccount(db, { full_name: 'Coach', phone: '1', email: 'coach@test.test', password: PASSWORD });
  applyToClub(db, coachId, clubId);
  approveApplication(db, db.prepare('SELECT id FROM club_applications WHERE user_id = ?').get(coachId).id);
  const otherClub = makeClub(db, { name: 'Bears', city: 'City' });
  const otherId = await createCoachAccount(db, { full_name: 'Other', phone: '1', email: 'other@test.test', password: PASSWORD });
  applyToClub(db, otherId, otherClub);
  approveApplication(db, db.prepare('SELECT id FROM club_applications WHERE user_id = ?').get(otherId).id);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);

  const { agent: coach } = await login(app, 'coach@test.test');
  const upload = async (file, name) => {
    const _csrf = await csrfFrom(coach, `/club/fighters/${ana}/photo`);
    return coach.post(`/club/fighters/${ana}/photo`).field('_csrf', _csrf).attach('photo', file, name);
  };
  assert.equal((await upload(webp, 'a.webp')).status, 400, 'WebP is refused: the card PDF cannot use it');
  assert.equal((await upload(png, 'a.png')).status, 302);
  assert.match((await coach.get('/club')).text, /\/club\/fighters\/\d+\/photo\/file\?v=/);
  assert.equal((await coach.get(`/club/fighters/${ana}/photo/file`)).status, 200);

  const { agent: other } = await login(app, 'other@test.test');
  assert.equal((await other.get(`/club/fighters/${ana}/photo/file`)).status, 404);
  assert.equal((await request(app).get(`/club/fighters/${ana}/photo/file`)).status, 302);
  assert.equal((await request(app).get(`/admin/competitions/${compId}/athletes/${ana}/photo`)).status, 302);

  const { agent: official } = await login(app, 'ref@test.test');
  const page = await official.get(`/admin/competitions/${compId}/athletes/${ana}`);
  const photoLink = page.text.match(/src="(\/admin\/competitions\/\d+\/athletes\/\d+\/photo\?v=[^"]+)"/)[1];
  assert.equal((await official.get(photoLink.replace(/&amp;/g, '&'))).status, 200);
  // Only for athletes in this competition.
  const outsider = Number(db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, 'Zed', 'Out', 'M', '2010-01-01', 1)").run(clubId).lastInsertRowid);
  db.prepare("INSERT INTO fighter_photos (fighter_id, content_type, data) VALUES (?, 'image/png', ?)").run(outsider, png);
  assert.equal((await official.get(`/admin/competitions/${compId}/athletes/${outsider}/photo`)).status, 404);

  const { agent: admin } = await login(app, 'admin@test.test');
  assert.equal((await admin.get(`/admin/competitions/${compId}/cards.pdf`)).status, 200);
});

test('a club’s country code shows beside its athletes on the bout list, and athletes without a photo get a plain icon', async () => {
  const { db, app, compId, ana } = await setup();
  db.prepare("UPDATE clubs SET country = 'SGP' WHERE name = 'Tigers'").run();
  db.prepare("UPDATE competitions SET bouts_published_at = datetime('now') WHERE id = ?").run(compId);
  const list = (await request(app).get(`/competitions/${compId}/bouts`)).text;
  assert.match(list, /SGP · Tigers/);
  assert.doesNotMatch(list, /· =Lions/, 'a club with no country shows its name alone');
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(compId);
  assert.deepEqual(cardAthletes(db, competition).map((a) => a.club), ['=Lions', 'SGP · Tigers'], 'the athlete card matches');

  const { agent: official } = await login(app, 'ref@test.test');
  const weighIn = (await official.get(`/admin/competitions/${compId}/weigh-in`)).text;
  assert.match(weighIn, new RegExp(`href="/admin/competitions/${compId}/athletes/${ana}"`));
  assert.match(weighIn, /athlete-photo md placeholder/);

  const { agent: admin } = await login(app, 'admin@test.test');
  const clubId = db.prepare("SELECT id FROM clubs WHERE name = 'Tigers'").get().id;
  const _csrf = await csrfFrom(admin, '/admin/clubs');
  await admin.post(`/admin/clubs/${clubId}`).type('form').send({ _csrf, name: 'Tigers', city: 'City', country: 'mas' });
  assert.equal(db.prepare('SELECT country FROM clubs WHERE id = ?').get(clubId).country, 'MAS');
  await admin.post(`/admin/clubs/${clubId}`).type('form').send({ _csrf, name: 'Tigers', city: 'City', country: 'XYZ' });
  assert.equal(db.prepare('SELECT country FROM clubs WHERE id = ?').get(clubId).country, '', 'unknown codes are not kept');
});
