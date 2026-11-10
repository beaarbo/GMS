# Game Management System

Registration management for taekwondo competitions, starting with kyorugi (sparring).

- **The admin (host)** creates clubs, approves coaches, posts competitions, sets the divisions and registration deadlines, approves or rejects each registration, and generates the bout list as a page and a PDF.
- **Coaches** create an account and apply to join a club. Once approved, they add the club's athletes and register them for posted competitions.
- **The system** places each fighter in a division by gender, age, belt and weight, and closes registration at the deadline.

Fighters belong to the club, not the coach, so a club keeps its athletes if a coach is removed. A club can have several coaches, and a coach belongs to one club.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm start
```

Open http://localhost:3000. The seed step creates a demo competition, clubs and fighters. The demo logins are listed at the top of `scripts/seed.js`.

To run the tests:

```bash
npm test
```

## The admin side

- **Dashboard** is an overview: a **Needs attention** list (coach applications and registrations to review, competitions ready to draw or publish, drafts missing a logo or description, email or backup problems), totals for competitions, clubs, athletes, officials and news, what's coming up, recent activity and the latest news.
- **Competitions** is where competitions are created and run: **New competition**, and a card per competition with its registrations, divisions, weigh-in, bout list, results, settings, files and delete. The public list of competitions is still at the site's home page.

## How divisions work

Each competition has its own division setup, under **Division setup** on the admin **Competitions** page. New competitions start from a default template:

| Setting | Default | Check before use |
| --- | --- | --- |
| Cadet, Junior, Senior weight classes | World Taekwondo classes | Confirm against your event's rules |
| Kids weight classes | Placeholder values | Replace with your local rules |
| Belt groups | Blue Belt, Red Belt, Black Belt | Fixed for every competition, and the only belts clubs can select |
| Senior age range | 18 and over | World Taekwondo allows 17, but groups here can't overlap |
| Age calculation | Competition year minus birth year | Can be changed to exact age on the event date |

Weight limits are inclusive: `-45` means up to and including 45 kg, and `+78` is the open class above 78 kg.

Division setup locks once any fighter is registered, as do the event date and age rule. This keeps existing placements correct.

## Event dates

A competition can run on any list of dates, up to 14, so two separate weekends works. Pages show them together, such as "6-7 & 13-14 Feb 2027". Ages are calculated from the first day, and the registration deadline must be on or before it. Once athletes are registered, the first day is locked, but later days can still be added or removed.

## Registering athletes

Coaches tick each athlete and choose a weight class from a list. The list only shows classes for that athlete's age group and gender, and the system works out their age and belt division. No weight is recorded and there is no weigh-in check, so the host needs to verify weights at the event.

An athlete can't be entered until their belt document is uploaded: a **grading card** for Blue and Red belts, or a **black belt certificate** for Black belts. Coaches upload a JPG, PNG, WebP or PDF of up to 5 MB from the athlete's page. Files are checked by their contents, not their name, and only the athlete's club and admins can view them. Admins open them from the registration review page.

Documents lock once a registration is approved. Changing a belt between Blue or Red and Black removes the old document, because the new belt needs a different one. Files are stored inside the database, so backing it up covers them too, but it will grow as documents are added. Check how long you should keep these files, especially for minors.

## Activity log

**Activity log** in the admin menu shows who did what and when, and can be filtered by type and competition or exported as CSV. It covers registrations and their rejection reasons, competitions, division setup, draws, schedules, publishing, results, clubs, coach approvals, athletes, document uploads, new accounts and password resets, plus competitions closing at their deadline. Logins and views aren't recorded. Entries can't be edited or deleted from the site. Anyone with direct access to the database could still change them.

## Email and password reset

Set `PUBLIC_URL` to the site's address, then set up email in one of two ways:

- **An email service over HTTPS (recommended on Railway).** Some hosts, Railway included on some plans, block outgoing SMTP, so emails fail with "Connection timeout". Set `BREVO_API_KEY` (from [Brevo](https://www.brevo.com), free for a few hundred emails a day) or `RESEND_API_KEY` (from [Resend](https://resend.com)), plus `MAIL_FROM`. Brevo can send from a single verified address, such as your Gmail; Resend needs a domain you own and have verified.
- **SMTP**, on hosts that allow it: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`. For Gmail, use an App Password with `smtp.gmail.com` and port 587.

