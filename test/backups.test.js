const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const Database = require('better-sqlite3');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createClub } = require('../src/services');
const {
  defaultBackupDir, isBackupName, listBackups, createBackup, pruneBackups, runDailyBackup, restoreBackup,
} = require('../src/backups');

const PASSWORD = 'test-password-123';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gms-backups-'));
}

const clubNames = (file) => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT name FROM clubs ORDER BY name').all().map((r) => r.name);
  } finally {
    db.close();
  }
};

test('backup names are strict, so no request can reach another file', () => {
  assert.ok(isBackupName('gms-20270108-063000-daily.sqlite'));
  assert.ok(isBackupName('gms-20270108-063000-manual.sqlite'));
  ['../gms.sqlite', 'gms-20270108-063000-daily.sqlite.partial', 'gms.sqlite', '.restored-x', 'gms-2027-daily.sqlite'].forEach((name) => {
    assert.equal(isBackupName(name), false, name);
  });
  assert.equal(defaultBackupDir(':memory:'), null);
  assert.equal(defaultBackupDir('/data/gms.sqlite'), path.resolve('/data/backups'));
});

test('daily backups run once a day, are checked copies, and are pruned', async () => {
  const root = tempDir();
  const dir = path.join(root, 'backups');
  const db = openDb(path.join(root, 'gms.sqlite'));
  createClub(db, { name: 'Tigers', city: 'City' });

  const day1 = new Date(2027, 0, 8, 6, 30, 0);
  const first = await runDailyBackup(db, dir, { now: day1 });
  assert.equal(first.name, 'gms-20270108-063000-daily.sqlite');
  assert.equal(await runDailyBackup(db, dir, { now: new Date(2027, 0, 8, 22, 0, 0) }), null, 'once per day');
  assert.deepEqual(clubNames(path.join(dir, first.name)), ['Tigers'], 'the copy holds the data');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.partial')), [], 'no half-written files left');

  for (let day = 9; day <= 12; day += 1) await runDailyBackup(db, dir, { now: new Date(2027, 0, day, 6, 0, 0) });
  await createBackup(db, dir, { kind: 'manual', now: day1 });
  pruneBackups(dir, { daily: 3, manual: 10 });
  const left = listBackups(dir);
  assert.deepEqual(left.filter((b) => b.kind === 'daily').map((b) => b.day), ['20270112', '20270111', '20270110'], 'newest daily ones kept');
  assert.equal(left.filter((b) => b.kind === 'manual').length, 1, 'manual backups are pruned separately');
  db.close();
});

test('a restore swaps the backup in once, after saving the current database', async () => {
  const root = tempDir();
  const dir = path.join(root, 'backups');
  const file = path.join(root, 'gms.sqlite');
  let db = openDb(file);
  createClub(db, { name: 'Tigers', city: 'City' });
  const backup = await createBackup(db, dir, { now: new Date(2027, 0, 8, 6, 0, 0) });
  createClub(db, { name: 'Dragons', city: 'City' });
  db.close();

  assert.equal((await restoreBackup(file, dir, 'gms-19990101-000000-daily.sqlite')).restored, false);
  const result = await restoreBackup(file, dir, backup.name, { now: new Date(2027, 0, 9, 6, 0, 0) });
  assert.equal(result.restored, true);
  assert.deepEqual(clubNames(file), ['Tigers'], 'later changes are gone');
  assert.deepEqual(clubNames(path.join(dir, result.safety)), ['Dragons', 'Tigers'], 'the database from before was saved first');

  // Restarting with the setting still in place does nothing.
  db = openDb(file);
  createClub(db, { name: 'Lions', city: 'City' });
  db.close();
  const again = await restoreBackup(file, dir, backup.name);
  assert.equal(again.restored, false);
  assert.match(again.reason, /already restored/);
  assert.deepEqual(clubNames(file), ['Lions', 'Tigers']);
});

async function csrfFrom(agent, page) {
  const res = await agent.get(page);
  return res.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

test('admins make and download backups; nobody else can', async () => {
  const root = tempDir();
  const dir = path.join(root, 'backups');
  const db = openDb(path.join(root, 'gms.sqlite'));
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', backups: { dir, keep: { daily: 7, manual: 10 } } });

  const admin = request.agent(app);
  const loginToken = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginToken, email: 'admin@test.test', password: PASSWORD });

  assert.match((await admin.get('/admin/backups')).text, /No backups yet/);
  const token = await csrfFrom(admin, '/admin/backups');
  assert.equal((await admin.post('/admin/backups').type('form').send({ _csrf: token })).status, 302);
  const [made] = listBackups(dir);
  assert.equal(made.kind, 'manual');

  const page = await admin.get('/admin/backups');
  assert.match(page.text, new RegExp(`href="/admin/backups/${made.name}">Download`));
  const download = await admin.get(`/admin/backups/${made.name}`).buffer(true).parse((res, done) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
  assert.equal(download.status, 200);
  assert.match(download.headers['content-disposition'], new RegExp(`attachment; filename="${made.name}"`));
  assert.equal(download.body.subarray(0, 15).toString(), 'SQLite format 3');

  assert.equal((await admin.get('/admin/backups/..%2Fgms.sqlite')).status, 404);
  assert.equal((await admin.get('/admin/backups/gms-19990101-000000-daily.sqlite')).status, 404);
  assert.equal((await request(app).get(`/admin/backups/${made.name}`)).status, 302, 'visitors are sent to log in');

  const actions = db.prepare("SELECT action FROM activity_log WHERE action LIKE 'backup.%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(actions, ['backup.created', 'backup.downloaded']);

  // Without a backup folder, the page says so and nothing is made.
  const plain = createApp({ db, sessionSecret: 'test-secret' });
  const other = request.agent(plain);
  const t2 = await csrfFrom(other, '/login');
  await other.post('/login').type('form').send({ _csrf: t2, email: 'admin@test.test', password: PASSWORD });
  assert.match((await other.get('/admin/backups')).text, /Backups aren't set up/);
  db.close();
});
