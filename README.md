# Daily Hub

A personal daily schedule dashboard for Ayush (starayush). Glass-design
dashboard with a projects sidebar, a daily schedule timeline, a calendar,
and a Discord chat target tracker.

## What it does

- **Projects** — Fermah, Dlicom and Primus in the sidebar. Add, edit and
  delete projects manually (name + color).
- **Daily Schedule** — tasks, X posts and Discord items with timings.
  One-day-only or repeating every day. Tick the circles as you finish.
- **Calendar** — week strip plus a month view of the schedule.
- **Communication** — daily Discord chat target with a gauge, +1/+5
  logging and an Open Discord button.
- A daily rollover prepares each new day automatically (around 00:34 IST
  on the Muse space version; on Vercel the target carries forward on
  first open of the day).

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
(`CREATE TABLE IF NOT EXISTS` in `api/_db.ts`):

- `projects` (id, name, color, link, note)
- `tasks` (id, project_id, title, time, type, repeat, done, date)
- `completions` (task_id, date, done — per-date done state, so a recurring
  task appears unchecked on a new day)
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

## Stack

React 19 + TypeScript + Bun, Drizzle ORM, `@neondatabase/serverless`,
Tailwind CSS 4, Recharts. Static client built with `Bun.build`
(`client/build.mjs`).

## Structure

- `client/` — React app (`src/App.tsx`, `src/Widget.tsx`, `src/api.ts`,
  `src/theme.css`)
- `api/` — Vercel serverless routes (`_db.ts`, `projects.ts`, `tasks.ts`,
  `chat.ts`)
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
