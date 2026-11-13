const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createCompetition, createClub, enterPoomsae, enterFighter, loadDivisionSetup } = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');
const { saveSettings } = require('../src/settings');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;

async function csrfFrom(agent, path) {
  const match = (await agent.get(path)).text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `no CSRF token on ${path}`);
  return match[1];
}

test('one Review registrations page and one Bout list page cover kyorugi and poomsae together', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Both Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'both', poomsae_format: 'score' });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const add = (first) => db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'X', 'F', ?, 3)").run(clubId, first, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  const ana = add('Ana');
  const mia = add('Mia');
  const { classes } = divisionOptions({ fighter: ana, competition, ...loadDivisionSetup(db, id) });
  assert.ok(enterFighter(db, competition, ana, findWeightClass(classes, 48).id).ok);
  assert.ok(enterPoomsae(db, competition, clubId, 'individual', [ana]).ok);
  assert.ok(enterPoomsae(db, competition, clubId, 'individual', [mia]).ok);

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = request.agent(app);
  const loginCsrf = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginCsrf, email: 'admin@test.test', password: PASSWORD });

  const list = (await admin.get('/admin/competitions')).text;
  assert.equal((list.match(/>Review registrations</g) || []).length, 1);
  assert.doesNotMatch(list, /Review poomsae/);

  const review = (await admin.get(`/admin/competitions/${id}/registrations`)).text;
  assert.ok(review.indexOf('Kyorugi') < review.indexOf('Poomsae entries'), 'kyorugi first, then poomsae');
  const reviewCsrf = await csrfFrom(admin, `/admin/competitions/${id}/registrations`);
  const approveAll = await admin.post(`/admin/competitions/${id}/poomsae/review`).type('form')
    .send({ _csrf: reviewCsrf, bulk: 'approve-pending', back: 'registrations' });
  assert.equal(approveAll.headers.location, `/admin/competitions/${id}/registrations#poomsae`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM poomsae_entries WHERE status = 'approved'").get().n, 2);

  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
  const bouts = (await admin.get(`/admin/competitions/${id}/bouts`)).text;
  assert.match(bouts, /Poomsae lists and brackets/);
  assert.match(bouts, /Kyorugi bouts/);
  const boutsCsrf = await csrfFrom(admin, `/admin/competitions/${id}/bouts`);
  const made = await admin.post(`/admin/competitions/${id}/poomsae/order`).type('form')
    .send({ _csrf: boutsCsrf, division: 'all', back: 'bouts' });
  assert.equal(made.headers.location, `/admin/competitions/${id}/bouts#poomsae`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM poomsae_entries WHERE perform_order IS NOT NULL').get().n, 2);
  assert.match((await admin.get(`/admin/competitions/${id}/bouts`)).text, /Publish performance lists/);
});
