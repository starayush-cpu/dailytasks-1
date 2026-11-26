# Daily Hub

A personal daily schedule dashboard for Ayush (starayush). Glass-design
dashboard with a projects sidebar, a daily schedule timeline, a calendar,
a history view, and a Discord chat target tracker. Profile photo and
project logos included.

## What it does

- **Projects** — Fermah, Dlicom and Primus in the sidebar, each with its
  logo. Add, edit and delete projects manually (name + color).
- **Daily Schedule** — tasks, X posts, Discord sessions and events with
  timings. One-day-only or repeating every day. Tick the circle when done.
- **Three-state status** — every task is done, missed or pending for that
  day. Tap ✓ for done, ✕ for missed (missed shows red/dimmed); tapping
  again clears it back to pending.
- **Post links** — every task can carry the URL of the post you made.
  Paste it in the add/edit form or with the 🔗 button on the task, and it
  shows as a clickable "View post ↗" link.
- **Events** — task kind "event" with a Join / Host role, plus an optional
  details field on every task (timing, notes, what to say).
- **Calendar** — week strip plus a month view of the schedule.
- **History** — every day's work is saved forever. The History view shows
  any past 30 days with each day's tasks (done / missed / pending, post
  links) and Discord sent vs target. Rollover only carries the chat target
  forward to a fresh day; it never deletes history.
- **Communication** — daily Discord chat target with a gauge, +1/+5
  logging and an Open Discord button. Target is configurable from 100 to
  1000 (default 50).
- **Reminders** — "Enable reminders" asks notification permission; while
  the site is open it checks every minute and notifies at each task's set
  time ("Time for: <task title>"). Each task has its own Remind me
  on/off toggle (default on), and an "Up next" banner shows the next
  upcoming task of the day.
- **Voice announcements** — with Sound on, the site speaks reminders out
  loud (Web Speech API, clear English voice): e.g. "Ayush, you have not
  posted about Fermah today, 2 hours left" for posts, and "Ayush, you
  still have 30 chats to go today" for Discord. "Test voice" plays a
  sample. Sound only starts after you turn it on (browsers block
  autoplay audio).
- **Responsive, mobile-first** — on phones the sidebar becomes a bottom
  navigation bar (Dashboard, Add task, Calendar, History, Discord) with
  safe-area padding; cards stack in one column, nothing scrolls
  sideways, and tap targets are at least 44px. Desktop keeps the
  three-column dashboard.
- **Phone reminders** — every task has a 📅 "Set phone reminder" button.
  "Download .ics file" downloads a calendar event for that task (date +
  time from the task, with a reminder alarm at the task time) — tapping
  the file adds it to the phone's own calendar app. "Add to Google
  Calendar ↗" opens the same event pre-filled in Google Calendar
  instead. Both work on mobile and desktop.

## Deploy on Vercel

This repo deploys as a static site plus serverless API routes:

- Build: `bun run build:client` → `client/dist`
- API: `api/projects.ts`, `api/tasks.ts`, `api/chat.ts` (Vercel serverless
  functions, backed by Vercel Postgres)

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

- `projects` (id, name, color, link, note)
- `tasks` (id, project_id, title, time, type, repeat, done, date,
  post_link, details, event_role, remind)
- `completions` (task_id, date, done, status — per-date done/missed
  state; no row means pending)
- `chat_days` (date, sent, target)

### 3. Before the database is linked

If `POSTGRES_URL` is not set, the API routes return an error and the site
falls back to storing data in the visitor's browser (`localStorage`).
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
- `public/fermah-logo.webp` — Fermah blue fish logo.
- `public/dlicom-logo.svg` — official white Dlicom mark (for dark backgrounds).
- `public/primus-logo.png` — Primus Labs logo (orange circle).
- The client build copies `public/` into `client/dist/`, so the images are
  served with the site. If an image is missing, the UI falls back to the
  monogram avatar / color dots.

## Stack

React 19 + TypeScript + Bun, Drizzle ORM, `@neondatabase/serverless`,
Tailwind CSS 4. Static client built with `Bun.build`
(`client/build.mjs`).

## Structure

- `client/` — React app (`src/App.tsx`, `src/Widget.tsx`, `src/api.ts`,
  `src/theme.css`)
- `api/` — Vercel serverless routes (`_db.ts`, `projects.ts`, `tasks.ts`,
  `chat.ts`)
- `public/` — profile photo + project logos
- `server/src/` + `drizzle/` — Muse space version (not built on Vercel)
- `space.json` — Muse space runtime config (slug `daily-hub`)

## Develop

```sh
bun install
bun run typecheck
bun run build
```

To test the API routes locally, set `POSTGRES_URL` to a Postgres
connection string first; without it, the app runs on the `localStorage`
fallback.
