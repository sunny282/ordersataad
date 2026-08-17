# Order Update — installable PWA that edits your Google Sheet directly

A tiny web app: type just the order **number** (no need for the full ID),
and it searches **every tab** in your spreadsheet. If it turns up in more
than one tab, you pick which one to look at. Only the tab you designate as
**writable** (e.g. "Progress") can actually be saved — everything else opens
read-only, so you can't accidentally edit a historical/report tab.

There are two ways in:

- **Admin (you)** — sign in with Google, same as before: full direct access
  to search and edit any order.
- **Technician** — a username/password account *you* create, scoped to one
  team. Technicians can only see orders on their own team, can only edit the
  **Description** field (Status is view-only for them), and every edit they
  submit is held as a **pending change** until you approve or reject it in
  the **Pending edits** panel.

The admin side is still just static files talking directly to the Sheets
API — no backend needed there. The technician/approval side needs a small
serverless backend (a handful of Netlify Functions), because permission
checks and "hold this edit for approval" logic can't be trusted to code
running in someone else's browser — anyone can open dev tools and rewrite
client-side JavaScript. Both pieces deploy together to the same free Netlify
site, so setup is only slightly longer than before.

Your Client ID and Spreadsheet ID are already filled in as defaults in the
app (`app.js`) — you only need to set the **writable tab name** in Settings
before first use.

## 1. Create a Google OAuth Client ID (one-time, ~3 minutes)

