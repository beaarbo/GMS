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
- **Map location** on the competition form (optional) puts the venue on a small Google map on the competition page, with an **Open in Google Maps** link. Type the address or place name, or paste a full Google Maps link from a computer's address bar; short share links (maps.app.goo.gl) don't work, so type the address instead. No Google API key is needed.

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
- **News:** every coach, when the admin ticks **Email this post to every coach** while publishing or editing a post.
- **Division moves:** an athlete's coaches, when the admin moves them into another division.

If a message fails to send, the error is logged and the page carries on. To find out why emails aren't arriving, open **Email** in the admin menu: it shows the current settings (never the password) and sends a test email, showing the mail server's answer and what to change. For Gmail, use an App Password rather than your normal password, with `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=587`.

## Registration deadlines

Each competition has a deadline date and closing time, set by the admin and shown to coaches with the time left. Registration closes by itself when the time passes, using the server's time zone (`TZ`). To reopen it, edit the competition to set a later deadline, then click **Reopen registration**.

## Club limit per division

**Most athletes from one club per division**, on the competition form, caps how many entries one club can have in a single division (gender, age, belt and weight). Blank means no limit. Coaches see the rule on the competition page and their entry page, and an entry over the limit is refused with the reason. Rejected entries don't count, so rejecting one frees a place. Lowering the limit keeps entries already made, and the admin's own moves (weigh-in, merging divisions) aren't limited.

## Merging small divisions

**Divisions** flags any division with no opponent. Each one offers **Move to**, a list of other divisions of the same gender that have entries, with the closest fit first: the same age and belt groups in the next heavier weight class, then the next lighter, then the nearest age or belt group. Moving updates the athletes' entries, emails their coaches, and shows "moved here from…" with **Undo move**. Like approvals, moves are blocked once a bout list exists. A moved athlete's weigh-in can't be undone until the move is.

## Bout lists

After closing registration, open **Bout list** on the competition's card on the admin **Competitions** page, enter the courts, start time and minutes per bout, and generate it. Bouts are spread across the competition's event dates, keeping divisions in age order.

- Each division becomes a single-elimination bracket of its approved fighters. Pending fighters are left out.
- Fighters from the same club are drawn into opposite halves, so two club-mates can only meet in the final. Clubs with more fighters are shared as evenly as possible.
- Fighters are placed at random into standard seed positions, so seed numbers show bracket position, not ranking. When a division isn't a full bracket (2, 4, 8, 16 and so on), the top seed positions get first-round byes.
- A fighter alone in a division is listed with no opponent. They get no bout number, court or time.
- Each division is assigned to one court. Bout numbers restart for each court on each day, and times follow from the start time and minutes per bout. A minimum rest between an athlete's bouts can be set: while a winner rests, the court runs bouts from other divisions. On multi-day events, divisions can be pinned to a day under **Division days**.
- **Download PDF** exports one A4 page per division. **Update schedule** changes courts and times but keeps the draw. **Redraw** replaces the draw with a new random one.

**Publish bout list** makes the list public: anyone, without an account, can see every division's bracket at `/competitions/:id/bouts` (linked from the competition page) and download the PDF. Coaches with athletes in it are emailed, and see a summary of each athlete's next bout, the brackets for their divisions, and a PDF of those divisions. Public pages show names, clubs, draws, times and results only, never ages, birth dates or documents. Redrawing hides the list until it's published again.

**Record results** lists bouts by day and court. Click the winner and they move into their next bout. Results then appear on the brackets, the PDF and the coaches' pages, and build the medal standings: gold and silver from the final, and bronze for each losing semifinalist. A fighter alone in a division gets no medal and isn't counted. A result can only be undone or changed while the next bout has none. Clear all results before redrawing or deleting a list.

While a bout list exists, approvals can't change and registration can't reopen. Delete the list first, because any change to the fighters would make the draw wrong.

**Change this division**, under each bracket, edits one division without redrawing the rest, as long as it has no results yet:

- **Swap** two athletes' places in the first round.
- **Withdraw** an athlete, for example after an injury, with an optional reason that their coach sees. Their first opponent gets a bye. If the athlete had the bye themselves, the division is laid out again in seed order. Withdrawn athletes stay out of later redraws.
- **Reinstate** a withdrawn athlete from the list above the brackets. Their division is redrawn to include them.
- **Redraw this division** makes a new random draw for that division only.

## Phones