An API key wins if both are set. Without either, no email is sent, so password reset won't work. In development, messages are printed to the console instead.

The site emails people about:

- **Password reset:** a link that works once and expires in 1 hour.
- **Coach applications:** admins hear about new ones, and coaches hear the decision or if they're removed.
- **Registration decisions:** each club gets one summary per review action, with rejection reasons.
- **Deadline reminders:** every approved coach gets one when a deadline is within 3 days. Moving the deadline allows another.
- **Bout lists:** coaches with athletes in the draw hear when it's published.

If a message fails to send, the error is logged and the page carries on. To find out why emails aren't arriving, open **Email** in the admin menu: it shows the current settings (never the password) and sends a test email, showing the mail server's answer and what to change. For Gmail, use an App Password rather than your normal password, with `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=587`.

## Registration deadlines

Each competition has a deadline date and closing time, set by the admin and shown to coaches with the time left. Registration closes by itself when the time passes, using the server's time zone (`TZ`). To reopen it, edit the competition to set a later deadline, then click **Reopen registration**.

## Bout lists

After closing registration, open **Bout list** on the competition's card on the admin **Competitions** page, enter the courts, start time and minutes per bout, and generate it. Bouts are spread across the competition's event dates, keeping divisions in age order.

- Each division becomes a single-elimination bracket of its approved fighters. Pending fighters are left out.
- Fighters from the same club are drawn into opposite halves, so two club-mates can only meet in the final. Clubs with more fighters are shared as evenly as possible.
- Fighters are placed at random into standard seed positions, so seed numbers show bracket position, not ranking. When a division isn't a full bracket (2, 4, 8, 16 and so on), the top seed positions get first-round byes.
- A fighter alone in a division is listed with no opponent. They get no bout number, court or time.
- Each division is assigned to one court. Bout numbers restart for each court on each day, and times follow from the start time and minutes per bout. A minimum rest between an athlete's bouts can be set: while a winner rests, the court runs bouts from other divisions. On multi-day events, divisions can be pinned to a day under **Division days**.
- **Download PDF** exports one A4 page per division. **Update schedule** changes courts and times but keeps the draw. **Redraw** replaces the draw with a new random one.

**Publish to coaches** shows the list to coaches with athletes in it and emails them. They see a summary of each athlete's next bout, the brackets for their divisions, and a PDF of those divisions. Redrawing hides the list until it's published again.

**Record results** lists bouts by day and court. Click the winner and they move into their next bout. Results then appear on the brackets, the PDF and the coaches' pages, and build the medal standings: gold and silver from the final, and bronze for each losing semifinalist. A fighter alone in a division gets no medal and isn't counted. A result can only be undone or changed while the next bout has none. Clear all results before redrawing or deleting a list.

While a bout list exists, approvals can't change and registration can't reopen. Delete the list first, because any change to the fighters would make the draw wrong.

**Change this division**, under each bracket, edits one division without redrawing the rest, as long as it has no results yet:

- **Swap** two athletes' places in the first round.
- **Withdraw** an athlete, for example after an injury, with an optional reason that their coach sees. Their first opponent gets a bye. If the athlete had the bye themselves, the division is laid out again in seed order. Withdrawn athletes stay out of later redraws.
- **Reinstate** a withdrawn athlete from the list above the brackets. Their division is redrawn to include them.
- **Redraw this division** makes a new random draw for that division only.

## Deleting things

- **Competitions:** an empty draft has a **Delete** button on the admin **Competitions** page. A competition with entries can be deleted once registration is closed: **Delete** opens a page listing what will go (registrations, bouts, results, files), and you type its name to confirm. A backup is made first, so it can be restored. Athletes stay with their clubs.
- **News posts:** **Delete** on Admin → News.
- **Accounts:** on **Accounts**, coaches can be deleted (their club keeps its athletes and entries) and officials removed. Admin accounts can't be deleted.
- **Clubs** with no coaches or athletes, and **athletes** never entered in a competition, can also be deleted.

## Competition day

