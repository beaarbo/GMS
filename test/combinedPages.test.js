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

  // One Divisions page: kyorugi divisions, then poomsae's, each changed in place.
  const divisionsPage = (await admin.get(`/admin/competitions/${id}/divisions`)).text;
  assert.ok(divisionsPage.indexOf('Kyorugi divisions') < divisionsPage.indexOf('Poomsae divisions'));
  const poomsaeKey = db.prepare("SELECT event || '-' || gender || '-' || age_group_id || '-' || belt_group_id AS k FROM poomsae_entries LIMIT 1").get().k;
  const divisionCsrf = await csrfFrom(admin, `/admin/competitions/${id}/divisions`);
  const savedDivision = await admin.post(`/admin/competitions/${id}/poomsae/division`).type('form')
    .send({ _csrf: divisionCsrf, division: poomsaeKey, format: 'elimination', cut: '', day: '', back: 'divisions' });
  assert.equal(savedDivision.headers.location, `/admin/competitions/${id}/divisions#division-${poomsaeKey}`);
  assert.match((await admin.get(`/admin/competitions/${id}/divisions`)).text, new RegExp(`id="division-${poomsaeKey}"[\\s\\S]*?Format: <strong>Single elimination`));
  db.prepare('DELETE FROM poomsae_divisions').run();
  assert.equal((await admin.get(`/admin/competitions/${id}/poomsae`)).headers.location, `/admin/competitions/${id}/divisions#poomsae`, 'the old poomsae page');

  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
  const bouts = (await admin.get(`/admin/competitions/${id}/bouts`)).text;
  assert.match(bouts, /Poomsae lists and brackets/);
  assert.match(bouts, /Kyorugi bouts/);
  const boutsCsrf = await csrfFrom(admin, `/admin/competitions/${id}/bouts`);
  const made = await admin.post(`/admin/competitions/${id}/poomsae/order`).type('form')
    .send({ _csrf: boutsCsrf, division: 'all', back: 'bouts' });
  assert.equal(made.headers.location, `/admin/competitions/${id}/bouts#poomsae`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM poomsae_entries WHERE perform_order IS NOT NULL').get().n, 2);
  const withOrders = (await admin.get(`/admin/competitions/${id}/bouts`)).text;
  assert.match(withOrders, /Publish poomsae bout list/);
  // The performance orders show on the bout list too, after the kyorugi brackets.
  const orders = withOrders.slice(withOrders.indexOf('id="poomsae"'));
  assert.ok(withOrders.indexOf('Kyorugi bouts') < withOrders.indexOf('id="poomsae"'));
  assert.match(orders, /Ana X/);
  assert.match(orders, /Mia X/);
  const key = db.prepare('SELECT event, gender, age_group_id, belt_group_id FROM poomsae_entries LIMIT 1').get();
  const clearCsrf = await csrfFrom(admin, `/admin/competitions/${id}/bouts`);
  const cleared = await admin.post(`/admin/competitions/${id}/poomsae/clear-order`).type('form')
    .send({ _csrf: clearCsrf, division: `${key.event}-${key.gender}-${key.age_group_id}-${key.belt_group_id}`, back: 'bouts' });
  assert.equal(cleared.headers.location, `/admin/competitions/${id}/bouts#poomsae`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM poomsae_entries WHERE perform_order IS NOT NULL').get().n, 0);

  // Head-to-head poomsae: its bracket is drawn and shown on the same page.
  db.prepare("UPDATE competitions SET poomsae_format = 'elimination' WHERE id = ?").run(id);
  const drawCsrf = await csrfFrom(admin, `/admin/competitions/${id}/bouts`);
  const drawn = await admin.post(`/admin/competitions/${id}/poomsae/draw`).type('form').send({ _csrf: drawCsrf, division: 'all', back: 'bouts' });
  assert.equal(drawn.headers.location, `/admin/competitions/${id}/bouts#poomsae`);
  const withBracket = (await admin.get(`/admin/competitions/${id}/bouts`)).text;
  const bracketPart = withBracket.slice(withBracket.indexOf('id="poomsae"'));
  assert.match(bracketPart, /<svg class="bracket"/);
  assert.match(bracketPart, /Ana X/);
  const deleteCsrf = await csrfFrom(admin, `/admin/competitions/${id}/bouts`);
  const deleted = await admin.post(`/admin/competitions/${id}/poomsae/delete-bracket`).type('form')
    .send({ _csrf: deleteCsrf, division: `${key.event}-${key.gender}-${key.age_group_id}-${key.belt_group_id}`, back: 'bouts' });
  assert.equal(deleted.headers.location, `/admin/competitions/${id}/bouts#poomsae`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM poomsae_bouts').get().n, 0);
});

test('the Results page records kyorugi bouts and poomsae scores together', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  const id = createCompetition(db, { name: 'Both Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'both', poomsae_format: 'score' });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const ana = db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, 'Ana', 'X', 'F', ?, 3)").run(clubId, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  assert.ok(enterPoomsae(db, competition, clubId, 'individual', [ana]).ok);
  db.prepare("UPDATE poomsae_entries SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);
  const entryId = db.prepare('SELECT id FROM poomsae_entries').get().id;

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = request.agent(app);
  const loginCsrf = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginCsrf, email: 'admin@test.test', password: PASSWORD });

  const page = (await admin.get(`/admin/competitions/${id}/results`)).text;
  assert.ok(page.indexOf('Kyorugi bouts') < page.indexOf('Poomsae scores and winners'));
  assert.match(page, new RegExp(`action="/admin/competitions/${id}/poomsae/${entryId}/score"`));
  const scoreCsrf = await csrfFrom(admin, `/admin/competitions/${id}/results`);
  const saved = await admin.post(`/admin/competitions/${id}/poomsae/${entryId}/score`).type('form').send({ _csrf: scoreCsrf, score: '7.5', back: 'results' });
  assert.equal(saved.headers.location, `/admin/competitions/${id}/results#result-entry-${entryId}`);
  assert.equal(db.prepare('SELECT score FROM poomsae_entries WHERE id = ?').get(entryId).score, 7.5);

  // One event at a time: the poomsae tab hides the kyorugi bouts, and saving stays on that tab.
  const poomsaeOnly = (await admin.get(`/admin/competitions/${id}/results?event=poomsae`)).text;
  assert.match(poomsaeOnly, /Poomsae: 1 of 1 divisions decided/);
  assert.doesNotMatch(poomsaeOnly, /Kyorugi bouts/);
  assert.match(poomsaeOnly, /Poomsae scores and winners/);
  // Like kyorugi: the division's medallists, then the event's medal standings.
  assert.match(poomsaeOnly, /<strong>Gold:<\/strong> Ana X/);
  assert.match(poomsaeOnly, /Poomsae medal standings[\s\S]*Tigers/);
  assert.doesNotMatch((await admin.get(`/admin/competitions/${id}/results?event=kyorugi`)).text, /Poomsae scores and winners/);
  const tabCsrf = await csrfFrom(admin, `/admin/competitions/${id}/results?event=poomsae`);
  const onTab = await admin.post(`/admin/competitions/${id}/poomsae/${entryId}/score`).type('form').send({ _csrf: tabCsrf, score: '8', back: 'results', event: 'poomsae' });
  assert.equal(onTab.headers.location, `/admin/competitions/${id}/results?event=poomsae#result-entry-${entryId}`);

  const list = (await admin.get('/admin/competitions')).text;
  assert.equal((list.match(/>Results</g) || []).length, 1, 'one Results button');
  assert.doesNotMatch(list, /Poomsae scores/);
});

test('Divisions and Bout list show one event at a time, stay on it after saving, and print one club\'s cards', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  saveSettings(db, { require_document: '0' });
  const clubId = createClub(db, { name: 'Tigers' });
  createClub(db, { name: 'Empty Club' });
  const id = createCompetition(db, { name: 'Both Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open', events: 'both', poomsae_format: 'score' });
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  const ana = db.prepare('SELECT * FROM fighters WHERE id = ?').get(
    db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, 'Ana', 'X', 'F', ?, 3)").run(clubId, `${YEAR - 16}-03-01`).lastInsertRowid
  );
  assert.ok(enterPoomsae(db, competition, clubId, 'individual', [ana]).ok);
  db.prepare("UPDATE poomsae_entries SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(id);

  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });
  const admin = request.agent(app);
  const loginCsrf = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginCsrf, email: 'admin@test.test', password: PASSWORD });

  const poomsaeBouts = (await admin.get(`/admin/competitions/${id}/bouts?event=poomsae`)).text;
  assert.match(poomsaeBouts, /aria-current="page">Poomsae</);
  assert.doesNotMatch(poomsaeBouts, /Kyorugi bouts/);
  assert.match(poomsaeBouts, /Poomsae lists and brackets/);
  assert.doesNotMatch((await admin.get(`/admin/competitions/${id}/bouts?event=kyorugi`)).text, /Poomsae lists and brackets/);
  assert.doesNotMatch((await admin.get(`/admin/competitions/${id}/divisions?event=poomsae`)).text, /Kyorugi divisions/);

  const csrf = await csrfFrom(admin, `/admin/competitions/${id}/bouts?event=poomsae`);
  const made = await admin.post(`/admin/competitions/${id}/poomsae/order`).type('form').send({ _csrf: csrf, division: 'all', back: 'bouts', event: 'poomsae' });
  assert.equal(made.headers.location, `/admin/competitions/${id}/bouts?event=poomsae#poomsae`);
  const withList = (await admin.get(`/admin/competitions/${id}/bouts?event=poomsae`)).text;
  assert.match(withList, /Publish poomsae bout list/);

  // The card download lists only clubs with approved athletes, and prints one club's cards.
  assert.match(withList, /All clubs<\/option>\s*<option value="\d+">Tigers<\/option>\s*<\/select>/);
  const cards = await admin.get(`/admin/competitions/${id}/cards.pdf?club=${clubId}`);
  assert.equal(cards.status, 200);
  assert.match(cards.headers['content-disposition'], new RegExp(`club-${clubId}\.pdf`));
  assert.match((await admin.get('/admin/competitions')).text, new RegExp(`href="/admin/competitions/${id}/cards.pdf">Athlete cards<`));
});
