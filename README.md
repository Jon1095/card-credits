# card-credits

My personal tracker for statement credits on Chase Sapphire Reserve, Amex Gold and Bilt Palladium. It's a single static page hosted on GitHub Pages. Firebase handles sign-in and storage, and it works offline once you've signed in.

The app is `index.html`. Two small modules hold its logic: `calc.js` (the period and amount rules every total comes from) and `catalog.js` (the credit catalog, its migration and the review queue). `catalog-seed.js` is the original hardcoded credit list, used once to seed the catalog.

## One-time setup

Do these steps in order. Everything happens in the [Firebase console](https://console.firebase.google.com/) under the **card-credits** project, except step 6.

### 1. Turn on email/password sign-in

1. Go to **Build → Authentication**. Click **Get started** if you see it.
2. Open the **Sign-in method** tab and click **Email/Password**.
3. Turn on **Email/Password**. Leave "Email link (passwordless sign-in)" off. Click **Save**.

### 2. Create your account and copy your user ID

1. In **Authentication**, open the **Users** tab and click **Add user**.
2. Enter your email and a password, then click **Add user**.
3. Copy the **User UID** from your new row. It's a long string like `aB3dE...`. You need it in step 4.

### 3. Lock down sign-ups (recommended)

The app has no sign-up screen, but Firebase's API would still let anyone create an account. The rules in step 4 already keep other accounts out of your data. To also stop new accounts being created:

1. In **Authentication**, open the **Settings** tab and go to **User actions**.
2. Clear **Enable create (sign-up)** and click **Save**.

While you're in **Settings**, open **Authorized domains** and add `jon1095.github.io`.

### 4. Create the database and paste the security rules

1. Go to **Build → Firestore Database** and click **Create database**.
2. Pick a location near you (for example `nam5 (United States)`). You can't change the location later.
3. Choose **Start in production mode** and click **Create**.
4. Open the **Rules** tab, at the top of the Firestore Database page next to **Data**.
5. Delete everything in the editor and paste the contents of [`firestore.rules`](firestore.rules).
6. Replace every `YOUR_USER_ID` with the User UID from step 2 (it appears twice). Keep the quotes.
7. Click **Publish**.

These rules only let a signed-in user whose ID matches yours read or write, and only under `users/<your ID>`. Everything else is denied.

### 5. (Optional) Restrict the API key

The `apiKey` in `index.html` isn't a secret. Every Firebase web app ships one, and the security rules are what protect your data. If you want an extra layer, go to [Google Cloud console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=card-credits), open the **Browser key**, choose **Websites** under **Application restrictions**, and add `https://jon1095.github.io/*`.

### 6. Turn on GitHub Pages

1. In this repo on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Pick the **main** branch and the **/ (root)** folder, then click **Save**.
4. After a minute or two the app is live at **https://jon1095.github.io/card-credits/**.

### 7. Add it to your iPhone home screen

1. Open https://jon1095.github.io/card-credits/ in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Credits** from the home screen and sign in there. Home-screen apps keep their own storage, separate from Safari, so you need to sign in inside the app itself.

It opens full screen. After the first sign-in with signal, it keeps working with no signal. Check-offs made offline sync when you're back online.

### 8. Add the calendar reminders

On the **Cards** tab, tap **Download calendar file** and add the events. You get:

- An all-day reminder on the 25th of every month that lists your monthly credits, with an alert at 9 AM.
- Reminders on June 1 and December 1 that list the six-month credits, a month before they reset.

The event text lists whichever credits are turned on when you download the file. If you turn credits on or off later, delete the old Card Credits events and download a new file. On iPhone, if the file doesn't open from the home-screen app, tap the button once in Safari instead.

## How the data is stored

Everything is in Firestore under your user ID:

| Path | What's in it |
| --- | --- |
| `users/{uid}` | Settings (credits turned off, anniversary months, rent, Bilt Cash value), annual fees per card per year, the check-off log, and `schemaVersion: 2` |
| `users/{uid}/credits/{creditId}` | The credit catalog: one document per credit (see below) |
| `users/{uid}/proposals/{id}` | The review queue: proposed changes to credits, pending or decided |
| `users/{uid}/checkRuns/{runId}` | Reserved for the automated checker's results (not built yet) |
| `users/{uid}/snapshots/YYYY-MM` | Automatic monthly copy of everything above, made the first time the app opens each month |
| `users/{uid}/snapshots/before-import-…` | Copy saved automatically just before an import replaces your data |
| `users/{uid}/snapshots/pre-catalog-…` | Copy of the user document made once, just before the catalog migration |

Each check-off stores its own copy of what it was worth: `amt` (dollars used), `face` (the credit's full amount that period) and `card`. Past months and the Value tab read these stored numbers. If a credit's amount changes later, your history doesn't change.

Every change is also kept on the device (in localStorage) until the server confirms it, and re-sent each time the app starts. Firestore has its own offline queue, but on iPhone the SDK can shut itself down while the app is still open (see below). The device copy means a change can't be lost that way.

Annual fees are stored per year. The fee field on each card page sets this year's fee only. Each new year starts with last year's fee, which you can then change. Past years keep their own fee.

Bilt Cash is the one exception. The Value tab still counts it at the rate you choose on the Palladium page, as the prototype did, so changing that rate revalues past Bilt Cash too. The Bilt Cash dollar amounts themselves are stored with each check-off.

## Credit catalog

Each credit is a document in `users/{uid}/credits/{creditId}`. Its fields:

- **What it is:** `card`, `name`, `freq` (`month` | `half` | `year`), `resetOn` (`calendar` | `anniversary`), `valuation` (`dollars` | `biltCash`), `how`, `info[]` and `sortOrder`.
- **Amounts and dates:** `amounts: [{amount, from: "YYYY-MM-DD"}]`, oldest first; `activeFrom`; and `activeTo` (`null` while ongoing).
- **Upkeep:** `sourceUrl`, `lastVerified`, `changeNote` and `updatedAt`.

The IDs are the same as before, so every existing check-off still matches its credit.

The app reads credits only from Firestore, including the offline copy. Credits are never deleted, only ended by setting `activeTo`.

The rules, all in `calc.js`:

- A period counts toward "possible" if it overlaps the credit's active dates.
- A period's amount is the one in effect on the later of the period start and `activeFrom`. So a change dated mid-period applies from the next period.
- Yearly credits, including the anniversary ones, count once per calendar year, as before.
- Check-offs keep their own `amt` and `face`. Editing or ending a credit never changes a past check-off or a past year's totals.

`activeFrom: 2000-01-01` on the seeded credits means "before tracking started", so every past year's totals match the old app.

### Changing a credit: the review queue

Nothing changes a credit without your approval:

- **Edit:** in a credit's ⓘ sheet, **Edit** opens a form. **Add credit** on each card page adds a new one. Both send *proposals* to **Review changes**, at the top of the Cards tab, which shows a count when anything is waiting.
- **Review:** each item shows the credit, card, current vs proposed, effective date, source link and note, with **Approve** and **Reject**. Approving writes the change, the proposal's new status and an exact record of what was written (`applied`) in one batch. It also sets the credit's `lastVerified` and `sourceUrl` from the proposal. Rejecting only records the decision. Decided items go under **History**.
- **Out of date:** if a credit changed after a proposal was made, the proposal shows as out of date and can only be rejected.
- **Approve all:** approves pending *amount* changes only, after an on-page confirm.
- **Frequency or reset changes** end the old credit the day before and add a new one with a new ID (`<oldId>-YYYYMM`). Check-offs already logged keep their period keys. The two are reviewed and approved together, and the new credit keeps the old one's on/off switch.
- A new amount must be dated after the credit's latest amount entry.

The handlers that apply changes live in `catalog.js` (`HANDLERS`), one per domain. Only `credits` exists today; a later domain such as rewards only adds a handler.

### Verify

A credit needs checking when it hasn't been verified in 90 days. Its verified date is the later of `lastVerified` and the latest automated check run that matched it.

- Card pages show a **Verify** badge on those credits, and the Cards tab shows a count per card.
- A credit's ⓘ sheet shows its source link, verified date and last change note, with **Mark verified**.
- **Verify all** on a card page marks all of its credits verified today.

### Room for the automated checker

A later task adds a monthly checker. It will sign in as its own Firebase user, read the catalog, and write pending proposals (`createdBy: "bot"`) plus one `checkRuns` document per run:

```json
{ "startedAt": "…", "finishedAt": "…",
  "cards": { "gold": { "status": "couldnt_check", "reason": "page didn't load", "pages": [], "matched": [] } } }
```

`status` is `checked`, `couldnt_check` or `partial`. The review screen shows the latest run, one line per card, and "couldn't check" never shows as "no changes".

Its security rules are already in `firestore.rules`, commented out between `BOT START` and `BOT END`. Once enabled, the checker can:

- read your credits and nothing else;
- create, but never update or delete, pending bot proposals with a checked shape and size limits;
- create check runs.

## Rolling back

The catalog only *adds* data: the new collections, a pre-catalog snapshot, and `schemaVersion` on your user document. Nothing that the previous version uses was renamed, moved or removed.

1. **Revert** the pull request's merge commit on GitHub. The previous app ignores `credits`, `proposals` and `checkRuns` and keeps working with your check-offs and settings as they are.
2. **Restore, only if ever needed:** `users/{uid}/snapshots/pre-catalog-<timestamp>` is a full copy of your user document from just before the migration. Copy its fields back into `users/{uid}` in the Firestore console's **Data** tab.

If you later go forward again, the migration runs once more. It only creates credits that are missing and never overwrites existing ones.

## Tests

Install the dev tools once with `npm install`. They're only for the tests; the app itself has no build step.

| Command | What it runs | Needs |
| --- | --- | --- |
| `npm test` | Period and amount rules, parity with the old app's totals, the proposal handlers and the migration seed | Node 20+ |
| `npm run test:emulator` | Migration and security rules against the Firestore emulator | Java 21 (`brew install openjdk@21`) |
| `npm run test:e2e` | The real app in Chrome against the Auth and Firestore emulators: migration, Verify, review queue, end + add, Add credit, export/import, the old app on migrated data, reload-on-resume | Java 21 and Google Chrome (or set `CHROME_PATH`) |

The emulators run locally with a `demo-` project, so the tests cost nothing and never touch your real data. To run the migration and end-to-end tests on a copy of a real backup, set `BACKUP_FILE=/path/to/backup.json`. Never commit that file; `.gitignore` already excludes backup file names.

## Sync status

The header shows where your changes are:

- **Saved**: the server has everything.
- **Waiting to sync**: at least one change hasn't reached the server yet. With no signal it says **Offline · waiting to sync** and catches up when you're back online.
- **Connecting…** / **Offline**: nothing is waiting, but the app hasn't reached the server yet.

If a save fails, for example because the security rules reject it, a banner explains why and stays until you tap **Dismiss**. The change stays on the device and is sent again the next time the app opens.

### Why the app sometimes reloads when you come back to it

Firestore shuts itself down when the browser fires `pagehide`. On iPhone it also misreads every iPhone's user agent (`Mobile/15E148`) as Safari 14–16 and stops running any further work. A home-screen app can fire `pagehide` and then resume the same page. Before this fix, that left a Firestore that dropped writes without an error. Check-offs showed on the phone but never reached the server.

Now, if `pagehide` has fired, the app reloads the next time it's shown. It comes back on the same tab, month and scroll position, and the device copy re-sends anything that was waiting.

## Backups

- **Export backup** on the Cards tab downloads a JSON file with all your settings, check-offs, the credit catalog and the review queue. Older backups without the catalog still import.
- **Import backup** gives you two choices:
  - **Add missing check-offs** adds only the check-offs, credits and proposals the app doesn't already have. It keeps everything else, including your settings. Use this to bring in check-offs from another device.
  - **Replace everything** swaps your settings and check-offs for the backup, and writes the backup's credits and proposals over yours with the same IDs. No credit is ever deleted. It saves a copy of your current data first.
- Monthly snapshots happen automatically. To restore one, open it in the Firestore console's **Data** tab and copy its fields back into `users/{uid}`.

## Making changes

- Credits are changed in the app, through **Edit** / **Add credit** and the review queue, not in code. `catalog-seed.js` is only used to seed a new account.
- Card details, earn rates and perks still live at the top of the `<script>` in `index.html` (`CARDS`, `GUIDE`).
- `sw.js` caches the app for offline use. The page and its own scripts (`calc.js`, `catalog.js`, …) are always fetched fresh when there's signal, so updates show up together on the next open. If you add new files or change the Firebase SDK version, update the `PRECACHE` list and bump `VERSION` in `sw.js`.
- To test locally, run `python3 -m http.server` in this folder and open http://localhost:8000. Firebase allows `localhost` by default.
