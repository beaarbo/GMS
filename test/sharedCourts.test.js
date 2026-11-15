const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const {
  ensureAdmin, createCompetition, createClub, enterFighter, enterPoomsae, loadDivisionSetup, generateBoutList, drawPoomsaeBracket,
  savePoomsaeSchedule, deleteBoutList,
} = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');
const { saveSettings } = require('../src/settings');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;

test('kyorugi and poomsae share Court 1: the event that goes second starts after the first, its numbers carrying on', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Shared Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'both', poomsae_format: 'elimination' });
  db.prepare("UPDATE competitions SET bout_courts = 1, bout_start = '09:00', bout_minutes = 10, poomsae_courts = 1, poomsae_start = '09:00', poomsae_minutes = 5 WHERE id = ?").run(id);
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const add = (first) => db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'Lee', 'F', ?, 3)").run(clubId, first, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  const ana = add('Ana');
  const bea = add('Bea');
  const weight = findWeightClass(divisionOptions({ fighter: ana, competition, ...loadDivisionSetup(db, id) }).classes, 48).id;
  [ana, bea].forEach((f) => {
    assert.ok(enterFighter(db, competition, f, weight).ok);
    assert.ok(enterPoomsae(db, competition, clubId, 'individual', [f]).ok);
  });
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE poomsae_entries SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
  const closed = () => db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const entry = db.prepare('SELECT * FROM poomsae_entries').get();
  const key = [entry.event, entry.gender, entry.age_group_id, entry.belt_group_id].join('-');
  const kyorugiBout = () => db.prepare('SELECT court, bout_number, start_time FROM bouts WHERE competition_id = ? AND is_bye = 0').get(id);
  const poomsaeBout = () => db.prepare('SELECT court, bout_number, start_time FROM poomsae_bouts WHERE competition_id = ? AND is_bye = 0').get(id);

  // Kyorugi first (the default): poomsae waits for the kyorugi bout on Court 1, and is bout 2.
  generateBoutList(db, id);
  assert.ok(drawPoomsaeBracket(db, closed(), key).ok);
  assert.deepEqual(kyorugiBout(), { court: 1, bout_number: 1, start_time: '09:00' });
  assert.deepEqual(poomsaeBout(), { court: 1, bout_number: 2, start_time: '09:10' });

  // Poomsae first: the poomsae bout opens the day, and kyorugi follows it as bout 2.
  savePoomsaeSchedule(db, id, { courts: 1, start: '09:00', minutes: 5, rest: 0, judges: 1, courtOrder: 'poomsae' });
  assert.deepEqual(poomsaeBout(), { court: 1, bout_number: 1, start_time: '09:00' });
  assert.deepEqual(kyorugiBout(), { court: 1, bout_number: 2, start_time: '09:05' });

  // Back to kyorugi first, then the kyorugi bout list deleted: poomsae no longer waits.
  savePoomsaeSchedule(db, id, { courts: 1, start: '09:00', minutes: 5, rest: 0, judges: 1, courtOrder: 'kyorugi' });
  assert.deepEqual(poomsaeBout(), { court: 1, bout_number: 2, start_time: '09:10' });
  deleteBoutList(db, id);
  assert.deepEqual(poomsaeBout(), { court: 1, bout_number: 1, start_time: '09:00' });
});

