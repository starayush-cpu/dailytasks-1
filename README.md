# Daily Hub

A personal daily schedule dashboard for Ayush (starayush) and anyone else
who uses it. Glass-design dashboard with a projects sidebar, a daily
schedule timeline, a calendar, a history view, and a Discord chat tracker.
Profile photo and project logos included. **Multi-user**: add more users
and switch between them — each user has their own projects, tasks and
chat counts.

## What it does

- **Users** — Ayush is the first/default user. Add users (name + photo
  URL) from the profile switcher in the sidebar; switching users switches
  all visible data. No passwords or auth, just local profiles.
- **Projects** — Fermah, Dlicom and Primus in the sidebar, each with its
  logo. Add, edit and delete projects manually (name + colour + Discord
  link + logo image URL + note). A project can be marked **Ended**: it
  leaves the active schedule and the new-task dropdown, its reminders
  stop, but ALL its data and history stay saved forever (Resume brings
  it back).
- **Daily Schedule** — tasks, X posts, Discord chats and events with
  timings, all in one day view across every project. One-day-only or
  repeating every day. Tap the circle when done.
- **Three-state status** — every task is done, missed or pending for that
  day. Click the circle for done, right-click it (or "Mark missed") for
  missed; clicking again clears it back to pending.
- **Done vs Posted** — separate states for post tasks. Marking a post
  Done never flips it to Posted; "Mark posted" is its own toggle, so the
  list shows what you did vs what is actually live.
- **Kaito** — post tasks have a "Post this on Kaito too" checkbox. Kaito
  posts get a Kaito badge (with the Kaito logo) and a Kaito filter chip.
- **Post links** — every post task can carry the URL of the post you
  made. Paste it in the add/edit form or in the expanded task row, and
  it shows as a clickable "Open post ↗" link.
- **Events: Play vs Host** — an event task is independently Play OR Host
  (pick per event in the form). The same project on the same day can have
  both, each with its own time, or just one of them. The day view shows
  each with its own time and role badge.
- **Calendar + day detail** — week strip plus a month view. Click any
  date (calendar or history) to see what you did that day: every task,
  in which project, done / missed / pending, plus that day's chat count.
- **History** — every day's work is saved forever. The History view
  shows the last 7 / 14 / 30 days with each day's done/missed/pending
  counts and Discord sent vs target. Rollover only carries the chat
  target forward to a fresh day; it never deletes history.
- **Communication** — daily Discord chat target with a gauge, +1/+5
  logging and an Open Discord button. Target is configurable from 100 to
  1000 (default 50). **Per-project chat**: each active project has its
  own sent/target row — logging a project chat also adds to the global
  daily total. Each project can have its own Discord link, opened in a
  new tab from the sidebar or the chat view.
- **Reminders** — while the site is open it checks every 30 seconds and
  notifies at each task's set time, naming the task's own project
  ("Daily Hub — Fermah: Post about Fermah · 6:30 PM"). Each task has its
  own Remind me on/off toggle (default on); "Reminders on" in the
  sidebar switches all reminders off. An "Up next" banner shows the next
  upcoming task with a live countdown to its own set time.
- **Voice announcements** — with Sound on, the site speaks reminders out
  loud (Web Speech API): e.g. "Ayush, time for Fermah — Post about
  Fermah at 6:30 PM. 2 hours left." "Test voice" speaks the next pending
  task's real announcement (or a generic line when nothing is pending).
  Sound only starts after you turn it on (browsers block autoplay
  audio).
- **Speed / feedback** — saves show a spinner and a quick confirmation
  toast ("Task added ✓"); the day loads with a loading state, never a
  "No projects yet" flash. Time fields use a proper time picker with
  9 AM / 12 PM / 6 PM / 9 PM quick chips. Task actions have visible
  labels, not icon-only buttons.
- **Responsive** — desktop keeps the sidebar + panel layout; tablets
  narrow the sidebar; on phones the sidebar collapses to a
  "Projects & settings" toggle and navigation moves to a bottom bar
  (Today, Calendar, History, Chat) with safe-area padding. Verified at
  360px, 390px, 768px and 1280px: no horizontal overflow, no clipped or
  overlapping text.
- **Fonts** — Sora (display) + Manrope (body) are self-hosted, embedded
  in the CSS as subset woff2 data URIs, so they load on every device
  with no third-party request. (The old Google Fonts @import was
  removed: it returned 0 bytes in the headless probe, so the site was
  silently falling back to system fonts.)
