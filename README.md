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

## How divisions work

Each competition has its own division setup, under **Division setup** in the admin dashboard. New competitions start from a default template:

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

**Activity log** on the admin dashboard shows who did what and when, and can be filtered by type and competition or exported as CSV. It covers registrations and their rejection reasons, competitions, division setup, draws, schedules, publishing, results, clubs, coach approvals, athletes, document uploads, new accounts and password resets, plus competitions closing at their deadline. Logins and views aren't recorded. Entries can't be edited or deleted from the site. Anyone with direct access to the database could still change them.

## Email and password reset

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` to send email through any provider that offers SMTP, and `PUBLIC_URL` to the site's address. Without `SMTP_HOST` no email is sent, so password reset won't work. In development, messages are printed to the console instead.

The site emails people about:

- **Password reset:** a link that works once and expires in 1 hour.
- **Coach applications:** admins hear about new ones, and coaches hear the decision or if they're removed.
- **Registration decisions:** each club gets one summary per review action, with rejection reasons.
- **Deadline reminders:** every approved coach gets one when a deadline is within 3 days. Moving the deadline allows another.
- **Bout lists:** coaches with athletes in the draw hear when it's published.

If a message fails to send, the error is logged and the page carries on, so check the server log if emails aren't arriving.

## Registration deadlines

Each competition has a deadline date and closing time, set by the admin and shown to coaches with the time left. Registration closes by itself when the time passes, using the server's time zone (`TZ`). To reopen it, edit the competition to set a later deadline, then click **Reopen registration**.

## Bout lists

After closing registration, open **Bout list** on the admin dashboard, enter the courts, start time and minutes per bout, and generate it. Bouts are spread across the competition's event dates, keeping divisions in age order.

- Each division becomes a single-elimination bracket of its approved fighters. Pending fighters are left out.
- Fighters from the same club are drawn into opposite halves, so two club-mates can only meet in the final. Clubs with more fighters are shared as evenly as possible.
- Fighters are placed at random into standard seed positions, so seed numbers show bracket position, not ranking. When a division isn't a full bracket (2, 4, 8, 16 and so on), the top seed positions get first-round byes.
- A fighter alone in a division is listed with no opponent. They get no bout number, court or time.
- Each division is assigned to one court. Bout numbers restart for each court on each day, and times follow from the start time and minutes per bout. The schedule doesn't allow for breaks or for fighters who are in several bouts.
- **Download PDF** exports one A4 page per division. **Update schedule** changes courts and times but keeps the draw. **Redraw** replaces the draw with a new random one.

**Publish to coaches** shows the list to coaches with athletes in it and emails them. They see a summary of each athlete's next bout, the brackets for their divisions, and a PDF of those divisions. Redrawing hides the list until it's published again.

**Record results** lists bouts by day and court. Click the winner and they move into their next bout. Results then appear on the brackets, the PDF and the coaches' pages, and build the medal standings: gold and silver from the final, and bronze for each losing semifinalist. A fighter alone in a division gets no medal and isn't counted. A result can only be undone or changed while the next bout has none. Clear all results before redrawing or deleting a list.

While a bout list exists, approvals can't change and registration can't reopen. Delete the list first, because any change to the fighters would make the draw wrong.

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
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Your email provider's SMTP details |
| `DATABASE_PATH` | A file on the volume, for example `/data/gms.sqlite` |
| `TZ` | Your time zone, for example `Asia/Manila`. Registration deadlines use it. |

The host must serve the site over HTTPS, because login cookies are HTTPS-only in production. The admin account is created on first start. The server refuses to start in production if a required setting is missing.

**Back up the database file regularly.** It holds personal data, including children's names and dates of birth, so check which data protection rules apply to you.

## Not included yet

- Weigh-in records.
- Non-Latin names in the PDF. It uses a standard font, so names in scripts such as Korean or Chinese won't print correctly.
- Poomsae.
