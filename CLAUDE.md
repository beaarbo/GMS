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
- `src/poomsae.js`: pure poomsae logic: event types (`competitions.events`: kyorugi, poomsae or both, with `hasKyorugi`/`hasPoomsae`), entry placement (`placeEntry`), score parsing and ranking.
- `src/bracket.js`: pure single-elimination draw (seed positions, same-club separation), court assignment, and bracket geometry (`layoutBracket`) shared by the web page and the PDF.
- `src/boutlistPdf.js`: draws the bracket layout to PDF with pdfkit.
- `src/mailer.js`, `src/notifications.js`: SMTP sending, and every email the site sends. `createApp` takes a `mailer`, and tests pass one that captures messages. `send()` never throws; `test()` and `details()` (masked login, no password or key) serve the admin Email page (`adminEmail` route), and `explainMailError` turns errors into advice. `BREVO_API_KEY` or `RESEND_API_KEY` sends over HTTPS with `fetch` and wins over SMTP, because Railway can block outgoing SMTP.
- `server.js` reads `NODE_ENV` loosely (any case, trimmed) and passes `trustProxy` to `createApp`: on in production or on Railway, overridable with `TRUST_PROXY`. Without it, `req.ip` is the proxy's and every visitor shares one rate limit.
- `src/documents.js`, `src/activity.js`: athlete document rules and file checks, and the activity log. Call `req.logActivity(action, summary, competitionId)` from any route that changes data.
- `src/services.js`: database operations shared by routes, the seed script and tests.
- `src/db.js`: schema (`CREATE TABLE IF NOT EXISTS`) plus data migrations in `migrate`, tracked with SQLite's `user_version`. Add a new version for any change to existing data.
- `src/app.js`: app factory (`createApp`), security headers, sessions, CSRF.
- `src/live.js`: in-memory change signals per competition. `req.logActivity(…, competitionId)` sends one, so any logged change reaches open court screens through their server-sent event stream (`/screens/:id/:day/:court/events`), and `public/app.js` swaps in the new content. Log every competition change with its id, or screens won't update. It suits one server process; several would need a shared channel.
- `src/backups.js`: database snapshots with SQLite's online backup, checked before they're kept. `server.js` makes one a day (and restores one named in `RESTORE_BACKUP` before opening the database), and `createApp` takes `backups: { dir, keep }` for the admin Backups page.
- `src/athleteImport.js`, `src/news.js`: pure helpers for the spreadsheet athlete import and for news posts (form checks, plain-text body to paragraphs and links).
- `src/settings.js`: the Settings page's values (`site_settings`, text by key, with defaults in `DEFAULTS`). `loadSettings(db)` gives them typed; every page has them as `site` and routes as `req.site`. `createCompetition` starts from `defaults`, `shortenNames` shortens athlete names (objects with `name` beside `club`) on public pages for visitors, and `applyTimeZone` sets `process.env.TZ`. Secrets stay environment variables. `src/routes/adminSettings.js` is the page.
- `src/totp.js`: two-step login codes (RFC 6238) and recovery codes. `users.totp_secret` turns it on; `/login/code` is the second step, and recovery codes are stored only as hashes. `users.theme` and `users.email_opt_out` (kinds from `EMAIL_KINDS` in `notifications.js`) are My account choices; send role-wide emails through `clubCoachEmails(db, clubId, kind)` or the `wants(kind)` filter so opt-outs hold.
- `src/maps.js`: a competition's map location (`competitions.map_query`: an address, place name or "lat,lng", read out of a full Google Maps link by `readMapLocation`). Shown with Google's keyless embed, so the CSP allows frames from `https://www.google.com` only; short `maps.app.goo.gl` links are refused because reading them needs a fetch.
- `src/routes/`: `public` (home, competitions, news), `auth`, `coachHome` (`/home`, where approved coaches land: upcoming competitions, then news), `coach` (join a club), `club` (approved coaches: fighters, import, entries, club icon), `admin`, `adminClubs` (clubs, coach approvals), `adminNews`, `adminBackups`, `competitionDay` (weigh-in, results and poomsae scores, shared by admins and officials, mounted on `/admin` before `admin`), `official` (`/official`, an official's start page; `competitionDay` also serves the results-by-mat page `/admin/competitions/:id/mat/:day/:court`, which posts to the normal results route with `back=mat`) and `screens` (court screens).
- `views/`, `public/`: templates and static assets.
- `test/`: `node:test`. `flow.test.js` drives the whole app through supertest on an in-memory database.

## Conventions

- Every form needs a hidden `_csrf` field.
- The CSP blocks inline scripts and styles. Put JS in `public/app.js` and CSS in `public/styles.css`.
- Colours come from the tokens in `:root` in `public/styles.css`; never hard-code one in a rule, or the dark theme misses it. The dark theme redefines the tokens twice (for `data-theme="dark"` and for the device setting), so change both blocks together, and the print block resets them to light. `--chung`, `--hong` and `--ok` are text and line colours; backgrounds under white text use the `-fill` tokens. `public/theme.js` (loaded before the stylesheet) applies a saved choice so the page doesn't flash. Court screens are always dark.
- Club routes must scope queries by `req.user.club_id`, so clubs can't reach each other's data. A coach has no `club_id` until an admin approves them, and fighters belong to the club, not the coach.
- Core flows must work without JavaScript. `public/app.js` is only an enhancement.

## Notes

- Registrations store their age, belt and weight group IDs at entry time. That's why division setup, event date and age rule lock once registrations exist, and why fighters with an active registration can't be edited.
- A competition's days live in `competition_dates`. `competitions.event_date` always equals the first day, which ages are calculated from, so it locks once registrations exist. Bout `day` numbers are positions in the sorted date list.
- Documents are BLOBs in `fighter_documents`, so never `SELECT *` from it in lists. Uploads are parsed in `app.js` before the CSRF check, which needs the form's token, and only for the document route and logged-in users.
- Never put passwords, tokens or dates of birth in the activity log.
- Coaches pick a weight class, and `assignDivision` refuses any class outside the fighter's age group and gender. No weight is stored.
- The weigh-in (`recordWeighIn`) keeps only the result on the registration (`weigh_status`), never the weight, not even in the session or activity log. Moving class keeps the coach's choice in `entered_weight_class_id` so undo can restore it. Keeping an off-weight athlete in their class is allowed only when their last check found them lighter. No-shows and disqualified athletes aren't drawn. The weigh-in also runs after the draw: then nobody moves class (or back, on undo), and `applyWalkovers` gives the opponent of anyone no-show or disqualified a walkover (`bouts.walkover`), repeating as winners move on, so the results route calls it after every result. Undoing that weigh-in clears their opponents' walkovers, and is refused if a later result depends on one. Walkovers can't be changed or undone from the results pages, clearing all results keeps them, and a walkover loss earns no medal. With both athletes out, the bout is a no contest (`bouts.no_contest`): decided with no winner, so the athlete waiting in the next bout gets the walkover (a side fed by a no contest counts as out), and a walkover whose winner turns out to be out too is turned into a no contest. Results also keep how the bout was won (`bouts.win_type`, a `WIN_TYPES` code from `bracket.js`) and its `score` (`readBoutScore`), both optional.
- Results move winners by filling the next bout's blue or red slot, so a result can't change once the next bout has one. Redraw and delete are blocked while results exist.
- Email links use `PUBLIC_URL`, never the request's Host header. Reset tokens are stored only as hashes.
- Belts are fixed to Blue, Red and Black (ranks 1 to 3), and every competition's belt groups match.
- Bouts reference approved registrations, so approvals and reopening are blocked while a bout list exists. Keep that rule, or the draw and foreign keys can break.
- Roles are `admin`, `coach` and `official`. `requireRole` takes one role or a list. Officials only reach `competitionDay` routes (weigh-in and results of closed competitions), `/official` and court screens; everything else under `/admin` stays `requireRole('admin')`, so new admin routes are admin-only by default. Clearing all results stays admin-only.
- Manual bracket changes (`swapAthletes`, `withdrawAthlete`, `reinstateAthlete`, `redrawDivision`) work on one division and are refused once it has a result. A withdrawn registration keeps `status = 'approved'` but has `withdrawn_at`, and `DRAWN` leaves it out of every draw.
- `closeExpiredCompetitions` runs on each request, so `status` flips to closed once the deadline passes, in the server's `TZ`. Reopening requires a later deadline.
- Public pages show rules, plus the bout lists once an admin publishes them (`/competitions/:id/bouts`, one running order for both events built by `competitionProgramme`, with `?event=` and `?club=mine` filters shared with `/competitions/:id/results`, and `bouts.pdf`; the old `/competitions/:id/poomsae` addresses redirect to it): athlete names, clubs, draws, times and results only. Never put any other fighter data on public pages (ages, birth dates, documents, weigh-in results, contact details), because many fighters are minors. Poomsae publishes in two stages: `poomsae_published_at` (performance lists) and `poomsae_brackets_published_at` (brackets), filtered by `poomsaeBoutList(..., { published: true })`. News posts marked for coaches and organisers return 404 to visitors, and club icons are only served to logged-in users.
- A competition can't open for registration (publish or reopen) without a logo and a description. Logos are in `competition_logos` and attachments in `competition_files`, both BLOBs. They follow the competition's visibility: drafts are admin-only. Attachments are always sent as downloads.
- News bodies are plain text: never render them unescaped. `formatBody` splits them into escaped pieces and http(s) links.
- Poomsae entries live in `poomsae_entries` (event, gender `M`/`F`/`X` for mixed, age group from `poomsae_age_groups` (poomsae's own brackets, default `DEFAULT_POOMSAE_AGE_GROUPS`, saved with `savePoomsaeAgeGroups`) and belt group stored at entry time, `score`) with athletes in `poomsae_members`. A pair or team is placed by its oldest athlete and highest belt; each athlete is in at most one non-rejected entry per event. `countRegistrations`, `hasActiveRegistration`, `hasApprovedRegistration` and `hasEntryHistory` count both kinds, so locks and athlete edits cover poomsae too. Approvals (`/admin/competitions/:id/poomsae/review`) are admin-only; scores are in `competitionDay`, for closed competitions only. A scored entry, or one in a division with a bracket, can't be reviewed, and reopening is blocked while poomsae scores or brackets exist (`hasPoomsaeResults`).
- Poomsae formats: `competitions.poomsae_format` is `score`, `elimination` or `cut` (a score round when a division has more than `poomsae_cut` approved entries, then a bracket seeded by rank). `divisionMode` and `bracketEntrants` in `src/poomsae.js` decide each division. Brackets are `poomsae_bouts` (one per `division_key`, event-gender-age-belt), drawn with the kyorugi `bracket.js` functions; sides use the entry id as `registrationId` so `layoutBracket` and `divisionMedalists` work unchanged. Drawing is admin-only; recording winners (`recordPoomsaeBout`) is in `competitionDay` for admins and officials. A drawn bracket locks its division's scores and approvals, and is deleted only while it has no results.
- `poomsae_divisions` holds a division's own `format`, `cut` and `day` (NULL keeps the competition's, or any day); `divisionRules` merges them, so always pass `loadPoomsaeSettings` to `poomsaeDivisions`. Format and cut stay once the division has scores or a bracket. `applyPoomsaeSchedule` gives every bracket its day, court (`competitions.poomsae_courts`, separate from kyorugi courts), number and time with `schedulePoomsae`, in draw order (bout id), so it's prefix-stable; draw, delete, schedule and division saves all call it.
- Poomsae performance orders: `poomsae_entries.perform_order` and `perform_time`, made at random by `generatePoomsaeOrder` for ranked divisions and score rounds, only while the division has no scores. Lists and brackets are scheduled together by `poomsae_divisions.list_seq` / `bracket_seq` (the order they were made). `poomsaeBoutList` builds the published pages (lists and brackets in running order) for the web pages and `writeBoutListPdf`, which draws a page with `performers` as a list. Coaches see them, and their PDF, only while `competitions.poomsae_published_at` is set. Entries in a list can't be reviewed, and lists count in `hasPoomsaeResults`.
- Poomsae judges' phones: a judge logs in with an official account and opens `/admin/competitions/:id/poomsae/judge/:day/:court/:judge` (in `competitionDay`, so admins and officials only; the poomsae mat page links each judge number). It shows the performer on now, live through the poomsae court's event stream; `submitJudgeMark` keeps each mark in `poomsae_judge_scores` and saves the score once every judge has sent one. Live pages hold their update while someone is typing in them (public/app.js).
- Poomsae judges: `competitions.poomsae_judges` (1, 3, 5 or 7; fixed once poomsae has scores). With more than one, the score route takes `judge_1`…`judge_N` (all filled, or all blank to clear), keeps them in `poomsae_judge_scores`, and stores `judgesScore` (five or more drop the highest and lowest) as the entry's `score`, so ranking, brackets and medals only ever read `score`.
- Poomsae on competition day: `poomsaeCourtItems` / `poomsaeCourtQueue` put each poomsae court's performers and bracket bouts in time order. The court screen is `/screens/:id/poomsae/:day/:court` (with its own event stream) and the mat page `/admin/competitions/:id/poomsae/mat/:day/:court`, which posts to the usual score and bout routes with `back=mat`. Coaches see a poomsae screen only for published stages.
- Final results: `competitionResults` gives every decided division's medallists and one club medal table for kyorugi and poomsae together. `/competitions/:id/results` shows what's published to visitors and coaches, and everything to admins and officials.
- `competitions.max_per_club_division` (NULL: no limit) caps a club's non-rejected entries per division. Only `enterFighter` and `enterPoomsae` (coach entries) check it; admin moves at weigh-in or merges deliberately don't.
- `mergeDivision` moves a lone division's active entries into another division of the same gender (checked with `realDivision`), keeping the old division key in `registrations.merged_from` for `unmergeRegistration`. Blocked while a bout list exists; a merged entry's weigh-in reset is refused, because it would restore the weight class without the age group.
- Deleting: `deleteCompetition` removes bouts, then division days, then registrations, then the competition, because those reference each other without cascades. Competitions with entries can only be deleted once closed, with the name typed and a backup made first (the delete is refused if the backup fails). `deleteCoachAccount` removes only coaches: their club keeps its athletes and entries. Admin accounts can't be deleted from the site.
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
