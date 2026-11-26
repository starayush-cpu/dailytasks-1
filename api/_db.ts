// Vercel Postgres (Neon) data layer for the Daily Hub static build.
//
// Tables are created with CREATE TABLE IF NOT EXISTS on first use, so no
// manual migration step is needed: link a Postgres database to the Vercel
// project (Storage -> Create Database) and POSTGRES_URL is provided.
//
// Tables:
//   users       id, name, photo (Ayush is id 1, the default user)
//   projects    id, user_id, name, color, link, note, logo, ended
//   tasks       id, user_id, project_id, title, time, type, repeat, done,
//               date, post_link, details, event_role, remind, kaito, posted
//   completions task_id, date, done, status, posted (per-date done/missed/
//               posted state, so a recurring task appears unchecked on a
//               new day; no row means pending / not posted)
//   chat_days   user_id, date, sent, target
//   project_chat_days user_id, project_id, date, sent, target
//
// `done`/`posted` on tasks mirror the latest toggle for one-off dated
// tasks; the per-date truth for every task lives in `completions`.
//
// Every row is owned by one user (user_id). All API calls are scoped to
// the active user id the client sends; there is no password/auth, just
// local profiles on this site.

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";

export type ProjectColor = "blue" | "violet" | "green" | "orange" | "pink" | "teal";
export type TaskKind = "task" | "post" | "discord" | "event";
// Event roles are Play and Host. Old rows stored "join" — read as "play".
export type EventRole = "play" | "host";
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

export function cleanEventRole(v: unknown): EventRole | null {
  if (v === "host") return "host";
  if (v === "play" || v === "join") return "play";
  return null;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const d = getDb();
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          photo TEXT
        )`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS projects (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT 'blue',
          link TEXT,
          note TEXT,
          logo TEXT,
          ended INTEGER NOT NULL DEFAULT 0
        )`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
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
          remind INTEGER NOT NULL DEFAULT 1,
          kaito INTEGER NOT NULL DEFAULT 0,
          posted INTEGER NOT NULL DEFAULT 0
        )`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS completions (
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          status TEXT,
          posted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (task_id, date)
        )`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS chat_days (
          user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          sent INTEGER NOT NULL DEFAULT 0,
          target INTEGER NOT NULL DEFAULT 50,
          PRIMARY KEY (user_id, date)
        )`);
      await d.execute(sql`
        CREATE TABLE IF NOT EXISTS project_chat_days (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          sent INTEGER NOT NULL DEFAULT 0,
          target INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, project_id, date)
        )`);
      // Columns added after the first version: databases created by an
      // earlier deploy get them here instead of a manual migration.
      await d.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE`);
      await d.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo TEXT`);
      await d.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ended INTEGER NOT NULL DEFAULT 0`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS post_link TEXT`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS details TEXT`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS event_role TEXT`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind INTEGER NOT NULL DEFAULT 1`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kaito INTEGER NOT NULL DEFAULT 0`);
      await d.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS posted INTEGER NOT NULL DEFAULT 0`);
      await d.execute(sql`ALTER TABLE completions ADD COLUMN IF NOT EXISTS status TEXT`);
      await d.execute(sql`ALTER TABLE completions ADD COLUMN IF NOT EXISTS posted INTEGER NOT NULL DEFAULT 0`);
      // Pre-multi-user chat_days had PRIMARY KEY (date). Migrate it to
      // (user_id, date); best effort — never block startup on this.
      try {
        await d.execute(sql`ALTER TABLE chat_days ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE`);
        await d.execute(sql`ALTER TABLE chat_days DROP CONSTRAINT IF EXISTS chat_days_pkey`);
        await d.execute(sql`ALTER TABLE chat_days ADD CONSTRAINT chat_days_pkey PRIMARY KEY (user_id, date)`);
      } catch {
        // Already composite, or an old table shape we cannot migrate here.
      }
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

export type UserRow = { id: number; name: string; photo: string | null };

/** Ayush is user 1, the default user. Creates him if he is missing. */
export async function ensureUser(userId: number): Promise<UserRow> {
  return withDb(async (d) => {
    if (userId === 1) {
      await d.execute(
        sql`INSERT INTO users (id, name, photo) VALUES (1, 'Ayush', './ayush-pfp.jpg') ON CONFLICT (id) DO NOTHING`,
      );
    }
    const r = await d.execute(sql`SELECT id, name, photo FROM users WHERE id = ${userId} LIMIT 1`);
    const row = r.rows[0] as UserRow | undefined;
    if (!row) throw new Error("Unknown user.");
    return row;
  });
}

export async function listUsers(): Promise<UserRow[]> {
  return withDb(async (d) => {
    const r = await d.execute(sql`SELECT id, name, photo FROM users ORDER BY id ASC`);
    return (r.rows as UserRow[]).map((u) => ({ id: u.id, name: u.name, photo: u.photo ?? null }));
  });
}

const STARTERS: { name: string; color: ProjectColor }[] = [
  { name: "Fermah", color: "violet" },
  { name: "Dlicom", color: "blue" },
  { name: "Primus", color: "teal" },
];

