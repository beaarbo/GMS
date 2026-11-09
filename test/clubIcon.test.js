const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createClub, applyToClub, approveApplication } = require('../src/services');
const { clubInitials, detectIconType } = require('../src/documents');

const PASSWORD = 'test-password-123';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n% fake but starts like a PDF\n');

test('initials and accepted icon types', () => {
  assert.equal(clubInitials('Tigers Taekwondo Club'), 'TT');
  assert.equal(clubInitials('dragons'), 'D');
  assert.equal(clubInitials('  '), '?');
  assert.equal(detectIconType(PNG).contentType, 'image/png');
  assert.equal(detectIconType(PDF), null, 'a PDF is not a picture');
  assert.equal(detectIconType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
});

async function csrfFrom(agent, path) {
  const page = await agent.get(path);
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

async function approvedCoach(app, email, clubName) {
  const { db } = app.locals;
  const clubId = createClub(db, { name: clubName, city: 'City' });
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/register');
  await agent.post('/register').type('form').send({ _csrf, full_name: 'Coach', phone: '555', email, password: PASSWORD });
  const { id } = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  applyToClub(db, id, clubId);
  approveApplication(db, db.prepare('SELECT id FROM club_applications WHERE user_id = ?').get(id).id);
  return { agent, clubId };
}

async function uploadIcon(agent, file, name) {
  const _csrf = await csrfFrom(agent, '/club/icon');
  return agent.post('/club/icon').field('_csrf', _csrf).attach('icon', file, name);
}

test('a coach sets, replaces and removes their own club icon', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test' });
  const tigers = await approvedCoach(app, 'tigers@test.test', 'Tigers Taekwondo');
  const dragons = await approvedCoach(app, 'dragons@test.test', 'Dragons');

  // Without an icon, the dashboard shows the initials and an edit link.
  let dashboard = await tigers.agent.get('/club');
  assert.match(dashboard.text, /class="club-icon lg initials"[^>]*>TT</);
  assert.match(dashboard.text, /href="\/club\/icon"/);

  const rejected = await uploadIcon(tigers.agent, PDF, 'logo.pdf');
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /Upload a JPG, PNG or WebP picture/);

  assert.equal((await uploadIcon(tigers.agent, PNG, 'logo.png')).status, 302);
  const stored = db.prepare('SELECT club_id, content_type FROM club_icons').all();
  assert.deepEqual(stored, [{ club_id: tigers.clubId, content_type: 'image/png' }], 'only their own club changes');

  dashboard = await tigers.agent.get('/club');
  const src = dashboard.text.match(/<img class="club-icon lg" src="([^"]+)"/)[1];
  assert.match(src, new RegExp(`^/club-icons/${tigers.clubId}\\?v=`));

  // Logged-in users can load it; visitors can't.
  const image = await dragons.agent.get(src);
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal((await request(app).get(src)).status, 404);
  assert.equal((await dragons.agent.get(`/club-icons/${dragons.clubId}`)).status, 404, 'no icon yet');

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'club.icon_updated'").get().n, 1);

  const _csrf = await csrfFrom(tigers.agent, '/club/icon');
  assert.equal((await tigers.agent.post('/club/icon/delete').type('form').send({ _csrf })).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM club_icons').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'club.icon_removed'").get().n, 1);

  // A coach still waiting for approval has no club to change.
  const waiting = request.agent(app);
  const token = await csrfFrom(waiting, '/register');
  await waiting.post('/register').type('form').send({ _csrf: token, full_name: 'New', phone: '1', email: 'new@test.test', password: PASSWORD });
  assert.equal((await waiting.get('/club/icon')).status, 302);
});