**Weigh-in**, on a closed competition, checks each approved athlete against the weight class their coach chose. Athletes over their class are moved up or disqualified, athletes under it can stay or move down, and no-shows are marked. Only the result is kept, not the weight. No-shows and disqualified athletes are left out of the draw.

**Officials** are accounts an admin adds on the **Accounts** page, with a starting password the official can change. They see **Competition day**, where they can run the weigh-in, record results and open court screens for closed competitions. They can't approve entries, draw bout lists, change settings or manage accounts.

**Court screens** show one court on one day, for a TV or tablet at the mat: the bout on now with the blue and red athletes, the next three bouts and the latest results. They update live: the moment a result is recorded or a bracket or schedule changes, open screens swap in the new content, and a "Live" marker shows the connection is up. Without JavaScript they reload every 15 seconds instead. Admins and officials can open them once a bout list exists, and coaches once it's published. They need a login, because they show athletes' names.

## Deploy it

The app needs a host that runs a long-lived Node process **and** provides a persistent disk, because the database is a single SQLite file. Railway, Fly.io and Render (with a disk) all fit. Serverless hosts such as Vercel and Netlify do not, because their file systems are not persistent.

1. Put this folder in a Git repository and push it to GitHub.
2. Create a service from the repository. The included `Dockerfile` works on hosts that support Docker. Otherwise use the build command `npm ci --omit=dev` and the start command `node server.js`.
3. Attach a persistent volume, for example mounted at `/data`.
4. Set these environment variables:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | A random string of at least 32 characters (see `.env.example`) |
| `ADMIN_EMAIL` | Your admin login email |
| `ADMIN_PASSWORD` | A strong password of at least 10 characters |
| `PUBLIC_URL` | The site's address, for example `https://example.com`. Links in emails use it. |
| `BREVO_API_KEY` or `RESEND_API_KEY`, and `MAIL_FROM` | An email service's API key and the sender address (see "Email and password reset"). Or `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` where SMTP isn't blocked. |
| `DATABASE_PATH` | A file on the volume, for example `/data/gms.sqlite` |
| `TZ` | Your time zone, for example `Asia/Manila`. Registration deadlines use it. |

The host must serve the site over HTTPS, because login cookies are HTTPS-only in production. The server logs "Starting in production mode, behind a proxy" when `NODE_ENV` is right. On Railway it trusts the proxy's visitor address automatically, so rate limits apply per visitor; elsewhere set `TRUST_PROXY=1` if the site sits behind one. The admin account is created on first start. The server refuses to start in production if a required setting is missing.

The database holds personal data, including children's names and dates of birth, so check which data protection rules apply to you.

## Backups

The server saves a snapshot of the database once a day, in a `backups` folder next to the database file (on Railway, `/data/backups`). It keeps the newest 7 daily snapshots, plus the newest 10 made with **Back up now**. Each snapshot is checked before it's kept. Two optional settings change this:

| Variable | Value |
| --- | --- |
| `BACKUP_DIR` | Another folder for backups. Default: `backups` next to the database. |
| `BACKUP_KEEP_DAYS` | How many daily backups to keep. Default: `7`. |

Admins can make a backup and download any of them from **Backups** in the admin menu. Snapshots on the same disk don't survive losing that disk, so **download one regularly**, for example weekly and before each competition, and store it safely. A backup contains everyone's personal data and password hashes.

### Restore a backup

Restoring replaces the live database, so anything after the backup is lost.

1. On the Backups page, note the file name of the backup to restore, for example `gms-20270108-063000-daily.sqlite`.
2. Set the variable `RESTORE_BACKUP` to that name and redeploy (on Railway, adding a variable redeploys).
3. On start, the server saves the current database as a new backup first, then swaps in the one you named. Its log says what it did.
4. Remove `RESTORE_BACKUP`. It only restores once, so leaving it set does no harm, but it will log a reminder on each start.

This restores backups still in the backups folder. To restore a copy you downloaded, put it in that folder first, or replace the database file by hand while the service is stopped. To look inside a backup, copy it to `data/gms.sqlite` on your computer and run `npm start`.

## Not included yet

- Non-Latin names in the PDF. It uses a standard font, so names in scripts such as Korean or Chinese won't print correctly.
- Poomsae.
