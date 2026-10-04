# card-credits

My personal tracker for statement credits on Chase Sapphire Reserve, Amex Gold and Bilt Palladium. It's a single static page hosted on GitHub Pages. Firebase handles sign-in and storage, and it works offline once you've signed in.

`prototype.html` is the approved design, kept for reference. The production app is `index.html`.

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
6. Replace `YOUR_USER_ID` with the User UID from step 2. Keep the quotes.
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
| `users/{uid}` | Settings (credits turned off, anniversary months, rent, Bilt Cash value), annual fees per card per year, and the check-off log |
| `users/{uid}/snapshots/YYYY-MM` | Automatic monthly copy, made the first time the app opens each month |
| `users/{uid}/snapshots/before-import-…` | Copy saved automatically just before an import replaces your data |

Each check-off stores its own copy of what it was worth: `amt` (dollars used), `face` (the credit's full amount that period) and `card`. Past months and the Value tab read these stored numbers. If you edit a credit's amount in `index.html` later, your history doesn't change.

Every change is also kept on the device (in localStorage) until the server confirms it, and re-sent each time the app starts. Firestore has its own offline queue, but on iPhone the SDK can shut itself down while the app is still open (see below). The device copy means a change can't be lost that way.

Annual fees are stored per year. The fee field on each card page sets this year's fee only. Each new year starts with last year's fee, which you can then change. Past years keep their own fee.

Bilt Cash is the one exception. The Value tab still counts it at the rate you choose on the Palladium page, as the prototype did, so changing that rate revalues past Bilt Cash too. The Bilt Cash dollar amounts themselves are stored with each check-off.

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

- **Export backup** on the Cards tab downloads a JSON file with all your settings and check-offs.
- **Import backup** gives you two choices:
  - **Add missing check-offs** adds only the check-offs the app doesn't already have. It keeps everything else, including your settings. Use this to bring in check-offs from another device.
  - **Replace everything** swaps all your data for the backup. It saves a copy of your current data first.
- Monthly snapshots happen automatically. To restore one, open it in the Firestore console's **Data** tab and copy its fields back into `users/{uid}`.

## Making changes

- Credits, earn rates and perks live at the top of the `<script>` in `index.html` (`CARDS`, `CREDITS`, `GUIDE`).
- `sw.js` caches the app for offline use. The page itself is always fetched fresh when there's signal, so edits to `index.html` show up on the next open. If you add new files or change the Firebase SDK version, update the `PRECACHE` list and bump `VERSION` in `sw.js`.
- To test locally, run `python3 -m http.server` in this folder and open http://localhost:8000. Firebase allows `localhost` by default.
