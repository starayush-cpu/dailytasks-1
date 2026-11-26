// Vercel Postgres (Neon) data layer for the Daily Hub static build.
//
// Tables are created with CREATE TABLE IF NOT EXISTS on first use, so no
// manual migration step is needed: link a Postgres database to the Vercel
// project (Storage -> Create Database) and POSTGRES_URL is provided.
//
// Tables:
//   projects    id, name, color, link, note
//   tasks       id, project_id, title, time, type, repeat, done, date
//   completions task_id, date, done   (per-date done state, so a recurring
//                                      task appears unchecked on a new day)
//   chat_days   date, sent, target
//
// `done` on tasks mirrors the latest toggle for one-off dated tasks; the
// per-date truth for every task lives in `completions`.

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";

export type ProjectColor = "blue" | "violet" | "green" | "orange" | "pink" | "teal";
export type TaskKind = "task" | "post" | "discord" | "event";
export type EventRole = "join" | "host";
export type TaskStatus = "done" | "missed" | "pending";

let db: ReturnType<typeof drizzle> | null = null;
let schemaReady: Promise<void> | null = null;

export type Db = ReturnType<typeof drizzle>;

export function getDb() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Create a Postgres database in the Vercel Dashboard (Storage) and link it to this project.",
    );
  }
  if (!db) {
    db = drizzle(neon(url));
  }
  return db;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const d = getDb();
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS projects (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT 'blue',
          link TEXT,
          note TEXT
        )`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          time TEXT,
          type TEXT NOT NULL DEFAULT 'task',
          repeat INTEGER NOT NULL DEFAULT 0,
          done INTEGER NOT NULL DEFAULT 0,
          date TEXT,
          post_link TEXT,
          details TEXT,
          event_role TEXT,
          remind INTEGER NOT NULL DEFAULT 1
        )`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS completions (
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          status TEXT,
          PRIMARY KEY (task_id, date)
        )`);
      // Columns added after the first version: databases created by the
      // earlier deploy get them here instead of a manual migration.
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS post_link TEXT`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS details TEXT`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS event_role TEXT`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind INTEGER NOT NULL DEFAULT 1`);
      await d.execute(sql`ALTER TABLE completions ADD COLUMN IF NOT EXISTS status TEXT`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS chat_days (
          date TEXT PRIMARY KEY,
          sent INTEGER NOT NULL DEFAULT 0,
          target INTEGER NOT NULL DEFAULT 50
        )`);
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

export async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  await ensureSchema();
  return fn(getDb());
}

const STARTERS: { name: string; color: ProjectColor }[] = [
  { name: "Fermah", color: "violet" },
  { name: "Dlicom", color: "blue" },
  { name: "Primus", color: "teal" },
];

export async function ensureStarterProjects(): Promise<number> {
  return withDb(async (d) => {
    const existing = await d.execute(sql`SELECT id FROM projects LIMIT 1`);
    if (existing.rows.length > 0) return 0;
    for (const s of STARTERS) {
      await d.execute(sql`INSERT INTO projects (name, color) VALUES (${s.name}, ${s.color})`);
    }
    return STARTERS.length;
  });
}

export async function loadChat(
  d: ReturnType<typeof drizzle>,
  date: string,
): Promise<{ target: number; sent: number }> {
  const rows = await d.execute(sql`SELECT target, sent FROM chat_days WHERE date = ${date} LIMIT 1`);
  const row = rows.rows[0] as { target: number; sent: number } | undefined;
  if (row) return { target: row.target, sent: row.sent };
  // Carry the most recent earlier target forward so the goal survives day changes.
  const prior = await d.execute(sql`SELECT target FROM chat_days ORDER BY date DESC LIMIT 1`);
  const p = prior.rows[0] as { target: number } | undefined;
  return { target: p?.target ?? 50, sent: 0 };
}

export async function upsertChat(
  d: ReturnType<typeof drizzle>,
  date: string,
  target: number,
  sent: number,
): Promise<void> {
  await d.execute(sql`
    INSERT INTO chat_days (date, target, sent) VALUES (${date}, ${target}, ${sent})
    ON CONFLICT (date) DO UPDATE SET target = EXCLUDED.target, sent = EXCLUDED.sent`);
}

export function todayInKolkata(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function isValidDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function isValidTime(s: unknown): s is string | null {
  return s === null || s === undefined || (typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
}