/** Starter projects are seeded only for Ayush (user 1); other users start empty. */
export async function ensureStarterProjects(userId: number): Promise<number> {
  if (userId !== 1) return 0;
  return withDb(async (d) => {
    const existing = await d.execute(sql`SELECT id FROM projects WHERE user_id = 1 LIMIT 1`);
    if (existing.rows.length > 0) return 0;
    for (const s of STARTERS) {
      await d.execute(
        sql`INSERT INTO projects (user_id, name, color) VALUES (1, ${s.name}, ${s.color})`,
      );
    }
    return STARTERS.length;
  });
}

export async function loadChat(
  d: ReturnType<typeof drizzle>,
  userId: number,
  date: string,
): Promise<{ target: number; sent: number }> {
  const rows = await d.execute(
    sql`SELECT target, sent FROM chat_days WHERE user_id = ${userId} AND date = ${date} LIMIT 1`,
  );
  const row = rows.rows[0] as { target: number; sent: number } | undefined;
  if (row) return { target: row.target, sent: row.sent };
  // Carry the most recent earlier target forward so the goal survives day changes.
  const prior = await d.execute(
    sql`SELECT target FROM chat_days WHERE user_id = ${userId} ORDER BY date DESC LIMIT 1`,
  );
  const p = prior.rows[0] as { target: number } | undefined;
  return { target: p?.target ?? 50, sent: 0 };
}

export async function upsertChat(
  d: ReturnType<typeof drizzle>,
  userId: number,
  date: string,
  target: number,
  sent: number,
): Promise<void> {
  await d.execute(sql`
    INSERT INTO chat_days (user_id, date, target, sent) VALUES (${userId}, ${date}, ${target}, ${sent})
    ON CONFLICT (user_id, date) DO UPDATE SET target = EXCLUDED.target, sent = EXCLUDED.sent`);
}

export type ProjectChatRow = { projectId: number; sent: number; target: number };

export async function getProjectChat(
  d: ReturnType<typeof drizzle>,
  userId: number,
  date: string,
): Promise<ProjectChatRow[]> {
  const r = await d.execute(
    sql`SELECT project_id, sent, target FROM project_chat_days WHERE user_id = ${userId} AND date = ${date}`,
  );
  return (r.rows as { project_id: number; sent: number; target: number }[]).map((x) => ({
    projectId: x.project_id,
    sent: x.sent,
    target: x.target,
  }));
}

export async function loadProjectChat(
  d: ReturnType<typeof drizzle>,
  userId: number,
  date: string,
  projectId: number,
): Promise<{ sent: number; target: number }> {
  const r = await d.execute(
    sql`SELECT sent, target FROM project_chat_days WHERE user_id = ${userId} AND project_id = ${projectId} AND date = ${date} LIMIT 1`,
  );
  const row = r.rows[0] as { sent: number; target: number } | undefined;
  return row ?? { sent: 0, target: 0 };
}

/** Log project chats: bumps the project's counter AND the global daily total. */
export async function logProjectChat(
  d: ReturnType<typeof drizzle>,
  userId: number,
  date: string,
  projectId: number,
  delta: number,
): Promise<{ projectSent: number; globalSent: number }> {
  const current = await loadProjectChat(d, userId, date, projectId);
  const projectSent = Math.max(0, current.sent + delta);
  await d.execute(sql`
    INSERT INTO project_chat_days (user_id, project_id, date, sent, target)
    VALUES (${userId}, ${projectId}, ${date}, ${projectSent}, ${current.target})
    ON CONFLICT (user_id, project_id, date) DO UPDATE SET sent = EXCLUDED.sent`);
  const global = await loadChat(d, userId, date);
  await upsertChat(d, userId, date, global.target, Math.max(0, global.sent + delta));
  return { projectSent, globalSent: Math.max(0, global.sent + delta) };
}

export async function setProjectTarget(
  d: ReturnType<typeof drizzle>,
  userId: number,
  date: string,
  projectId: number,
  target: number,
): Promise<void> {
  const current = await loadProjectChat(d, userId, date, projectId);
  await d.execute(sql`
    INSERT INTO project_chat_days (user_id, project_id, date, sent, target)
    VALUES (${userId}, ${projectId}, ${date}, ${current.sent}, ${target})
    ON CONFLICT (user_id, project_id, date) DO UPDATE SET target = EXCLUDED.target`);
}

export async function setProjectSent(
  d: ReturnType<typeof drizzle>,
  userId: number,
  date: string,
  projectId: number,
  sent: number,
): Promise<void> {
  const current = await loadProjectChat(d, userId, date, projectId);
  await d.execute(sql`
    INSERT INTO project_chat_days (user_id, project_id, date, sent, target)
    VALUES (${userId}, ${projectId}, ${date}, ${sent}, ${current.target})
    ON CONFLICT (user_id, project_id, date) DO UPDATE SET sent = EXCLUDED.sent`);
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

/** The active user id from the request body; defaults to Ayush (1). */
export function cleanUserId(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
