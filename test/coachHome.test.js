const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createClub, applyToClub, approveApplication, createCompetition, saveEventDates, createNews } = require('../src/services');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear();

async function csrfFrom(agent, path) {
  const page = await agent.get(path);
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

async function register(app, email) {
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/register');
  await agent.post('/register').type('form').send({ _csrf, full_name: 'Sam Coach', phone: '5', email, password: PASSWORD });
  return agent;
}

async function login(app, email) {
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf, email, password: PASSWORD });
  return { agent, location: res.headers.location };
}

function competition(db, name, eventDate, status = 'open') {
  const id = createCompetition(db, {
    name, event_date: eventDate, registration_deadline: `${YEAR + 1}-01-01`, venue: 'Hall', status,
  });
  saveEventDates(db, id, [eventDate]);
  return id;
}

test('coaches land on a home page with upcoming competitions, then news', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const adminId = db.prepare('SELECT id FROM users').get().id;
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test' });

  competition(db, 'Spring Open', `${YEAR + 1}-04-01`);
  competition(db, 'Winter Cup', `${YEAR + 1}-02-01`, 'closed');
  competition(db, 'Last Year Open', `${YEAR - 1}-05-01`, 'closed');
  competition(db, 'Secret Draft', `${YEAR + 1}-03-01`, 'draft');
  createNews(db, { title: 'Coaches briefing', body: 'Room 2.', audience: 'members', pinned: 0 }, adminId);

  // A coach still waiting for approval lands on Join a club, but can open Home.
  const waiting = await register(app, 'waiting@test.test');
  const waitingHome = await waiting.get('/home');
  assert.equal(waitingHome.status, 200);
  assert.match(waitingHome.text, /must approve you for a club/);
  assert.doesNotMatch(waitingHome.text, /Register athletes/);

  const clubId = createClub(db, { name: 'Tigers', city: 'City' });
  await register(app, 'coach@test.test');
  const { id: userId } = db.prepare("SELECT id FROM users WHERE email = 'coach@test.test'").get();
  applyToClub(db, userId, clubId);
  approveApplication(db, db.prepare('SELECT id FROM club_applications WHERE user_id = ?').get(userId).id);

  const { agent, location } = await login(app, 'coach@test.test');
  assert.equal(location, '/home', 'approved coaches land on Home');
  assert.equal((await login(app, 'waiting@test.test')).location, '/coach');
  assert.equal((await login(app, 'admin@test.test')).location, '/admin');

  const page = (await agent.get('/home')).text;
  assert.match(page, /Welcome, Sam Coach/);
  assert.match(page, /href="\/home" aria-current="page">Home/);
  // Upcoming only, soonest first, drafts and finished events hidden.
  const winter = page.indexOf('Winter Cup');
  const spring = page.indexOf('Spring Open');
  assert.ok(winter > 0 && spring > winter, 'soonest first');
  assert.doesNotMatch(page, /Last Year Open|Secret Draft/);
  assert.match(page, /Register athletes/);
  // Competitions sit above the news, and members-only news shows to coaches.
  assert.ok(page.indexOf('Coaches briefing') > spring, 'news below competitions');

  const adminAgent = (await login(app, 'admin@test.test')).agent;
  assert.equal((await adminAgent.get('/home')).headers.location, '/admin');
  assert.equal((await request(app).get('/home')).headers.location, '/login');
});