Visitors without an account see one page: the upcoming competitions, the latest five public news posts below them (**All news** opens the rest), then **Past competitions**, one line each, newest first, with a **Results** button once results are published. A competition moves to Past the day after its last day. Their top bar has just a **Log in** button, and the login page has **Log in** and **Sign up** tabs (Sign up only while coach sign-up is on in Settings).

Logged in, on small screens the menu folds behind a **Menu** button, so the pinned top bar stays short. Without JavaScript the full menu shows instead.

## Dark theme

The site follows the device's light or dark setting. Logged-in people can choose **Auto** (follow the device), **Light** or **Dark** on **My account → Theme**; it applies at once and is kept with the account, so every device follows, and the browser keeps using it after logging out. Court screens always stay dark, and printed pages are always light.

## Settings

**Settings** in the admin menu changes the site without a redeploy:

- **Organisation:** the site name (top bar, browser tab, emails), a contact email and footer text, an organiser logo for the top bar, the time zone deadlines close in, and the name emails are sent as (the address stays `MAIL_FROM`'s).
- **Registration:** whether coaches can sign up themselves (when off, add them on **Accounts → Add a coach**, optionally straight into a club), whether athletes need a belt document, which file types it can be, and how many days before a deadline coaches are reminded.
- **Privacy:** athlete names for visitors without an account (full, or one name and initials, as in "Rossi A."), whether club icons show to visitors, deleting athlete documents after a number of days (checked hourly; an athlete still entered in a coming or recent competition keeps theirs), and requiring two-step login for admins.
- **Backups:** how many daily and manual backups to keep, and an address each daily backup is emailed to (up to 7 MB), so a copy survives losing the server's disk. **Check now** sends the newest one straight away.
- **Competition defaults:** the age groups and weight classes, poomsae age groups, schedule, poomsae format, judges, club limit and age rule each new competition starts with. Existing competitions keep their own.

Email keys, passwords and the session secret stay environment variables.

## My account

Everyone can change their name, email, password and theme, and choose which emails they get (decisions, reminders, published lists, division changes, news; admins: coach applications). Security emails always come.

**Two-step login** asks for a six-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others) after the password. Setting it up shows a key to type into the app, then ten one-time recovery codes, shown once. Someone who lost their phone and codes can ask an admin, who can turn it off for them on **Accounts**.

## Downloads and athlete cards

- **All entries (Excel)**, on a competition's Registrations page: every kyorugi registration and poomsae entry with club, date of birth, age, belt, division, status and weigh-in result, for insurers and federations. Admin-only, and each download is logged, since it holds minors' details. **Export approved (CSV)** stays for the approved kyorugi list.
- **Download list (Excel)** on the Weigh-in page and **Download results (Excel)** on the Results page (medallists and the club medal table), for admins and officials.
- **Athlete cards (PDF)**, on the Registrations page: ten cards to an A4 page, one per approved athlete, with their photo (or a plain placeholder), name, club with its country code, divisions and a QR code. Add `?club=<id>` to the address for one club's cards. Scanning a code opens the athlete's page for logged-in admins and officials (after logging in if needed): their weigh-in result with a button that opens them in the weigh-in, their bouts with court, time, opponent and result, and their poomsae entries. The code holds only a link, no personal data, and visitors who scan it get the login page.

## Athlete photos