- **Phone reminders** — every task with reminders on has "📅 Add to
  phone" (downloads a .ics file for that task, with the project name in
  the title and description and a 15-minute alarm) and "Google Calendar"
  (opens the same event pre-filled, project name included).

## Deploy on Vercel

This repo deploys as a static site plus serverless API routes:

- Build: `bun run build:client` → `client/dist`
- API: `api/users.ts`, `api/projects.ts`, `api/tasks.ts`, `api/chat.ts`
  (Vercel serverless functions, backed by Vercel Postgres)

### 1. Import the repo in Vercel

Import `starayush-cpu/dailytasks-1` in the Vercel Dashboard. `vercel.json`
already sets the build command, output directory and install command, so
no extra settings are needed.

### 2. Create and link a Postgres database

In the Vercel Dashboard, open the project → **Storage** → **Create
Database** → **Postgres**. Once created, link it to the `dailytasks-1`
project — Vercel adds `POSTGRES_URL` to the project's environment
variables automatically. Redeploy after linking.

No manual migration is needed: the API creates the tables on first use
(`CREATE TABLE IF NOT EXISTS` in `api/_db.ts`, plus `ADD COLUMN IF NOT
EXISTS` for columns added later):

- `users` (id, name, photo)
- `projects` (id, user_id, name, color, link, note, logo, ended)
- `tasks` (id, user_id, project_id, title, time, type, repeat, done,
  date, post_link, details, event_role, remind, kaito, posted)
- `completions` (task_id, date, done, status, posted — per-date
  done/missed/posted state; no row means pending / not posted)
- `chat_days` (user_id, date, sent, target)
- `project_chat_days` (user_id, project_id, date, sent, target)

### 3. Before the database is linked

If `POSTGRES_URL` is not set, the API routes return an error and the site
falls back to storing data in the visitor's browser (`localStorage`,
keyed per user, with a one-time migration of the old single-user store).
Everything keeps working, but data stays on that one browser. Once the
database is linked, the site uses Postgres and data is shared across
devices.

## Data storage: Vercel vs the Muse space version

- **On Vercel:** data lives in Vercel Postgres (shared across devices)
  once the database is linked; before that, in the browser's
  `localStorage` (this device/browser only).
- **The Muse space version** of Daily Hub (same UI) stores data in its
  own server database instead. `server/` and `drizzle/` in this repo are
  that Muse space version's code and are not part of the Vercel build.

## Images

- `public/ayush-pfp.jpg` — Ayush's profile photo (from his X @_star_ayush).
- `public/fermah-logo.webp` — Fermah X logo (@fermah_xyz, dark-green
  square with a mint pixel mark).
- `public/dlicom-logo.svg` — official white Dlicom mark (for dark backgrounds).
- `public/primus-logo.png` — Primus Labs logo (orange circle).
- `public/kaito-logo.jpg` — Kaito logo (mint pixel K on dark).
- `public/discord-logo.svg`, `public/x-logo.svg` — Discord and X brand
  marks (white, for the dark UI).
- The client build copies `public/` into `client/dist/`, so the images are
  served with the site. If an image is missing, the UI falls back to the
  monogram avatar / color dots (and platform icons hide themselves).

## Stack

React 19 + TypeScript + Bun, Drizzle ORM, `@neondatabase/serverless`,
Tailwind CSS 4. Static client built with `Bun.build`
(`client/build.mjs`).

## Structure

- `client/` — React app (`src/App.tsx`, `src/Widget.tsx`, `src/api.ts`,
  `src/theme.css`)
- `api/` — Vercel serverless routes (`_db.ts`, `users.ts`, `projects.ts`,
  `tasks.ts`, `chat.ts`, `tsconfig.json`)
- `public/` — profile photo + project/platform logos
- `server/src/` + `drizzle/` — Muse space version (not built on Vercel)
- `space.json` — Muse space runtime config (slug `daily-hub`)

## Develop

```sh
bun install
bun run build:client        # client typecheck + static build -> client/dist
bun x tsc --noEmit -p api/tsconfig.json   # API typecheck
```

To test the API routes locally, set `POSTGRES_URL` to a Postgres
connection string first; without it, the app runs on the `localStorage`
fallback.
