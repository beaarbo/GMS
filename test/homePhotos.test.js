const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createCompetition, addCompetitionPhoto } = require('../src/services');

const YEAR = new Date().getFullYear() + 1;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('the home page shows up to four photos on each competition card, then how many more', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', 'test-password-123');
  const cup = createCompetition(db, { name: 'Photo Cup', event_date: `${YEAR}-12-01`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open' });
  const plain = createCompetition(db, { name: 'Plain Cup', event_date: `${YEAR}-12-02`, registration_deadline: `${YEAR}-11-01`, venue: 'Hall', status: 'open' });
  for (let i = 0; i < 6; i += 1) addCompetitionPhoto(db, cup, { data: PNG, contentType: 'image/png' });
  const first = db.prepare('SELECT MIN(id) AS id FROM competition_photos').get().id;
  const app = createApp({ db, sessionSecret: 'test-secret', mailer: { configured: true, send: async () => {} } });

  const home = (await request(app).get('/')).text;
  const fromTitle = home.slice(home.indexOf('>Photo Cup</a>'));
  const cupCard = fromTitle.slice(0, fromTitle.indexOf('</article>'));
  assert.equal((cupCard.match(new RegExp(`/competitions/${cup}/photos/`, 'g')) || []).length, 4, 'four shown');
  assert.match(cupCard, /data-more="\+2" aria-label="See all 6 photos of Photo Cup"/);
  assert.doesNotMatch(home, new RegExp(`/competitions/${plain}/photos/`));
  assert.equal((await request(app).get(`/competitions/${cup}/photos/${first}`)).status, 200, 'visitors can open them');
});
