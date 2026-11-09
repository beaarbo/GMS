const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const session = require('express-session');
const { BELTS, GENDERS, beltName, formatEventDates } = require('./divisions');
const { createMailer } = require('./mailer');
const { logActivity } = require('./activity');
const { MAX_DOCUMENT_BYTES, documentLabel, documentTypeFor } = require('./documents');
const { MAX_IMPORT_BYTES } = require('./athleteImport');
const { isRegistrationOpen, today, timeLeft, closeExpiredCompetitions, getEventDates } = require('./services');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const clubRoutes = require('./routes/club');
const coachRoutes = require('./routes/coach');
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin');
const adminClubRoutes = require('./routes/adminClubs');

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_at < Date.now()) return callback(null, null);
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_MAX_AGE_MS;
      this.db
        .prepare('INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at')
        .run(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    this.set(sid, sess, callback);
  }
}

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function formatDate(value) {
  if (!value) return '';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function createApp({
  db,
  sessionSecret,
  production = false,
  mailer = createMailer({ production }),
  publicUrl = 'http://localhost:3000',
}) {
  const app = express();
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.db = db;
  // Links in emails use this set address, never the request's Host header, which
  // a caller could fake to send a reset link pointing at their own site.
  app.locals.notify = { db, mailer, publicUrl: publicUrl.replace(/\/+$/, '') };
  if (production) app.set('trust proxy', 1);

  app.use(
    helmet({
      hsts: production,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
    })
  );
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 10000 }));

  app.use(
    session({
      name: 'gms.sid',
      secret: sessionSecret,
      store: new SqliteSessionStore(db),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: SESSION_MAX_AGE_MS },
    })
  );

  // Upload forms aren't URL-encoded, so they are read here, ahead of the CSRF
  // check that needs their token. Only logged-in users can reach them, and the
  // file stays in memory until the route has checked who they are and what it is.
  const uploads = [
    { path: /^\/club\/fighters\/\d+\/document$/, field: 'document', maxBytes: MAX_DOCUMENT_BYTES, tooBig: 'That file is over the 5 MB limit.' },
    { path: /^\/club\/fighters\/import$/, field: 'sheet', maxBytes: MAX_IMPORT_BYTES, tooBig: 'That file is over the 1 MB limit.' },
  ].map((upload) => ({
    ...upload,
    read: multer({ storage: multer.memoryStorage(), limits: { fileSize: upload.maxBytes, files: 1, fields: 5 } }).single(upload.field),
  }));
  app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.session.userId || !req.is('multipart/form-data')) return next();
    const upload = uploads.find((u) => u.path.test(req.path));
    if (!upload) return next();
    return upload.read(req, res, (error) => {
      if (error) req.uploadError = error.code === 'LIMIT_FILE_SIZE' ? upload.tooBig : 'That upload could not be read. Please try again.';
      next();
    });
  });

  // CSRF: every form carries a per-session token.
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
    if (req.method === 'POST' && !tokensMatch(req.body && req.body._csrf, req.session.csrf)) {
      return res.status(403).render('error', {
        ...baseLocals(req),
        title: 'Form expired',
        message: 'This form has expired. Go back, refresh the page and try again.',
      });
    }
    return next();
  });

  function baseLocals(req) {
    return {
      user: null,
      csrf: req.session.csrf,
      flash: [],
      BELTS,
      GENDERS,
      beltName,
      formatDate,
      isRegistrationOpen,
      today,
      timeLeft,
      currentPath: req.path,
      // "pending" becomes "Pending" for display.
      statusLabel: (status) => `${String(status).charAt(0).toUpperCase()}${String(status).slice(1)}`,
      documentLabel,
      documentTypeFor,
      eventDatesText: (c) => formatEventDates(getEventDates(db, c.competition_id ?? c.id)),
      deadlineText: (c) => `${formatDate(c.registration_deadline)}, ${c.registration_deadline_time}`,
    };
  }

  app.use((req, res, next) => {
    Object.assign(res.locals, baseLocals(req));
    if (req.session.userId) {
      const user = db
        .prepare(
          `SELECT u.id, u.email, u.role, u.full_name, u.club_id, c.name AS club_name
           FROM users u LEFT JOIN clubs c ON c.id = u.club_id WHERE u.id = ?`
        )
        .get(req.session.userId);
      req.user = user || null;
      res.locals.user = req.user;
    }
    res.locals.flash = req.session.flash || [];
    delete req.session.flash;
    req.flash = (type, text) => {
      req.session.flash = [...(req.session.flash || []), { type, text }];
    };
    req.logActivity = (action, summary, competitionId = null) => {
      logActivity(db, { user: req.user, action, summary, competitionId });
    };
    next();
  });

  app.use((req, res, next) => {
    closeExpiredCompetitions(db);
    next();
  });

  app.use(publicRoutes);
  app.use(authRoutes);
  app.use('/club', clubRoutes);
  app.use('/coach', coachRoutes);
  app.use('/account', accountRoutes);
  app.use('/admin/clubs', adminClubRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again.' });
  });

  return app;
}

module.exports = { createApp };
