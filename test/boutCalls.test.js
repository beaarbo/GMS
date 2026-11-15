const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const {
  ensureAdmin, createCompetition, createClub, enterFighter, loadDivisionSetup, generateBoutList, createCoachAccount, createOfficialAccount,
} = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');
const { saveSettings } = require('../src/settings');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;

async function login(app, email) {
  const agent = request.agent(app);
  const csrf = (await agent.get('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent.post('/login').type('form').send({ _csrf: csrf, email, password: PASSWORD });
  return agent;
}
const csrfOf = async (agent, path) => (await agent.get(path)).text.match(/name="_csrf" value="([^"]+)"/)[1];

test('staff call bout numbers, and the call screen shows the called bouts live', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Call Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', bout_courts: 1 });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const names = ['Ana', 'Bea', 'Cai', 'Dee', 'Eve'];
  let weight;
  names.forEach((first) => {
    const fighter = db.prepare('SELECT * FROM fighters WHERE id = ?').get(
      db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'Lee', 'F', ?, 3)").run(clubId, first, `${YEAR - 16}-03-01`).lastInsertRowid
    );
    weight = weight || findWeightClass(divisionOptions({ fighter, competition, ...loadDivisionSetup(db, id) }).classes, 48).id;
    assert.ok(enterFighter(db, competition, fighter, weight).ok);
  });
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed', bouts_published_at = datetime('now') WHERE id = ?").run(id);
  generateBoutList(db, id);
  const numbered = db.prepare('SELECT bout_number FROM bouts WHERE competition_id = ? AND bout_number IS NOT NULL ORDER BY bout_number').all(id).map((b) => b.bout_number);
  assert.deepEqual(numbered, [1, 2, 3, 4], 'five athletes: four bouts on one court');

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = await login(app, 'admin@test.test');
  const calls = `/admin/competitions/${id}/calls`;
  const screen = `/screens/${id}/calls/1`;
  assert.match((await admin.get(screen)).text, /No bouts have been called yet/);
  assert.match((await admin.get(calls)).text, /Call next: bouts 1–4/, 'the next five, capped at the last bout');

  const call = async (agent, fields) => {
    const _csrf = await csrfOf(agent, calls);
    return agent.post(calls).type('form').send({ _csrf, day: 1, court: 0, ...fields });
  };
  assert.equal((await call(admin, { from: 1, to: 2 })).headers.location, `${calls}?day=1`);
  const shown = (await admin.get(screen)).text;
  assert.match(shown, /Bouts 1-2</);
  assert.equal((shown.match(/class="screen-number">/g) || []).length, 2, 'bouts 1 and 2 only');
  assert.match((await admin.get(calls)).text, /Call next: bouts 3–4/, 'carries on from the last call');

  await call(admin, { from: 9, to: 12 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bout_calls').get().n, 1, 'no bouts numbered 9 to 12');
  await call(admin, { from: 4, to: 3 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bout_calls').get().n, 1, 'last before first');

  // Officials call too; the screen shows the newest call and the one before.
  assert.ok(await createOfficialAccount(db, { full_name: 'Olive', email: 'olive@test.test', password: PASSWORD }));
  const official = await login(app, 'olive@test.test');
  // An official's menu is just Competition day (and their account).
  const officialHome = (await official.get('/official')).text;
  const menu = officialHome.slice(officialHome.indexOf('<nav class="nav"'), officialHome.indexOf('</nav>'));
  assert.match(menu, /href="\/official"[^>]*>Competition day</);
  assert.doesNotMatch(menu, />Competitions<|>News</);
  await call(official, { from: 3, to: 4 });
  const later = (await admin.get(screen)).text;
  assert.match(later, /Bouts 3-4</);
  assert.match(later, /Called before: bouts 1-2 \(/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'bouts.called'").get().n, 2);

  // The main screen: every court with what's on now and next, and the latest call along the bottom.
  const main = (await admin.get(`/screens/${id}/main/1`)).text;
  assert.equal((main.match(/class="main-tile"/g) || []).length, 1, 'one court');
  assert.match(main, /<h2 class="screen-label">Court 1<\/h2>/);
  assert.match(main, /Bout 1<\/span>/, 'bout 1 is on now');
  assert.match(main, /Next: Bout 2/);
  assert.match(main, /class="main-call-text">Bouts 3-4</);
  assert.equal((await admin.get(`/screens/${id}/main/9`)).status, 404, 'no such day');

  // Coaches see the published screen, but can't call.
  await createCoachAccount(db, { full_name: 'Coach', phone: '', email: 'coach@test.test', password: PASSWORD });
  db.prepare("UPDATE users SET club_id = ? WHERE email = 'coach@test.test'").run(clubId);
  const coach = await login(app, 'coach@test.test');
  assert.equal((await coach.get(screen)).status, 200);
  assert.equal((await coach.get(`/screens/${id}/main/1`)).status, 200, 'and the main screen');
  assert.notEqual((await coach.get(calls)).status, 200);
});

test('the main screen\'s calling band shows at most 12, then how many more', async () => {
  const ejs = require('ejs');
  const path = require('path');
  const bouts = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, court: 1, time: '09:00', blue: { name: `Blue ${i + 1}`, club: '' }, red: { name: `Red ${i + 1}`, club: '' } }));
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'screens', 'main.ejs'), {
    competition: { id: 1, name: 'Cup' }, day: 1, dayLabel: 'Day 1', refreshSeconds: 15, updatedAt: '09:00',
    courts: [{ court: 1, label: 'Court 1', now: null, next: null, done: 0, total: 20 }],
    call: { text: 'bouts 1-20', at: '09:00', bouts, division: null, division_key: null },
  });
  assert.equal((html.match(/class="screen-number">/g) || []).length, 12);
  assert.match(html, /\+8 more on the call screen/);
});
