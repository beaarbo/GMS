const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin } = require('../src/services');
const { readPost, formatBody, summary } = require('../src/news');

const PASSWORD = 'test-password-123';

test('post bodies become paragraphs, lines and links', () => {
  assert.deepEqual(formatBody('Hello\nworld\n\n\nSee https://example.com/a?b=1.'), [
    [[{ text: 'Hello' }], [{ text: 'world' }]],
    [[{ text: 'See ' }, { url: 'https://example.com/a?b=1' }, { text: '.' }]],
  ]);
  assert.deepEqual(formatBody('javascript:alert(1) and ftp://x'), [[[{ text: 'javascript:alert(1) and ftp://x' }]]], 'only http(s) links');
  assert.equal(summary('word '.repeat(100), 20), 'word word word word…');
});

test('posts need a title, a body and an audience', () => {
  assert.deepEqual(readPost({}).errors, ['Enter a title.', 'Write the post.', 'Choose who can see the post.']);
  const { values, errors } = readPost({ title: ' Hi ', body: 'a\r\nb', audience: 'members', pinned: '1' });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { title: 'Hi', body: 'a\nb', audience: 'members', pinned: 1 });
  assert.match(readPost({ title: 'x'.repeat(151), body: 'b', audience: 'public' }).errors[0], /150 characters/);
});

