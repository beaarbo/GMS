const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createCompetition, createClub, enterPoomsae, listDesignatedPoomsae, drawDivisionPoomsae } = require('../src/services');
const { parseDesignated, pickPoomsae, defaultDesignated } = require('../src/poomsae');
const { saveSettings } = require('../src/settings');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;

async function csrfFrom(agent, path) {
  const match = (await agent.get(path)).text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `no CSRF token on ${path}`);
  return match[1];
}

test('designated lists are cleaned, and a draw picks two different poomsae in list order', () => {
  assert.deepEqual(parseDesignated(' Koryo,\nTaegeuk 8 ,koryo,,  Keumgang  '), ['Koryo', 'Taegeuk 8', 'Keumgang']);
  assert.equal(parseDesignated(Array.from({ length: 40 }, (_, i) => `P${i}`).join(',')).length, 30);
  const list = ['A', 'B', 'C', 'D'];
  const picks = [3, 0]; // D, then A from what's left
  assert.deepEqual(pickPoomsae(list, () => picks.shift()), ['A', 'D'], 'in list order');
  for (let i = 0; i < 50; i += 1) {
    const [first, second] = pickPoomsae(list, (n) => Math.floor(Math.random() * n));
    assert.notEqual(first, second);
  }
  assert.equal(pickPoomsae(['Only one'], () => 0), null);
  assert.ok(defaultDesignated('Cadet (U15)').includes('Koryo'));
  assert.deepEqual(defaultDesignated('Made-up group'), []);
});

test('the admin edits a list, spins for a division, and everyone sees the poomsae once drawn', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Forms Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'poomsae', poomsae_format: 'score' });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const ana = db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, 'Ana', 'X', 'F', ?, 3)").run(clubId, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  assert.ok(enterPoomsae(db, competition, clubId, 'individual', [ana]).ok);
  db.prepare("UPDATE poomsae_entries SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
  const entry = db.prepare('SELECT * FROM poomsae_entries').get();
  const key = [entry.event, entry.gender, entry.age_group_id, entry.belt_group_id].join('-');
  const junior = listDesignatedPoomsae(db, id).find((g) => g.id === entry.age_group_id);
  assert.equal(junior.name, 'Junior (U18)');
  assert.deepEqual(junior.designated, defaultDesignated('Junior (U18)'), 'starts from the World Taekwondo list');

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = request.agent(app);
  const loginCsrf = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginCsrf, email: 'admin@test.test', password: PASSWORD });

  // A shorter list on the Divisions page.
  const divisions = `/admin/competitions/${id}/divisions`;
  const listCsrf = await csrfFrom(admin, divisions);
  const saved = await admin.post(`/admin/competitions/${id}/poomsae/designated`).type('form')
    .send({ _csrf: listCsrf, age_group: entry.age_group_id, names: 'Koryo, Keumgang, Taebaek', back: 'divisions' });
  assert.equal(saved.headers.location, `${divisions}#designated-poomsae`, `${saved.status} ${saved.text.slice(0, 300)}`);
  assert.deepEqual(listDesignatedPoomsae(db, id).find((g) => g.id === entry.age_group_id).designated, ['Koryo', 'Keumgang', 'Taebaek']);

  // The wheel asks for JSON: two of the list, recorded on the division.
  const bouts = `/admin/competitions/${id}/bouts`;
  assert.match((await admin.get(bouts)).text, /data-poomsae-wheel/);
  const drawCsrf = await csrfFrom(admin, bouts);
  const spun = await admin.post(`/admin/competitions/${id}/poomsae/draw-poomsae`).type('form').set('Accept', 'application/json')
    .send({ _csrf: drawCsrf, division: key, stage: 'list', back: 'bouts' });
  assert.equal(spun.status, 200);
  assert.equal(spun.body.names.length, 2);
  assert.ok(spun.body.names.every((n) => ['Koryo', 'Keumgang', 'Taebaek'].includes(n)));
  assert.equal(spun.body.back, `${bouts}#division-${key}`);
  const drawn = spun.body.names.join(' · ');
  assert.match((await admin.get(bouts)).text, new RegExp(`Performance list poomsae:</span>\\s*<strong>${drawn}</strong>`));
  assert.match((await admin.get(`/admin/competitions/${id}/results`)).text, new RegExp(drawn));
  assert.equal(drawDivisionPoomsae(db, competition, key, 'bracket').ok, false, 'a ranked division has no bracket');

  // Published, it shows on the public bout list.
  const orderCsrf = await csrfFrom(admin, bouts);
  await admin.post(`/admin/competitions/${id}/poomsae/order`).type('form').send({ _csrf: orderCsrf, division: 'all', back: 'bouts' });
  db.prepare("UPDATE competitions SET poomsae_published_at = datetime('now') WHERE id = ?").run(id);
  assert.match((await request(app).get(`/competitions/${id}/bouts`)).text, new RegExp(`Poomsae: <strong>${drawn}</strong>`));

  // The court screen shows them with the performer on now.
  const where = db.prepare('SELECT list_day, list_court FROM poomsae_divisions WHERE competition_id = ? AND division_key = ?').get(id, key);
  assert.match((await admin.get(`/screens/${id}/poomsae/${where.list_day}/${where.list_court}`)).text, new RegExp(`Poomsae: <strong>${drawn}</strong>`));

  // Once scoring starts, the poomsae stay as drawn.
  db.prepare('UPDATE poomsae_entries SET score = 7.5').run();
  const lockedCsrf = await csrfFrom(admin, bouts);
  const again = await admin.post(`/admin/competitions/${id}/poomsae/draw-poomsae`).type('form').set('Accept', 'application/json')
    .send({ _csrf: lockedCsrf, division: key, stage: 'list', back: 'bouts' });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /Scoring has started/);
});