test('the Bout list sets each poomsae division\'s day', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Two Day Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'poomsae', poomsae_format: 'elimination' });
  db.prepare("INSERT INTO competition_dates (competition_id, event_date) VALUES (?, ?)").run(id, `${YEAR}-12-02`);
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  ['Ana', 'Bea'].forEach((first) => {
    const f = db.prepare('SELECT * FROM fighters WHERE id = ?').get(
      db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'Lee', 'F', ?, 3)").run(clubId, first, `${YEAR - 16}-03-01`).lastInsertRowid
    );
    assert.ok(enterPoomsae(db, competition, clubId, 'individual', [f]).ok);
  });
  db.prepare("UPDATE poomsae_entries SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
  const entry = db.prepare('SELECT * FROM poomsae_entries').get();
  const key = [entry.event, entry.gender, entry.age_group_id, entry.belt_group_id].join('-');
  assert.ok(drawPoomsaeBracket(db, db.prepare('SELECT * FROM competitions WHERE id = ?').get(id), key).ok);

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = request.agent(app);
  const loginCsrf = (await admin.get('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await admin.post('/login').type('form').send({ _csrf: loginCsrf, email: 'admin@test.test', password: PASSWORD });
  const bouts = `/admin/competitions/${id}/bouts`;
  const page = (await admin.get(bouts)).text;
  assert.match(page, /id="poomsae-days"/);
  assert.match(page, new RegExp(`name="day_${key}"`));
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const saved = await admin.post(`/admin/competitions/${id}/poomsae/days`).type('form').send({ _csrf: csrf, [`day_${key}`]: '2', back: 'bouts' });
  assert.equal(saved.headers.location, `${bouts}#poomsae-days`);
  assert.equal(db.prepare('SELECT day FROM poomsae_divisions WHERE division_key = ?').get(key).day, 2);
  assert.equal(db.prepare('SELECT day FROM poomsae_bouts WHERE competition_id = ? AND is_bye = 0').get(id).day, 2, 'the bracket moved to day 2');
});

test('bout calling covers poomsae: ranges include its bracket bouts, and a whole division can be called', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Call Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'both', poomsae_format: 'elimination' });
  db.prepare("UPDATE competitions SET bout_courts = 1, bout_start = '09:00', bout_minutes = 10, poomsae_courts = 1, poomsae_start = '09:00', poomsae_minutes = 5 WHERE id = ?").run(id);
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const add = (first) => db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'Lee', 'F', ?, 3)").run(clubId, first, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  const ana = add('Ana');
  const bea = add('Bea');
  const weight = findWeightClass(divisionOptions({ fighter: ana, competition, ...loadDivisionSetup(db, id) }).classes, 48).id;
  [ana, bea].forEach((f) => {
    assert.ok(enterFighter(db, competition, f, weight).ok);
    assert.ok(enterPoomsae(db, competition, clubId, 'individual', [f]).ok);
  });
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE poomsae_entries SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed', bouts_published_at = datetime('now') WHERE id = ?").run(id);
  const entry = db.prepare('SELECT * FROM poomsae_entries').get();
  const key = [entry.event, entry.gender, entry.age_group_id, entry.belt_group_id].join('-');
  generateBoutList(db, id);
  assert.ok(drawPoomsaeBracket(db, db.prepare('SELECT * FROM competitions WHERE id = ?').get(id), key).ok);

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = request.agent(app);
  const loginCsrf = (await admin.get('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await admin.post('/login').type('form').send({ _csrf: loginCsrf, email: 'admin@test.test', password: PASSWORD });
  const calls = `/admin/competitions/${id}/calls`;
  const call = async (fields) => {
    const _csrf = (await admin.get(calls)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return admin.post(calls).type('form').send({ _csrf, day: 1, ...fields });
  };

  // Bouts 1-2 on Court 1: the kyorugi bout, then the poomsae bracket bout after it.
  await call({ court: 0, from: 1, to: 2 });
  const screen = (await admin.get(`/screens/${id}/calls/1`)).text;
  assert.equal((screen.match(/class="screen-number">/g) || []).length, 2, 'both bouts');

  // A whole poomsae division: its bracket, with both entrants.
  const page = (await admin.get(calls)).text;
  assert.match(page, new RegExp(`<option value="${key}\|bracket">Court 1`));
  assert.equal((await call({ poomsae: `${key}|bracket` })).headers.location, `${calls}?day=1`);
  const divisionCall = (await admin.get(`/screens/${id}/calls/1`)).text;
  assert.match(divisionCall, /Poomsae: Individual[^<]*bracket on court 1/);
  assert.match(divisionCall, /Ana Lee/);
  assert.match(divisionCall, /Bea Lee/);
  assert.match((await admin.get(`/screens/${id}/main/1`)).text, /Bea Lee/);

  // Visitors see the call, but not the names until the poomsae brackets are published.
  const visitor = (await request(app).get(`/screens/${id}/calls/1`)).text;
  assert.match(visitor, /Poomsae: Individual/);
  assert.doesNotMatch(visitor, /Bea Lee/);
});
