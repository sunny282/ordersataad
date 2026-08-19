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

## 4. Add tabs to the spreadsheet for accounts, teams, and pending edits

Create these new tabs (bottom of the spreadsheet, "+"), named exactly:

**`Users`** — row 1 can be a header row (e.g. `username | password_hash |
team | full_name | active | created_at`) or left blank; the app manages the
data rows itself once you add technicians from the app's **Technicians**
panel, so you don't need to type anything in here manually.

**`Coordinators`** — same idea, filled in from the **Coordinators** panel
(admin only). Columns end up being `username | password_hash | teams |
full_name | active | created_at` — `teams` is a comma-separated list, since
one coordinator can be assigned more than one team.

**`Teams`** — a single column of team names, managed from the **Teams**
panel (admin only). This is the one place team names come from — both the
Technicians and Coordinators panels pick from this list instead of free
text, so nobody ends up assigned to a team name that doesn't really exist.
Add your teams here before adding technicians/coordinators.

**`PendingEdits`** — same idea: create the empty tab, the app fills it in.
Columns end up being `edit_id | order_id | tab_name | row_num | technician |
old_desc | new_desc | submitted_at | status | resolved_by | resolved_at |
admin_note | old_status | new_status | team`. `status` can be `pending`,
`approved`, `rejected`, or `auto-approved` (see **Manage Statuses** below).

**`StatusPermissions`** — you don't need to create this one yourself: the
app creates and seeds it automatically the first time you open **Manage
Statuses** (🔒) or a technician loads their orders. Columns end up being
`statusName | seqOrder | autoApprove | viewOnly`. This tab — not the sheet's
Status column dropdown — is what controls the technician workflow; see
below.

All four tabs listed above need to exist (even empty) before you use the
Technicians, Coordinators, Teams, or Pending Edits panels, or add a header
row to be safe. `StatusPermissions` is created for you.

## 4b. How the technician status workflow works

Technicians don't get a free-pick status dropdown. Instead, from an order's
current status they get exactly three choices, and a comment is required
on all of them:

- **Next status** — the next step in your fixed sequence (seeded as
  `SubContractor Assigned → Installation Scheduled → Work In Progress →
  Installation Tested and Completed → Completed`).
- **Problematic** — flags an issue (including cancellations); always held
  for approval unless you turn on Auto-approve for it.
- **Keep Current Status** — no status change, comment only.

They can never jump ahead, skip a step, or move backward. Manage this from
**Manage Statuses** (🔒, admin only):

- **Add a fixed status** — appended to the end of the sequence. This is a
  deliberate admin action; the app never turns a value it happens to see in
  the sheet's Status column into something technicians can select on its
  own.
- **Reorder** with the ↑/↓ arrows, or **remove a status from the sequence**
  (it stays configured, just no longer reachable as a "next" step).
- **Auto-approve** (per status) — a technician's submission into this status
  writes straight to the sheet instead of waiting in Pending Edits. It's
  still logged there with status `auto-approved` so you have a record.
- **View only** (per status) — orders currently in this status are
  completely locked for technicians: no comment, no status change.
- **Seen in the sheet but not configured** — statuses already sitting in
  the sheet's Status column that aren't in `StatusPermissions` yet. They
  still show up passively (on orders, in the dashboard) but aren't
  selectable by technicians until you tap **Add to sequence**.

Admins and coordinators are never restricted by any of this — their status
dropdown stays a free pick of any status, sequence or not.

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

## 8. Add teams, technicians, and coordinators (admin side)

Once signed in as admin, several new icons appear top-right:

- **🏷️ Teams** — add your team names here first. This is the only place
  team names come from — the Technicians and Coordinators panels both pick
  from this list.
- **👤 Technicians** — add a technician: pick a username and password, and
  their team from the dropdown. They can only see/edit orders whose Team
  cell matches. Deactivate anytime from the same list.
- **🧑‍💼 Coordinators** — add a coordinator: username, password, and one or
  more teams (checkboxes — a coordinator can oversee several teams). A
  coordinator gets an admin-like view scoped to just those teams: they can
  search and directly edit orders on their teams, and review Pending Edits
  and the Orders Dashboard for their teams only. They *cannot* manage
  technicians, coordinators, teams, or settings — only you can.
- **📝 Pending edits** — every description/status change a technician
  submits shows up here with the old and new values side by side.
  **Approve** writes it to the sheet for real; **Reject** discards it; you
  (or a coordinator, for their teams) can also edit the submitted values
  before approving. Both are logged with a name and a timestamp. The icon
  shows a badge with the pending count.
- **🔒 Manage Permissions** — restrict which statuses a team's technicians
  can choose from when submitting an update (e.g. limit a team to just 2-3
  statuses). Turn on "Restrict statuses for this team", pick the allowed
  ones, Save. Leave it off and that team's technicians can pick from the
  full standard list, same as before. This only ever affects technicians —
  coordinators and admin can always pick any status, even for a restricted
  team's orders.

The **Orders Dashboard** is no longer a separate button/drawer — it's
always visible on the home screen (top on phones, a sticky column on the
left on wider screens) for both admin and coordinators, scoped to whichever
teams they have access to. Tap any status row to expand the list of orders
in that status, with their team and a **Copy** button next to the order
number — handy for pasting into WhatsApp when asking a team for an update.

## 9. Technician sign-in

Give each technician the site URL, their username, and password. On the
sign-in screen they tap the **Technician** tab instead of Admin. They can
search orders on their team, view all fields, and pick one of three options
— next status, Problematic, or Keep Current Status — with a required
comment (see **4b** above for how the sequence works). Submissions that
aren't auto-approved show as pending until an admin or a coordinator for
their team reviews it. A "recent submissions" list on their screen shows
approved/rejected/auto-approved status and any note left.

## 9b. Coordinator sign-in

Give each coordinator the site URL, their username, and password. On the
sign-in screen they tap the **Coordinator** tab. Once in, it looks like a
scoped-down admin view: they can search and directly edit orders on their
assigned team(s) (no approval needed — that's the point of the role), and
use Pending Edits / Orders Dashboard, both automatically limited to their
teams.

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
