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
- Everything you add is saved, and a daily rollover prepares each new day
  automatically (around 00:34 IST).

## Stack

React 19 + TypeScript + Bun, Drizzle ORM (SQLite), Tailwind CSS 4,
Recharts. Runs as a Muse space (TypeScript runtime).

## Structure

- `client/` — React app (`src/App.tsx`, `src/Widget.tsx`, `src/api.ts`,
  `src/theme.css`)
- `server/src/` — server actions (`actions.ts`) and schema (`schema.ts`)
- `drizzle/` — SQL migrations
- `space.json` — space runtime config (slug `daily-hub`, targets mobile /
  desktop / widget, daily `rolloverDay` cron)

## Develop

```sh
bun install
bun run typecheck
bun run build
```

Note: `@hatch/space-sdk` is a `file:` dependency on the Muse space
runtime, so the app runs fully as a Muse space. The live version is the
Daily Hub space, not a static site.
