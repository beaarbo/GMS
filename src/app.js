const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const session = require('express-session');
const { BELTS, GENDERS, beltName, formatEventDates } = require('./divisions');
const { EVENT_TYPES, POOMSAE_EVENTS, POOMSAE_GENDERS, POOMSAE_FORMATS, MAX_CUT, JUDGE_COUNTS, hasKyorugi, hasPoomsae, poomsaeDivisionTitle, formatScore, placeText } = require('./poomsae');
const { mapEmbedUrl, mapOpenUrl } = require('./maps');
const { WIN_TYPES } = require('./bracket');
const { createMailer } = require('./mailer');
const { logActivity } = require('./activity');
const { createLiveUpdates } = require('./live');
const { MAX_DOCUMENT_BYTES, MAX_ICON_BYTES, MAX_ATTACHMENT_BYTES, MAX_NEW_COMPETITION_FILES, MAX_COMPETITION_PHOTOS, MAX_COMPETITION_PHOTO_BYTES, documentLabel, documentTypeFor, clubInitials } = require('./documents');
const { MAX_IMPORT_BYTES } = require('./athleteImport');
const { isRegistrationOpen, today, timeLeft, closeExpiredCompetitions, getEventDates, getClubIcon, clubIconVersions, competitionLogoVersions } = require('./services');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const clubRoutes = require('./routes/club');
const coachHomeRoutes = require('./routes/coachHome');
const coachRoutes = require('./routes/coach');
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin');
const competitionDayRoutes = require('./routes/competitionDay');
const officialRoutes = require('./routes/official');
const screenRoutes = require('./routes/screens');
const adminClubRoutes = require('./routes/adminClubs');
const adminNewsRoutes = require('./routes/adminNews');
const adminBackupRoutes = require('./routes/adminBackups');
const adminEmailRoutes = require('./routes/adminEmail');
const adminSettingsRoutes = require('./routes/adminSettings');
const { loadSettings } = require('./settings');
const { EMAIL_KINDS } = require('./notifications');
const { AUDIENCES, formatBody, summary } = require('./news');

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
  // { dir, keep }: where backups go and how many to keep. No dir, no backups.
  backups = { dir: null },
  // Proxy hops to trust for the visitor's address (rate limits, secure cookies).
  trustProxy = production ? 1 : false,
}) {
  const app = express();
  app.locals.backups = backups;
  app.locals.production = production;
  const live = createLiveUpdates();
  app.locals.live = live;
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.db = db;
  // Links in emails use this set address, never the request's Host header, which
  // a caller could fake to send a reset link pointing at their own site.
  app.locals.notify = { db, mailer, publicUrl: publicUrl.replace(/\/+$/, '') };
  if (trustProxy) app.set('trust proxy', trustProxy);

  app.use(
    helmet({
      hsts: production,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          // Google's map embed, for each competition's location (src/maps.js).
          frameSrc: ['https://www.google.com'],
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
    { path: /^\/club\/icon$/, field: 'icon', maxBytes: MAX_ICON_BYTES, tooBig: 'That picture is over the 1 MB limit.' },
    { path: /^\/club\/fighters\/\d+\/photo$/, field: 'photo', maxBytes: MAX_ICON_BYTES, tooBig: 'That photo is over the 1 MB limit.' },
    { path: /^\/admin\/competitions\/\d+\/logo$/, field: 'logo', maxBytes: MAX_ICON_BYTES, tooBig: 'That logo is over the 1 MB limit.' },
    { path: /^\/admin\/competitions\/\d+\/files$/, field: 'file', maxBytes: MAX_ATTACHMENT_BYTES, tooBig: 'That file is over the 10 MB limit.' },
    { path: /^\/admin\/settings\/logo$/, field: 'logo', maxBytes: MAX_ICON_BYTES, tooBig: 'That logo is over the 1 MB limit.' },
  ].map((upload) => ({
    ...upload,
    read: multer({ storage: multer.memoryStorage(), limits: { fileSize: upload.maxBytes, files: 1, fields: 5 } }).single(upload.field),
  }));
  // A competition's photos, several at once.
  uploads.push({
    path: /^\/admin\/competitions\/\d+\/photos$/,
    tooBig: 'A photo is over the 5 MB limit.',
    read: multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_COMPETITION_PHOTO_BYTES, files: MAX_COMPETITION_PHOTOS, fields: 5 } }).array('photos', MAX_COMPETITION_PHOTOS),
  });
  // The new-competition form carries an optional logo, files and photos.
  // The route checks the logo's and photos' own, smaller limits.
  uploads.push({
    path: /^\/admin\/competitions$/,
    tooBig: 'A file is over the 10 MB limit.',
    read: multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_NEW_COMPETITION_FILES + MAX_COMPETITION_PHOTOS + 1, fields: 40 },
    }).fields([{ name: 'logo', maxCount: 1 }, { name: 'files', maxCount: MAX_NEW_COMPETITION_FILES }, { name: 'photos', maxCount: MAX_COMPETITION_PHOTOS }]),
  });
  app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.session.userId || !req.is('multipart/form-data')) return next();
    const upload = uploads.find((u) => u.path.test(req.path));
    if (!upload) return next();
    return upload.read(req, res, (error) => {
      if (error) {
        const messages = {
          LIMIT_FILE_SIZE: upload.tooBig,
          LIMIT_FILE_COUNT: `Attach at most ${MAX_NEW_COMPETITION_FILES} files and ${MAX_COMPETITION_PHOTOS} photos at once.`,
          LIMIT_UNEXPECTED_FILE: `Attach at most ${MAX_NEW_COMPETITION_FILES} files and ${MAX_COMPETITION_PHOTOS} photos at once.`,
        };
        req.uploadError = messages[error.code] || 'That upload could not be read. Please try again.';
      }
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
      // The Settings page: site name, footer, privacy and registration rules.
      site: loadSettings(db),
      emailKinds: EMAIL_KINDS,
      // The site's own address (PUBLIC_URL), for links that must be absolute, like link previews.
      publicUrl: app.locals.notify.publicUrl,
      user: null,
      csrf: req.session.csrf,
      flash: [],
      BELTS,
      GENDERS,
      EVENT_TYPES,
      POOMSAE_EVENTS,
      POOMSAE_GENDERS,
      POOMSAE_FORMATS,
      MAX_CUT,
      JUDGE_COUNTS,
      mapEmbedUrl,
      WIN_TYPES,
      mapOpenUrl,
      hasKyorugi,
      hasPoomsae,
      poomsaeDivisionTitle,
      formatScore,
      placeText,
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
      clubInitials,
      clubIconUrl: () => null,
      siteLogoUrl: () => null,
      competitionLogoUrl: () => null,
      maxNewFiles: MAX_NEW_COMPETITION_FILES,
      maxPhotos: MAX_COMPETITION_PHOTOS,
      fileSize: (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`),
      newsAudiences: AUDIENCES,
      formatBody,
      newsSummary: summary,
      // created_at is SQLite UTC "YYYY-MM-DD HH:MM:SS"; shown as a date in the server's TZ.
      postDate: (value) => new Date(`${String(value).replace(' ', 'T')}Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      eventDatesText: (c) => formatEventDates(getEventDates(db, c.competition_id ?? c.id)),
      deadlineText: (c) => `${formatDate(c.registration_deadline)}, ${c.registration_deadline_time}`,
    };
  }

  app.use((req, res, next) => {
    Object.assign(res.locals, baseLocals(req));
    if (req.session.userId) {
      const user = db
        .prepare(
          `SELECT u.id, u.email, u.role, u.full_name, u.club_id, c.name AS club_name, u.theme,
             u.totp_secret IS NOT NULL AS two_step, u.owner, u.must_change_password
           FROM users u LEFT JOIN clubs c ON c.id = u.club_id WHERE u.id = ?`
        )
        .get(req.session.userId);
      req.user = user || null;
      res.locals.user = req.user;
    }
    req.site = res.locals.site;
    res.locals.flash = req.session.flash || [];
    delete req.session.flash;
    req.flash = (type, text) => {
      req.session.flash = [...(req.session.flash || []), { type, text }];
    };
    // Every change to a competition is logged with it, so this is also where open
    // court screens hear about results, bracket changes and schedule updates.
    req.logActivity = (action, summary, competitionId = null) => {
      logActivity(db, { user: req.user, action, summary, competitionId });
      live.notify(competitionId);
    };
    // Club icon links for templates, read from the database once per page when first needed.
    let iconVersions = null;
    res.locals.clubIconUrl = (clubId) => {
      if ((!req.user && !req.site.publicClubIcons) || !clubId) return null;
      iconVersions = iconVersions || clubIconVersions(db);
      const version = iconVersions.get(Number(clubId));
      return version ? `/club-icons/${clubId}?v=${encodeURIComponent(version)}` : null;
    };
    res.locals.siteLogoUrl = () => {
      const logo = db.prepare('SELECT uploaded_at FROM site_logo WHERE id = 1').get();
      return logo ? `/site-logo?v=${encodeURIComponent(logo.uploaded_at)}` : null;
    };
    let logoVersions = null;
    res.locals.competitionLogoUrl = (competitionId) => {
      logoVersions = logoVersions || competitionLogoVersions(db);
      const version = logoVersions.get(Number(competitionId));
      return version ? `/competitions/${competitionId}/logo?v=${encodeURIComponent(version)}` : null;
    };
    next();
  });

  // Club icons are only shown to logged-in users, unless the Settings page makes
  // them public. The link changes whenever the icon does, so the browser may keep its copy.
  app.get('/club-icons/:id(\\d+)', (req, res) => {
    const icon = req.user || req.site.publicClubIcons ? getClubIcon(db, Number(req.params.id)) : null;
    if (!icon) return res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
    res.setHeader('Content-Type', icon.content_type);
    res.setHeader('Cache-Control', `${req.user ? 'private' : 'public'}, max-age=31536000, immutable`);
    return res.send(icon.data);
  });

  // The organiser's logo in the top bar, from the Settings page.
  app.get('/site-logo', (req, res) => {
    const logo = db.prepare('SELECT content_type, data FROM site_logo WHERE id = 1').get();
    if (!logo) return res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
    res.setHeader('Content-Type', logo.content_type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(logo.data);
  });

  // A sub-admin who logged in with their emailed one-time password must choose
  // their own before anything else.
  app.use((req, res, next) => {
    if (!req.user || !req.user.must_change_password) return next();
    if (req.path === '/account' || req.path === '/account/password' || req.path === '/logout') return next();
    // The account page explains why.
    return res.redirect('/account#password');
  });

  // When the Settings page requires it, an admin without two-step login can only
  // reach their account page (to set it up) until they have.
  app.use((req, res, next) => {
    if (!req.user || req.user.role !== 'admin' || req.user.two_step || !req.site.require2faAdmins) return next();
    if (req.path.startsWith('/account') || req.path === '/logout' || req.method === 'GET' && !req.path.startsWith('/admin')) return next();
    req.flash('error', 'Set up two-step login to use the admin pages. The Settings page requires it for admins.');
    return res.redirect('/account#two-step');
  });

  app.use((req, res, next) => {
    closeExpiredCompetitions(db);
    next();
  });

  app.use(publicRoutes);
  app.use(authRoutes);
  app.use('/home', coachHomeRoutes);
  app.use('/club', clubRoutes);
  app.use('/coach', coachRoutes);
  app.use('/account', accountRoutes);
  app.use('/admin/clubs', adminClubRoutes);
  app.use('/admin/news', adminNewsRoutes);
  app.use('/admin/backups', adminBackupRoutes);
  app.use('/admin/email', adminEmailRoutes);
  app.use('/admin/settings', adminSettingsRoutes);
  // Weigh-in and results first: officials may use them, the rest of /admin they may not.
  app.use('/admin', competitionDayRoutes.router);
  app.use('/admin', adminRoutes);
  app.use('/official', officialRoutes);
  app.use('/screens', screenRoutes);

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
