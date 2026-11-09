# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

Game Management System: registration for taekwondo competitions, kyorugi (sparring) first. The admin (host) creates clubs. Coaches sign up and apply to join a club, and once approved they register that club's fighters for posted competitions. The system places fighters into gender, age, belt and weight divisions and closes registration at the deadline, and the admin approves or rejects each registration. After closing registration, the admin generates a single-elimination bout list with a court and time schedule, shown as brackets and exported as a PDF with one page per division.

## Environment

- OS: Windows 11
- Shell: PowerShell 5.1 (no `&&` or `||`; chain commands with `;`)
- Git is installed at `C:\Program Files\Git\cmd\git.exe`, and the repo's default branch is `main`. Docker is not installed, so the `Dockerfile` hasn't been built here.
- Deploy target: Railway, from the GitHub repo, with a volume at `/data`. Every push to `main` redeploys. See the README's "Deploy it" section for the environment variables.

## Commands

- Install: `npm install`
- Run: `npm start` (or `npm run dev` to restart on changes)
- Demo data: `npm run seed` (logins are listed at the top of `scripts/seed.js`)
- Test: `npm test`

## Architecture

Express with server-rendered EJS and SQLite (better-sqlite3).

- `src/divisions.js`: pure division logic and the default template. No database or web imports.
- `src/bracket.js`: pure single-elimination draw (seed positions, same-club separation), court assignment, and bracket geometry (`layoutBracket`) shared by the web page and the PDF.
- `src/boutlistPdf.js`: draws the bracket layout to PDF with pdfkit.
- `src/mailer.js`, `src/notifications.js`: SMTP sending, and every email the site sends. `createApp` takes a `mailer`, and tests pass one that captures messages.
- `src/documents.js`, `src/activity.js`: athlete document rules and file checks, and the activity log. Call `req.logActivity(action, summary, competitionId)` from any route that changes data.
- `src/services.js`: database operations shared by routes, the seed script and tests.
- `src/db.js`: schema (`CREATE TABLE IF NOT EXISTS`) plus data migrations in `migrate`, tracked with SQLite's `user_version`. Add a new version for any change to existing data.
- `src/app.js`: app factory (`createApp`), security headers, sessions, CSRF.
- `src/backups.js`: database snapshots with SQLite's online backup, checked before they're kept. `server.js` makes one a day (and restores one named in `RESTORE_BACKUP` before opening the database), and `createApp` takes `backups: { dir, keep }` for the admin Backups page.
- `src/athleteImport.js`, `src/news.js`: pure helpers for the spreadsheet athlete import and for news posts (form checks, plain-text body to paragraphs and links).
- `src/routes/`: `public` (home, competitions, news), `auth`, `coachHome` (`/home`, where approved coaches land: upcoming competitions, then news), `coach` (join a club), `club` (approved coaches: fighters, import, entries, club icon), `admin`, `adminClubs` (clubs, coach approvals), `adminNews` and `adminBackups`.
- `views/`, `public/`: templates and static assets.
- `test/`: `node:test`. `flow.test.js` drives the whole app through supertest on an in-memory database.

## Conventions

- Every form needs a hidden `_csrf` field.
- The CSP blocks inline scripts and styles. Put JS in `public/app.js` and CSS in `public/styles.css`.
- Club routes must scope queries by `req.user.club_id`, so clubs can't reach each other's data. A coach has no `club_id` until an admin approves them, and fighters belong to the club, not the coach.
- Core flows must work without JavaScript. `public/app.js` is only an enhancement.

## Notes

- Registrations store their age, belt and weight group IDs at entry time. That's why division setup, event date and age rule lock once registrations exist, and why fighters with an active registration can't be edited.
- A competition's days live in `competition_dates`. `competitions.event_date` always equals the first day, which ages are calculated from, so it locks once registrations exist. Bout `day` numbers are positions in the sorted date list.
- Documents are BLOBs in `fighter_documents`, so never `SELECT *` from it in lists. Uploads are parsed in `app.js` before the CSRF check, which needs the form's token, and only for the document route and logged-in users.
- Never put passwords, tokens or dates of birth in the activity log.
- Coaches pick a weight class, and `assignDivision` refuses any class outside the fighter's age group and gender. No weight is stored.
- The weigh-in (`recordWeighIn`) keeps only the result on the registration (`weigh_status`), never the weight, not even in the session or activity log. Moving class keeps the coach's choice in `entered_weight_class_id` so undo can restore it. Keeping an off-weight athlete in their class is allowed only when their last check found them lighter. No-shows and disqualified athletes aren't drawn, and weigh-ins lock while a bout list exists, like approvals.
- Results move winners by filling the next bout's blue or red slot, so a result can't change once the next bout has one. Redraw and delete are blocked while results exist.
- Email links use `PUBLIC_URL`, never the request's Host header. Reset tokens are stored only as hashes.
- Belts are fixed to Blue, Red and Black (ranks 1 to 3), and every competition's belt groups match.
- Bouts reference approved registrations, so approvals and reopening are blocked while a bout list exists. Keep that rule, or the draw and foreign keys can break.
- `closeExpiredCompetitions` runs on each request, so `status` flips to closed once the deadline passes, in the server's `TZ`. Reopening requires a later deadline.
- Public pages show rules only. Never expose fighter data on them, because many fighters are minors. News posts marked for coaches and organisers return 404 to visitors, and club icons are only served to logged-in users.
- A competition can't open for registration (publish or reopen) without a logo and a description. Logos are in `competition_logos` and attachments in `competition_files`, both BLOBs. They follow the competition's visibility: drafts are admin-only. Attachments are always sent as downloads.
- News bodies are plain text: never render them unescaped. `formatBody` splits them into escaped pieces and http(s) links.
- The database needs a persistent disk, so serverless hosts won't work.
- Backups live in a `backups` folder beside the database (or `BACKUP_DIR`) and contain everything, password hashes included. Only file names matching `isBackupName` are ever read or served, and each download is logged. Never copy the live `.sqlite` file directly for a backup: use `createBackup`, which is safe while the site runs.
- `data/` and `.env` are gitignored. `data/gms.sqlite` on this machine holds demo data only.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
