// Database backups: consistent snapshots of the live SQLite database, taken with
// SQLite's online backup while the site keeps running. Each one is checked
// before it's kept. Daily snapshots are pruned to the newest few.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const NAME_PATTERN = /^gms-(\d{8})-(\d{6})-(daily|manual)\.sqlite$/;
const DEFAULT_KEEP = { daily: 7, manual: 10 };

// Backups sit in a folder beside the database, so on a host they share its volume.
function defaultBackupDir(databasePath) {
  if (!databasePath || databasePath === ':memory:') return null;
  return path.join(path.dirname(path.resolve(databasePath)), 'backups');
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Only names this module made can be read or served, which also keeps any
// request from reaching a file outside the folder.
function isBackupName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

// Newest first. Times are the server's local time, like registration deadlines.
function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isBackupName)
    .map((name) => {
      const [, day, time, kind] = name.match(NAME_PATTERN);
      return {
        name,
        kind,
        day,
        createdAt: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)} ${time.slice(0, 2)}:${time.slice(2, 4)}`,
        size: fs.statSync(path.join(dir, name)).size,
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function backupPath(dir, name) {
  if (!dir || !isBackupName(name)) return null;
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

// Copies the database to a new backup file, checks the copy opens cleanly, and
// returns its details. A copy that fails the check is deleted.
async function createBackup(db, dir, { kind = 'manual', now = new Date() } = {}) {
  if (!dir) throw new Error('Backups are not set up: there is no backup folder.');
  fs.mkdirSync(dir, { recursive: true });
  let name = `gms-${stamp(now)}-${kind}.sqlite`;
  // Two backups in the same second get distinct names.
  for (let extra = 1; fs.existsSync(path.join(dir, name)); extra += 1) {
    name = `gms-${stamp(new Date(now.getTime() + extra * 1000))}-${kind}.sqlite`;
  }
  const file = path.join(dir, name);
  const partial = `${file}.partial`;
  try {
    await db.backup(partial);
    const copy = new Database(partial, { readonly: true });
    try {
      const check = copy.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`The backup failed its integrity check: ${check}`);
    } finally {
      copy.close();
    }
    fs.renameSync(partial, file);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  return listBackups(dir).find((b) => b.name === name);
}

// Deletes the oldest backups of each kind beyond the number to keep.
function pruneBackups(dir, keep = DEFAULT_KEEP) {
  const removed = [];
  ['daily', 'manual'].forEach((kind) => {
    listBackups(dir)
      .filter((b) => b.kind === kind)
      .slice(keep[kind] ?? DEFAULT_KEEP[kind])
      .forEach((b) => {
        fs.rmSync(path.join(dir, b.name), { force: true });
        removed.push(b.name);
      });
  });
  return removed;
}

// Makes today's daily backup if there isn't one yet, then prunes. Safe to call
// often: it does nothing once today's backup exists.
async function runDailyBackup(db, dir, { keep = DEFAULT_KEEP, now = new Date() } = {}) {
  if (!dir) return null;
  const today = stamp(now).slice(0, 8);
  if (listBackups(dir).some((b) => b.kind === 'daily' && b.day === today)) return null;
  const backup = await createBackup(db, dir, { kind: 'daily', now });
  pruneBackups(dir, keep);
  return backup;
}

// Swaps a backup in for the database file, before the server opens it. The
// current database is first saved as a backup of its own, and a marker stops a
// restart with the same setting from restoring again. Returns what it did.
async function restoreBackup(databasePath, dir, name, { now = new Date() } = {}) {
  const source = backupPath(dir, name);
  if (!source) return { restored: false, reason: `There is no backup called ${name} in ${dir}.` };
  const marker = path.join(dir, `.restored-${name}`);
  if (fs.existsSync(marker)) {
    return { restored: false, reason: `${name} was already restored. Remove the RESTORE_BACKUP setting.` };
  }
  let safety = null;
  if (fs.existsSync(databasePath)) {
    const current = new Database(databasePath);
    try {
      safety = await createBackup(current, dir, { kind: 'manual', now });
    } finally {
      current.close();
    }
  }
  ['-wal', '-shm'].forEach((suffix) => fs.rmSync(`${databasePath}${suffix}`, { force: true }));
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  fs.copyFileSync(source, databasePath);
  fs.writeFileSync(marker, `Restored ${new Date().toISOString()}\n`);
  return { restored: true, safety: safety && safety.name };
}

module.exports = {
  DEFAULT_KEEP,
  restoreBackup,
  defaultBackupDir,
  isBackupName,
  listBackups,
  backupPath,
  createBackup,
  pruneBackups,
  runDailyBackup,
};
