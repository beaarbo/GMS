const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const {
  ensureAdmin, createCompetition, createClub, enterFighter, enterPoomsae, loadDivisionSetup, generateBoutList,
  generatePoomsaeOrder, drawDivisionPoomsae, createCoachAccount,
} = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');
const { saveSettings } = require('../src/settings');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;

test('My club on the bout list lists only the coach\'s own competitors, kyorugi and poomsae, with what\'s next', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const tigers = createClub(db, { name: 'Tigers' });
  const dragons = createClub(db, { name: 'Dragons' });
  const id = createCompetition(db, { name: 'Club Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'both', poomsae_format: 'score' });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const add = (clubId, first) => db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'Lee', 'F', ?, 3)").run(clubId, first, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  const ana = add(tigers, 'Ana');
  const dee = add(dragons, 'Dee');
  const { classes } = divisionOptions({ fighter: ana, competition, ...loadDivisionSetup(db, id) });
  const weight = findWeightClass(classes, 48).id;
  assert.ok(enterFighter(db, competition, ana, weight).ok);
  assert.ok(enterFighter(db, competition, dee, weight).ok);
  assert.ok(enterPoomsae(db, competition, tigers, 'individual', [ana]).ok);
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE poomsae_entries SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
  const closed = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  generateBoutList(db, id);
  assert.ok(generatePoomsaeOrder(db, closed, 'all').ok);
  const entry = db.prepare('SELECT * FROM poomsae_entries').get();
  const key = [entry.event, entry.gender, entry.age_group_id, entry.belt_group_id].join('-');
  const drawn = drawDivisionPoomsae(db, closed, key, 'list');
  assert.ok(drawn.ok);
  db.prepare("UPDATE competitions SET bouts_published_at = datetime('now'), poomsae_published_at = datetime('now') WHERE id = ?").run(id);

  await createCoachAccount(db, { full_name: 'Coach', phone: '', email: 'coach@test.test', password: PASSWORD });
  db.prepare("UPDATE users SET club_id = ? WHERE email = 'coach@test.test'").run(tigers);
  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const coach = request.agent(app);
  const csrf = (await coach.get('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await coach.post('/login').type('form').send({ _csrf: csrf, email: 'coach@test.test', password: PASSWORD });

  const mine = (await coach.get(`/competitions/${id}/bouts?club=mine`)).text;
  const table = mine.slice(mine.indexOf('Your competitors'), mine.indexOf('</table>', mine.indexOf('Your competitors')));
  assert.match(table, /Lee Ana<\/strong><\/td>\s*<td>Kyorugi/, 'their kyorugi athlete');
  assert.match(table, /Bout \d+/);
  assert.match(table, /Ana Lee<\/strong><\/td>\s*<td>Poomsae/, 'their poomsae entry');
  assert.match(table, /Performs 1 of 1/);
  assert.match(table, new RegExp(drawn.names.join(' · ')), 'the drawn poomsae');
  assert.doesNotMatch(table, /Dee/, 'never another club\'s');
  assert.doesNotMatch(mine, /<h2>Running order<\/h2>/);

  // The event tab narrows it; everyone else gets the normal bout list.
  assert.doesNotMatch((await coach.get(`/competitions/${id}/bouts?club=mine&event=kyorugi`)).text, /<td>Poomsae<\/td>/);
  const visitor = (await request(app).get(`/competitions/${id}/bouts?club=mine`)).text;
  assert.doesNotMatch(visitor, /Your competitors/);
  assert.match(visitor, /<h2>Running order<\/h2>/);
});
