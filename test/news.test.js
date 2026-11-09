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
  assert.match((await visitor.get('/')).text, /Latest news[\s\S]*Weigh-in moved/);
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