async function csrfFrom(agent, path) {
  const page = await agent.get(path);
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

async function login(app, email) {
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/login');
  await agent.post('/login').type('form').send({ _csrf, email, password: PASSWORD });
  return agent;
}

async function publish(admin, fields) {
  const _csrf = await csrfFrom(admin, '/admin/news/new');
  return admin.post('/admin/news').type('form').send({ _csrf, ...fields });
}

test('admins post news; visitors see only public posts', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test' });
  const admin = await login(app, 'admin@test.test');

  const bad = await publish(admin, { title: '', body: '', audience: 'public' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Enter a title/);

  const first = await publish(admin, { title: 'Weigh-in moved', body: 'Now at 8am.\n\n<script>alert(1)</script> https://gms.test/info', audience: 'public' });
  assert.equal(first.status, 302);
  const publicId = first.headers.location.match(/\/news\/(\d+)/)[1];
  await publish(admin, { title: 'Coaches meeting', body: 'Room 2 at 7pm.', audience: 'members', pinned: '1' });
  const membersId = db.prepare("SELECT id FROM news_posts WHERE audience = 'members'").get().id;

  const visitor = request(app);
  const list = await visitor.get('/news');
  assert.match(list.text, /Weigh-in moved/);
  assert.doesNotMatch(list.text, /Coaches meeting/);
  // The front page shows competitions, then the public news below them.
  const front = (await visitor.get('/')).text;
  assert.ok(front.indexOf('Taekwondo competitions') < front.indexOf('Weigh-in moved'), 'news comes after the competitions');
  assert.doesNotMatch(front, /Coaches meeting/);
  // Visitors get a Log in button rather than the menu, and the login page switches to sign-up.
  assert.match(front, /class="btn small topbar-login" href="\/login"/);
  assert.doesNotMatch(front, /id="main-nav"/);
  assert.match((await visitor.get('/login')).text, /class="auth-tabs"[\s\S]*href="\/register"/);
  assert.equal((await visitor.get(`/news/${membersId}`)).status, 404);

  const page = await visitor.get(`/news/${publicId}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<script>alert/, 'post text is escaped');
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page.text, /<a href="https:\/\/gms.test\/info" rel="noopener nofollow"/);

  // Signed-in users see members-only posts too, pinned first.
  const memberList = await admin.get('/news');
  assert.ok(memberList.text.indexOf('Coaches meeting') < memberList.text.indexOf('Weigh-in moved'), 'pinned post first');

  // Edit, then delete.
  let _csrf = await csrfFrom(admin, `/admin/news/${publicId}/edit`);
  await admin.post(`/admin/news/${publicId}`).type('form').send({ _csrf, title: 'Weigh-in moved to 8am', body: 'Details.', audience: 'public' });
  const edited = db.prepare('SELECT title, updated_at FROM news_posts WHERE id = ?').get(publicId);
  assert.equal(edited.title, 'Weigh-in moved to 8am');
  assert.ok(edited.updated_at);

  _csrf = await csrfFrom(admin, '/admin/news');
  await admin.post(`/admin/news/${membersId}/delete`).type('form').send({ _csrf });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM news_posts').get().n, 1);

  const actions = db.prepare("SELECT action FROM activity_log WHERE action LIKE 'news.%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(actions, ['news.posted', 'news.posted', 'news.updated', 'news.deleted']);

  // Coaches can read news but not manage it.
  const coach = request.agent(app);
  _csrf = await csrfFrom(coach, '/register');
  await coach.post('/register').type('form').send({ _csrf, full_name: 'Coach', phone: '5', email: 'coach@test.test', password: PASSWORD });
  assert.equal((await coach.get('/news')).status, 200);
  assert.equal((await coach.get('/admin/news')).status, 403);
  _csrf = await csrfFrom(coach, '/news');
  await coach.post('/admin/news').type('form').send({ _csrf, title: 'Hack', body: 'x', audience: 'public' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM news_posts WHERE title = 'Hack'").get().n, 0);
});

test('the front page lists finished competitions apart, newest first, with their results', async () => {
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/app');
  const { createCompetition } = require('../src/services');
  const request = require('supertest');
  const db = openDb(':memory:');
  const year = new Date().getFullYear();
  createCompetition(db, { name: 'Coming Cup', event_date: `${year + 1}-05-01`, registration_deadline: `${year + 1}-04-01`, venue: 'Hall', status: 'open' });
  createCompetition(db, { name: 'Old Open', event_date: `${year - 2}-05-01`, registration_deadline: `${year - 2}-04-01`, venue: 'Hall', status: 'closed' });
  createCompetition(db, { name: 'Last Open', event_date: `${year - 1}-05-01`, registration_deadline: `${year - 1}-04-01`, venue: 'Hall', status: 'closed' });
  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: false, send: async () => {} } });
  const page = (await request(app).get('/')).text;
  const past = page.slice(page.indexOf('Past competitions'));
  assert.ok(page.indexOf('Coming Cup') < page.indexOf('Past competitions'), 'upcoming ones stay at the top');
  assert.ok(past.indexOf('Last Open') < past.indexOf('Old Open'), 'newest finished one first');
  assert.doesNotMatch(past, /Coming Cup/);
  assert.doesNotMatch(past, /\/results/, 'no results link until results are published');
});

test('a competition link shared on WhatsApp or Facebook previews its logo, name, dates and venue', async () => {
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/app');
  const { createCompetition, saveCompetitionLogo } = require('../src/services');
  const request = require('supertest');
  const db = openDb(':memory:');
  const year = new Date().getFullYear() + 1;
  const id = createCompetition(db, { name: 'City Open', event_date: `${year}-05-01`, registration_deadline: `${year}-04-01`, venue: 'Sports Hall', status: 'open' });
  saveCompetitionLogo(db, id, { data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), contentType: 'image/png' });
  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: false, send: async () => {} }, publicUrl: 'https://gms.test' });
  const page = (await request(app).get(`/competitions/${id}`)).text;
  assert.match(page, /<meta property="og:title" content="City Open">/);
  assert.match(page, /<meta property="og:description" content="[^"]*Sports Hall · Registration closes/);
  assert.ok(page.includes(`<meta property="og:image" content="https://gms.test/competitions/${id}/logo?v=`));
  assert.ok(page.includes(`<meta property="og:url" content="https://gms.test/competitions/${id}">`));
  // The image the preview names must load for someone without an account.
  const image = page.match(/og:image" content="https:\/\/gms\.test([^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.equal((await request(app).get(image)).status, 200);
});