Coaches can add a photo of each athlete from the club dashboard (**Add photo**, or click the athlete's name): JPG or PNG, up to 1 MB. WebP isn't accepted because the card PDF can't print it. Photos are optional; athletes without one show a plain person icon. The photo shows on the club's athlete list, the weigh-in list, the officials' athlete page and the printed athlete card. Only the club, admins and officials can see it, and officials only for athletes entered in that competition. It never appears on public pages.

## Admins and sub-admins

The first admin (the one made from `ADMIN_EMAIL` when the site first starts) is the **main admin**. Only they can add or remove other admins, on **Accounts → Add an admin**: enter a name and email, and the site emails that person a one-time password. When they first log in, they must choose their own password before they can use anything else.

Sub-admins can do everything else an admin can, except: add or remove admins, remove the main admin, turn off the main admin's two-step login, download backups, or change the security settings (requiring two-step login for admins, and the off-site backup address). The main admin can remove a sub-admin at any time; they're logged out at once. Sending the invite needs email set up on the live site.

## Competition photos

Each competition can show up to 10 photos on its page, such as the venue or last year's event. Add them on the new-competition form or later on **Logo and files** (several at once; JPG, PNG or WebP, up to 5 MB each), and remove them there. Each opens full size when clicked. Photos follow the competition's visibility: a draft's are seen only by admins, and once published anyone can see them.

## Link previews

A competition's link pasted into WhatsApp, Facebook, Telegram and similar apps shows a preview with its logo, name, dates, venue and, while entries are open, the deadline. Other pages show the site's name, footer text and organiser logo. The links in previews use `PUBLIC_URL`. Apps keep a preview for a while, so a changed logo can take time to show.

## Club countries

Each club can have a country, set on **Clubs and coaches** (chosen from a list). Its athletes then show the country's three-letter code before the club, as in **SGP · Tigers Taekwondo Club** or **MAS · Dragons Martial Arts**, on the bout lists and their PDF, brackets, court screens, results, the medal table and athlete cards. A club without a country shows its name alone.

## Deleting things

- **Competitions:** an empty draft has a **Delete** button on the admin **Competitions** page. A competition with entries can be deleted once registration is closed: **Delete** opens a page listing what will go (registrations, bouts, results, files), and you type its name to confirm. A backup is made first, so it can be restored. Athletes stay with their clubs.
- **News posts:** **Delete** on Admin → News.
- **Accounts:** on **Accounts**, coaches can be deleted (their club keeps its athletes and entries) and officials removed. Admin accounts can't be deleted.
- **Clubs** with no coaches or athletes, and **athletes** never entered in a competition, can also be deleted.

## Competition day

**Weigh-in**, on a closed competition, checks each approved athlete against the weight class their coach chose. Athletes over their class are moved up or disqualified, athletes under it can stay or move down, and no-shows are marked. Only the result is kept, not the weight. No-shows and disqualified athletes are left out of the draw.

The bout list can also be drawn before the weigh-in. Then the weigh-in still runs, but athletes stay in their weight class: one over their class, or under it and not kept in it, is disqualified (**Disqualify: walkover**). A no-show or disqualified athlete's opponent wins their bout by walkover and moves on. If the athlete had a bye, their next opponent gets the walkover as soon as they are known. Walkovers show as "W.O." on the brackets, PDF and results, can only be taken back by undoing that athlete's weigh-in, and the loser gets no medal.

**Officials** are accounts an admin adds on the **Accounts** page, with a starting password the official can change. They see **Competition day**, where they can run the weigh-in, record results and open court screens for closed competitions. They can't approve entries, draw bout lists, change settings or manage accounts.

**Poomsae.** When creating a competition, choose its **Events**: kyorugi, poomsae, or both (fixed once clubs have entered). Poomsae has individual, pair (2) and team (3) events, divided by age group and then belt group (boys and girls apart), with no weight. Poomsae has its own age groups in **Division setup**, separate from kyorugi's. They start as the World Taekwondo poomsae brackets: Kids (U12), Cadet (U15), Junior (U18), Senior (U30), U40, U50, U60, U65 and Over 65, and you can edit them until clubs enter. Pairs and teams of boys and girls together are mixed, and are placed by their oldest athlete and highest belt. Coaches enter from **Poomsae entries** on the competition, and each athlete can be in one entry per event. Admins approve entries on **Review poomsae**; once registration closes, admins and officials enter each entry's final score (0–10, such as 7.85) on **Poomsae scores**, and places follow, with equal scores sharing a place. A scored entry can't be re-reviewed, and the competition can't reopen while scores exist. Coaches see their own entries' places and scores.

**Poomsae formats.** Each competition picks a **Poomsae format**: **Ranked by score** (highest scores take the medals), **Single elimination** (entries face each other in a bracket, drawn at random with clubs kept apart), or **Score round, then single elimination**. In the last, a division with more entries than **Top entries into the bracket** (16 by default) is scored first, and the top ones go into a bracket seeded by rank, so 1st meets the lowest seed; smaller divisions go straight to the bracket. The admin draws each bracket on **Poomsae scores** (or all ready ones at once) after every entry is scored and nobody ties on the cut line. Admins and officials then click each bout's winner, who moves on, as in kyorugi. A drawn bracket locks that division's scores and approvals, and can be deleted and redrawn until it has a result. Brackets give gold and silver from the final and bronze to both losing semifinalists; ranked divisions give 1st, 2nd and 3rd. The format is fixed once poomsae has scores or brackets.

The competition's format is the default. On **Poomsae scores**, each division can choose its own **Format**, **Top into the bracket** and **Day**, so for example individuals can run a score round while teams are ranked by score. A division's format is fixed once it has scores or a bracket, but its day can change any time. The **Poomsae schedule** card sets the poomsae courts (Poomsae court 1 and up), the start time, the minutes per bout and the rest between an entry's bouts. Each bracket is timed when it's drawn: it goes after the brackets already on the court that's free soonest, on its chosen day or the day with the least poomsae, so later draws never move times already given out. Saving the schedule, or changing a division's day, times every bracket again. Times show on the bracket and in the bout list, and coaches see their division's day, court and start.

**Poomsae performance order.** Ranked divisions and score rounds get a random order for who performs first. After registration closes, click **Make N performance lists** (or **Make performance list** on one division). Each list is timed on the poomsae courts with the brackets, one slot per performer, so each entry gets a start time. A list can be redrawn or cleared until the division has a score, and its entries can't be rejected while they're in it. Poomsae publishes in two stages, each with its own button: **Publish performance order** (the first draw, as soon as the lists are made) and, once brackets are drawn after the score rounds, **Publish brackets**. Each stage becomes public on the bout list (see below) and emails coaches with entries; brackets drawn after their stage is published show straight away. **Hide performance order** and **Hide brackets** take each stage down. Coaches also see their own divisions on their poomsae page. **Download PDF** on the admin page gives every list and bracket, published or not.

**Poomsae judges.** Set **Judges** on the Poomsae schedule card: 1 (the official enters the final score), 3, 5 or 7. With more than one, each performance gets a box per judge. All must be filled, and the site works out the score: with 5 or more judges the highest and lowest marks are dropped, then the rest are averaged. The marks are kept and shown with the result. The number of judges is fixed once poomsae has scores.

**Poomsae courts on competition day.** The court screens list (**Court screens**) includes each poomsae court. Its screen shows who is performing now (or the bout on now), what's next and recent scores, live. **Record results** opens the poomsae mat page for a tablet: score boxes for the performer on now, or **Blue wins** and **Red wins** for a bracket bout, then the next one comes up. Coaches can open poomsae screens once the stage is published.

**Results and medals** (`/competitions/:id/results`, on the competition page) lists every division's gold, silver and bronze, with one club medal table for kyorugi and poomsae together. Visitors and coaches see the events you've published; admins and officials see everything, from **Overall results** on the results and poomsae pages.

**The bout list** (`/competitions/:id/bouts`, **Bout list** on the competition page) is one page for everyone, with or without an account, showing kyorugi and poomsae together. It starts with the running order (each day, court by court: kyorugi courts, then poomsae courts, by start time), linking down to each division's bracket, performance order or poomsae bracket. Only what you've published appears. The same bar on the bout list and on **Results and medals** switches between **Both events**, **Kyorugi** and **Poomsae**, and for a logged-in coach between **All clubs** and **My club**. **Download PDF** gives the same pages with the same filters. Old links to the separate poomsae page still work and open the bout list filtered to poomsae.

**Judges on their phones.** Each judge logs in on their phone with an official account (add them on **Accounts**), opens the poomsae court from **Court screens** (**Judge**) or the mat page, and taps **Score as judge 1**, **2** and so on. They see the performer on now with one big score box, and can change their mark until every judge has scored; then the score is worked out and saved, and the next performer comes up by itself. The mat page shows how many have scored and their marks so far, and an official can still type them in. Nobody can score without logging in, and the activity log shows which official gave each mark.

**How a bout was won.** On the results and mat pages, choosing **How** (World Taekwondo's codes: PTF points, PTG point gap, GDP golden point, SUP superiority, RSC referee stops contest, WDR withdrawal, PUN punitive declaration, DSQ disqualification) and the **Score** (such as 2-1) before tapping the winner is optional. They show with the result and on the court screen.

**No contest.** If both athletes in a bout are out at the weigh-in, the bout becomes a no contest with nobody going through, and the athlete waiting in the next bout gets a walkover. Undoing one of their weigh-ins takes it back.

**Results by mat** is a tablet page for one court on one day, opened with **Record results** on the court screens list or **Open mat view** on a filtered results page. It shows the bout on now with a large **Blue wins** and **Red wins** button, the next bouts, and the last result with **Undo**. It updates live when results come in from elsewhere, and uses the same rules as the results page. Admins and officials can use it.

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

The server saves a snapshot of the database once a day, in a `backups` folder next to the database file (on Railway, `/data/backups`). It keeps the newest 7 daily snapshots, plus the newest 10 made with **Back up now**, unless **Settings → Backups** says otherwise; it can also email each daily snapshot off-site. Each snapshot is checked before it's kept. Two optional settings change this:

| Variable | Value |
| --- | --- |
| `BACKUP_DIR` | Another folder for backups. Default: `backups` next to the database. |
| `BACKUP_KEEP_DAYS` | How many daily backups to keep until the Settings page sets it. Default: `7`. |

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