This is for **your** admin sign-in (technicians don't need this).

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create
   a new project (or reuse one).
2. Go to **APIs & Services → Library**, search **Google Sheets API**, click
   **Enable**.
3. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External** (fine even for personal use).
   - Fill in app name, your email, save through the steps.
   - Under **Scopes**, add `.../auth/userinfo.email` (usually already listed
     under "non-sensitive scopes") — this lets the app record *your* email
     against edits you approve.
   - Under **Test users**, add your own Google account email. While the app
     is in "Testing" mode only test users can sign in — that's fine, it's just you.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: anything, e.g. "Order Update PWA".
   - Under **Authorized JavaScript origins**, add your Netlify URL once you
     have it, e.g. `https://your-app-name.netlify.app` (and
     `http://localhost:8888` if you want to test locally). You can edit this
     later after deploying.
   - Click **Create**. Copy the **Client ID** (looks like
     `123456-abc.apps.googleusercontent.com`).

## 2. Create a Google Service Account (for the technician/approval backend)

This is a *second*, separate credential — used only by the serverless
functions, never sent to anyone's browser. It's what lets technicians read
and (pending your approval) write to the sheet without ever holding direct
Sheets access themselves.

1. In the same Google Cloud project → **APIs & Services → Credentials →
   Create Credentials → Service account**. Give it any name (e.g.
   "order-update-backend"). No roles needed at the project level — click through.
2. Open the new service account → **Keys** tab → **Add Key → Create new key
   → JSON**. This downloads a `.json` file — keep it private, don't commit it
   to GitHub.
3. Open that JSON file and note two values: `client_email` and
   `private_key`.
4. Open your "Order Management" spreadsheet in Google Sheets → **Share** →
   add the `client_email` address (looks like
   `something@your-project.iam.gserviceaccount.com`) as an **Editor**. This
   is the only way the service account can reach the sheet — sharing, just
   like sharing with a person.

## 3. Find your Spreadsheet ID and tab name

Open your "Order Management" spreadsheet. The URL looks like:

```
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_IS_HERE/edit
```

Copy the long ID. Also note the exact name of the sheet **tab** you want the
app to search/update (bottom tab label, e.g. `Sheet1` or `ATD SDU Progress`)
— this is your **writable tab**, the only one technicians and admin can save to.

## 4. Add two tabs to the spreadsheet for technician accounts and pending edits

Create two new tabs (bottom of the spreadsheet, "+"), named exactly:

**`Users`** — row 1 can be a header row (e.g. `username | password_hash |
team | full_name | active | created_at`) or left blank; the app manages the
data rows itself once you add technicians from the app's **Technicians**
panel, so you don't need to type anything in here manually.

**`PendingEdits`** — same idea: create the empty tab, the app fills it in.
Columns end up being `edit_id | order_id | tab_name | row_num | technician |
old_desc | new_desc | submitted_at | status | resolved_by | resolved_at |
admin_note`.

Both tabs need to exist (even empty) before you use the Technicians or
Pending Edits panels, or add a header row to be safe.

## 5. Push this project to GitHub

```bash
git init
git add .
git commit -m "Order update PWA"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/order-update-app.git
git push -u origin main
```

The service account JSON file should **not** be committed — nothing in this
project needs the file itself, only the two values you'll paste into
Netlify's environment variables in the next step.

## 6. Deploy on Netlify

1. [netlify.com](https://netlify.com) → **Add new site → Import an existing
   project** → connect GitHub → pick this repo.
2. Build settings: leave the build command blank, publish directory `.`
   (this is a plain static site — `netlify.toml` already sets this and also
   points Netlify at the `netlify/functions` folder for the backend).
3. Before or after the first deploy, go to **Site configuration →
   Environment variables** and add:

   | Key | Value |
   |---|---|
   | `SHEET_ID` | Your spreadsheet ID (from step 3) |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | The `client_email` from step 2 |
   | `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | The `private_key` from step 2 — paste it as-is, including the `\n` sequences; Netlify's text box handles this fine |
   | `JWT_SECRET` | Any long random string (e.g. generate one with `openssl rand -hex 32`) — this signs technician login sessions |
   | `PROGRESS_TAB` | Your writable tab name, e.g. `Progress` — must match Settings in the app |
   | `COL_ORDER_ID` | Order ID column letter, default `B` |
   | `COL_STATUS` | Status column letter, default `H` |
   | `COL_DESC` | Description column letter, default `L` |

4. Deploy (or redeploy, if you added the env vars after the first deploy —
   Netlify Functions only pick up new env vars on a fresh deploy). Netlify
   gives you a URL like `https://your-app-name.netlify.app`.
5. Go back to Google Cloud Console → your **OAuth client** (not the service
   account) → add that exact URL under **Authorized JavaScript origins** (no
   trailing slash), save.

## 7. Configure the app (admin side)

1. Open your Netlify URL on your phone or laptop.
2. Tap the ⚙ settings icon. Client ID and Spreadsheet ID are already
   prefilled — just set:
   - **Writable tab** — the exact tab name that can be updated, e.g. `Progress`
     (same value as `PROGRESS_TAB` above).
   - Column letters for Order ID / Status / Description — defaults (`B`,
     `H`, `L`) match the standard order log layout and apply to every tab
     searched. Adjust if a tab's columns differ — and update the matching
     `COL_*` environment variables to keep them in sync.
3. Save settings, then on the **Admin** tab of the sign-in screen, **Sign in
   with Google** and approve access.
4. Type an order **number** (e.g. `02576395` — no need for the
   `OT-BEUC-R-ConnONT-` prefix). If it's found in one tab, it loads straight
   away; if found in several, pick which one from the list — tabs other than
   your writable tab open in **view-only** mode.
5. Edit status/description, **Save changes** — writes directly to that row
   in the writable tab. (This admin path is unchanged from before —
   direct writes, no approval needed for you.)

## 8. Add technicians and review their edits (admin side)

Once signed in as admin, two new icons appear top-right:

- **👤 Technicians** — add a technician: pick a username and password for
  them, and a **team name that exactly matches** the Team column (column A)
  values used in your writable tab. They can only see/edit orders whose
  Team cell matches. Deactivate anytime from the same list.
- **📝 Pending edits** — every description change a technician submits shows
  up here with the old and new text side by side. **Approve** writes it to
  the sheet for real; **Reject** discards it. Both are logged with your
  email and a timestamp. The icon shows a badge with the pending count.

## 9. Technician sign-in

Give each technician the site URL, their username, and password. On the
sign-in screen they tap the **Technician** tab instead of Admin. They can
search orders on their team, view all fields, edit the Description, and tap
**Submit for approval** — status shows as pending until you review it. A
"Your recent submissions" list on their screen shows approved/rejected
status and any note you leave.

## 10. Install on your phone (no APK needed)

- **Android (Chrome):** open the site → menu (⋮) → **Add to Home screen** /
  **Install app**.
- **iPhone (Safari):** open the site → Share icon → **Add to Home Screen**.

It'll open full-screen like a native app, with its own icon. Both admin and
technician logins work the same way once installed.

## Notes & limits

- Only you can sign in as admin while the OAuth consent screen is in
  "Testing" mode (that's expected and fine — no need to publish/verify the
  app for personal use). Technician accounts are unaffected by this since
  they don't use Google sign-in.
- The admin Google access token lasts about an hour; after that, tap
  **Sign in** again. Technician sessions last 12 hours.
- Admin search matches the order number as a **substring** of whatever's in
  the Order ID column, across every tab in the spreadsheet. Technician
  search is the same, but limited to their team's rows in the writable tab
  only.
- Only the tab named in Settings/`PROGRESS_TAB` as the **writable tab** can
  be saved to.
- Admin settings (Client ID, Sheet ID, writable tab, columns) are stored
  only in your browser's local storage. Technician credentials live in the
  `Users` tab (passwords are hashed, never stored in plain text) and their
  sessions are signed tokens stored in their browser's local storage.
- The service account can read/write the whole spreadsheet — team
  restriction for technicians is enforced by the serverless functions, not
  by spreadsheet permissions, so keep `JWT_SECRET` and the service account
  key private (Netlify environment variables only, never in the repo).
