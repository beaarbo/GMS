const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin } = require('../src/services');

const PASSWORD = 'test-password-123';

async function login(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const csrf = (await agent.get('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent.post('/login').type('form').send({ _csrf: csrf, email, password });
  return agent;
}
const csrfOf = async (agent, path) => (await agent.get(path)).text.match(/name="_csrf" value="([^"]+)"/)[1];
// The token comes first: awaiting it inside .send() breaks supertest.
async function post(agent, path) {
  const _csrf = await csrfOf(agent, '/admin/competitions');
  return agent.post(path).type('form').send({ _csrf });
}

test('the main admin creates a published demo competition in one click, and removes all of it', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = await login(app, 'admin@test.test');

  const list = (await admin.get('/admin/competitions')).text;
  assert.match(list, />Create demo competition</);
  const created = await post(admin, '/admin/demo');
  assert.equal(created.headers.location, '/admin/competitions');
  const page = (await admin.get('/admin/competitions')).text;
  const password = page.match(/with the password ([A-Za-z0-9_-]+)\./)[1];
  assert.match(page, />Remove demo data</);

  // Published for everyone: the bout list with both events.
  const competition = db.prepare('SELECT * FROM competitions').get();
  assert.equal(competition.status, 'closed');
  assert.ok(competition.bouts_published_at && competition.poomsae_published_at && competition.poomsae_brackets_published_at);
  const bouts = (await request(app).get(`/competitions/${competition.id}/bouts`)).text;
  assert.match(bouts, /Kyorugi/);
  assert.match(bouts, /Poomsae/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bouts WHERE competition_id = ? AND winner_registration_id IS NOT NULL').get(competition.id).n, 0, 'no results yet');
  // No password in the activity log.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE summary LIKE ?').get(`%${password}%`).n, 0);

  // A demo coach logs in with the password shown once and sees their club.
  const coach = await login(app, 'lioncity.coach@demo.invalid', password);
  assert.match((await coach.get('/club')).text, /Lion City Taekwondo/);

  // Only one demo at a time.
  await post(admin, '/admin/demo');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competitions').get().n, 1);

  // A sub-admin can't make or remove it.
  db.prepare("INSERT INTO users (email, password_hash, role, full_name, owner) VALUES ('sub@test.test', ?, 'admin', 'Sub', 0)").run(await bcrypt.hash(PASSWORD, 4));
  const sub = await login(app, 'sub@test.test');
  assert.doesNotMatch((await sub.get('/admin/competitions')).text, /Remove demo data/);
  await post(sub, '/admin/demo/remove');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competitions').get().n, 1, 'still there');

  // Removing it deletes the competition, clubs, athletes and coaches, and nothing else.
  await post(admin, '/admin/demo/remove');
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  assert.deepEqual([count('competitions'), count('clubs'), count('fighters'), db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'coach'").get().n], [0, 0, 0, 0]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n, 2, 'admins stay');
  assert.match((await admin.get('/admin/competitions')).text, />Create demo competition</);
});
