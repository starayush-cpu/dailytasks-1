// Tasks API: getDay / getMonth / getHistory / add / update / delete /
// setDone / setStatus / setPosted / setVerified / setEngagement.
// POST /api/tasks { action, userId, ...args }
//
// Task status is THREE-state per day: done, missed, pending.
// `completions` stores an explicit status ('done' | 'missed') and a
// `posted` flag per task per day; no row means pending / not posted.
// `tasks.done` / `tasks.posted` mirror the latest toggle for one-off
// dated tasks only. Done and Posted are separate states: marking a post
// Done never flips it to Posted.
//
// Event roles are Play and Host. An event task is independently Play OR
// Host; the same project on the same day can have both, each with its own
// time. Old rows stored "join" — read as "play".
//
// Tasks of Ended projects are hidden from the active schedule (getDay /
// getMonth) but stay visible in history forever.

import { sql } from "drizzle-orm";
import {
  withDb,
  ensureUser,
  ensureStarterProjects,
  loadChat,
  getProjectChat,
  isValidDate,
  isValidTime,
  cleanUserId,
  cleanEventRole,
} from "./_db.js";
import type { Db, ProjectColor, TaskKind, TaskStatus } from "./_db.js";

const KINDS: TaskKind[] = ["task", "post", "discord", "event"];

type TaskRow = {
  id: number;
  title: string;
  type: string;
  time: string | null;
  repeat: number;
  done: number;
  date: string | null;
  project_id: number | null;
  post_link: string | null;
  details: string | null;
  event_role: string | null;
  remind: number;
  kaito: number;
  posted: number;
};

type ProjectRow = {
  id: number;
  name: string;
  color: string;
  link: string | null;
  note: string | null;
  logo: string | null;
  ended: number;
};

type CompletionRow = {
  task_id: number;
  date: string;
  done: number;
  status: string | null;
  posted: number;
  verified: number;
  verified_source: string | null;
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
};

/** Engagement is per post per day; a row carrying any of these (or a
 * verification) must not be deleted by the done/posted clear paths. */
function completionCarriesCheck(c: CompletionRow | undefined): boolean {
  if (!c) return false;
  return (
    c.verified === 1 ||
    c.views != null ||
    c.likes != null ||
    c.reposts != null ||
    c.replies != null
  );
}

/** An engagement number: null clears it, "invalid" rejects the request. */
function cleanEngagement(v: unknown): number | null | "invalid" {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000000) return "invalid";
  return n;
}

function cleanSource(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 40) : "manual";
}

function cleanKind(k: unknown): TaskKind {
  return KINDS.includes(k as TaskKind) ? (k as TaskKind) : "task";
}

function cleanStr(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.slice(0, max);
}

function statusOf(c: CompletionRow | undefined): TaskStatus {
  if (!c) return "pending";
  if (c.status === "done" || c.status === "missed") return c.status;
  return c.done === 1 ? "done" : "pending";
}

function postedOf(c: CompletionRow | undefined, mirror: number): boolean {
  if (c) return c.posted === 1;
  return mirror === 1;
}

const COMPLETION_COLS =
  "task_id, date, done, status, posted, verified, verified_source, views, likes, reposts, replies";

function toDayTask(
  r: TaskRow,
  proj: { name: string; color: ProjectColor; ended: boolean } | undefined,
  c: CompletionRow | undefined,
) {
  const status = statusOf(c);
  return {
    id: r.id,
    title: r.title,
    kind: r.type as TaskKind,
    time: r.time,
    recurring: r.repeat === 1,
    projectId: r.project_id,
    projectName: proj?.name ?? null,
    projectColor: proj?.color ?? null,
    projectEnded: proj?.ended ?? false,
    done: status === "done",
    status,
    posted: postedOf(c, r.posted),
    verified: c?.verified === 1,
    verifiedSource: c?.verified_source ?? null,
    views: c?.views ?? null,
    likes: c?.likes ?? null,
    reposts: c?.reposts ?? null,
    replies: c?.replies ?? null,
    kaito: r.kaito === 1,
    postLink: r.post_link ?? null,
    details: r.details ?? null,
    eventRole: cleanEventRole(r.event_role),
    remind: r.remind !== 0,
  };
}

async function loadProjects(db: Db, userId: number) {
  const projRes = await db.execute(
    sql`SELECT id, name, color, link, note, logo, ended FROM projects WHERE user_id = ${userId} ORDER BY ended ASC, id ASC`,
  );
  const projects = (projRes.rows as ProjectRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color as ProjectColor,
    link: r.link ?? null,
    note: r.note ?? null,
    logo: r.logo ?? null,
    ended: r.ended === 1,
  }));
  return { projects, byId: new Map(projects.map((p) => [p.id, p])) };
}

const TASK_COLS =
  "id, title, type, time, repeat, done, date, project_id, post_link, details, event_role, remind, kaito, posted";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action, ...args } = body;
    const userId = cleanUserId(args.userId);
    await ensureUser(userId);

    if (action === "getDay") {
      const date = args.date;
      if (!isValidDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
      await ensureStarterProjects(userId);
      const out = await withDb(async (db) => {
        const { projects, byId } = await loadProjects(db, userId);
        const taskRes = await db.execute(
          sql`SELECT ${sql.raw(TASK_COLS)} FROM tasks WHERE user_id = ${userId} AND (repeat = 1 OR date = ${date}) ORDER BY time ASC NULLS FIRST, id ASC`,
        );
        const rows = taskRes.rows as TaskRow[];
        const compByTask = new Map<number, CompletionRow>();
        if (rows.length > 0) {
          const compRes = await db.execute(
            sql`SELECT ${sql.raw(COMPLETION_COLS)} FROM completions WHERE date = ${date}`,
          );
          for (const c of compRes.rows as CompletionRow[]) compByTask.set(c.task_id, c);
        }
        const chat = await loadChat(db, userId, date);
        const projectChat = await getProjectChat(db, userId, date);
        return {
          date,
          projects,
          // Ended projects' tasks stay in history but leave the active schedule.
          tasks: rows
            .filter((r) => {
              const proj = r.project_id != null ? byId.get(r.project_id) : undefined;
              return !proj?.ended;
            })
            .map((r) => {
              const proj = r.project_id != null ? byId.get(r.project_id) : undefined;
              return toDayTask(r, proj, compByTask.get(r.id));
            }),
          chat,
          projectChat,
        };
      });
      return res.status(200).json(out);
    }

    if (action === "getMonth") {
      const month = args.month;
      if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "Month must be YYYY-MM" });
      }
      const out = await withDb(async (db) => {
        const { byId } = await loadProjects(db, userId);
        const recRes = await db.execute(
          sql`SELECT COUNT(*)::int AS n FROM tasks WHERE user_id = ${userId} AND repeat = 1`,
        );
        const recurringCount = (recRes.rows[0] as { n: number }).n;
        const taskRes = await db.execute(
          sql`SELECT id, repeat, date, project_id FROM tasks WHERE user_id = ${userId} AND (date LIKE ${month + "%"} OR repeat = 1)`,
        );
        const compRes = await db.execute(
          sql`SELECT ${sql.raw(COMPLETION_COLS)} FROM completions WHERE date LIKE ${month + "%"}`,
        );
        const taskById = new Map(
          (taskRes.rows as { id: number; repeat: number; date: string | null; project_id: number | null }[]).map(
            (t) => [t.id, t],
          ),
        );
        const isEnded = (t: { project_id: number | null }) => {
          const p = t.project_id != null ? byId.get(t.project_id) : undefined;
          return p?.ended === true;
        };
        const totals = new Map<string, { total: number; done: number }>();
        const entryFor = (d: string) => {
          const e = totals.get(d) ?? { total: 0, done: 0 };
          totals.set(d, e);
          return e;
        };
        for (const t of taskById.values()) {
          if (t.repeat === 1 || !t.date || isEnded(t)) continue;
          entryFor(t.date).total += 1;
        }
        for (const c of compRes.rows as CompletionRow[]) {
          if (statusOf(c) !== "done") continue;
          const t = taskById.get(c.task_id);
          if (!t || isEnded(t)) continue;
          if (t.repeat === 1 || t.date === c.date) entryFor(c.date).done += 1;
        }
        return {
          days: [...totals.entries()].map(([date, v]) => ({ date, total: v.total, done: v.done })),
          recurringCount,
        };
      });
      return res.status(200).json(out);
    }

    if (action === "getHistory") {
      const from = args.from;
      const to = args.to;
      if (!isValidDate(from) || !isValidDate(to) || from > to) {
        return res.status(400).json({ error: "from/to must be YYYY-MM-DD with from <= to." });
      }
      const span = (Date.parse(to) - Date.parse(from)) / 86400000;
      if (span > 62) return res.status(400).json({ error: "History range is at most 62 days." });
      await ensureStarterProjects(userId);
      const out = await withDb(async (db) => {
        const { byId } = await loadProjects(db, userId);
        const taskRes = await db.execute(
          sql`SELECT ${sql.raw(TASK_COLS)} FROM tasks WHERE user_id = ${userId} AND (repeat = 1 OR (date >= ${from} AND date <= ${to})) ORDER BY time ASC NULLS FIRST, id ASC`,
        );
        const rows = taskRes.rows as TaskRow[];
        const compRes = await db.execute(
          sql`SELECT ${sql.raw(COMPLETION_COLS)} FROM completions WHERE date >= ${from} AND date <= ${to}`,
        );
        const compByKey = new Map<string, CompletionRow>();
        for (const c of compRes.rows as CompletionRow[]) compByKey.set(`${c.task_id}|${c.date}`, c);
        const chatRes = await db.execute(
          sql`SELECT date, sent, target FROM chat_days WHERE user_id = ${userId} AND date >= ${from} AND date <= ${to}`,
        );
        const chatByDate = new Map(
          (chatRes.rows as { date: string; sent: number; target: number }[]).map((c) => [
            c.date,
            { target: c.target, sent: c.sent },
          ]),
        );
        const projChatRes = await db.execute(
          sql`SELECT project_id, date, sent, target FROM project_chat_days WHERE user_id = ${userId} AND date >= ${from} AND date <= ${to}`,
        );
        const projChatByDate = new Map<string, { projectId: number; sent: number; target: number }[]>();
        for (const r of projChatRes.rows as { project_id: number; date: string; sent: number; target: number }[]) {
          const list = projChatByDate.get(r.date) ?? [];
          list.push({ projectId: r.project_id, sent: r.sent, target: r.target });
          projChatByDate.set(r.date, list);
        }
        const days: {
          date: string;
          tasks: ReturnType<typeof toDayTask>[];
          chat: { target: number; sent: number };
          projectChat: { projectId: number; sent: number; target: number }[];
        }[] = [];
        for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
          const key = d.toISOString().slice(0, 10);
          const dayTasks = rows
            .filter((r) => r.repeat === 1 || r.date === key)
            .map((r) => {
              const proj = r.project_id != null ? byId.get(r.project_id) : undefined;
              return toDayTask(r, proj, compByKey.get(`${r.id}|${key}`));
            });
          const chat = chatByDate.get(key) ?? (await loadChat(db, userId, key));
          if (dayTasks.length > 0 || chatByDate.has(key)) {
            days.push({ date: key, tasks: dayTasks, chat, projectChat: projChatByDate.get(key) ?? [] });
          }
        }
        return { days };
      });
      return res.status(200).json(out);
    }

    if (action === "add") {
      const title = String(args.title ?? "").trim();
      if (!title || title.length > 120) {
        return res.status(400).json({ error: "Title is required (max 120 chars)." });
      }
      if (!isValidTime(args.time ?? null)) {
        return res.status(400).json({ error: "Time must be HH:MM" });
      }
      const kind = cleanKind(args.kind);
      const recurring = args.recurring === true;
      const date = recurring ? null : isValidDate(args.date) ? (args.date as string) : null;
      const projectId =
        Number.isInteger(args.projectId) && args.projectId > 0 ? (args.projectId as number) : null;
      const time = typeof args.time === "string" && args.time ? args.time : null;
      const postLink = cleanStr(args.postLink, 500);
      const details = cleanStr(args.details, 500);
      const eventRole = kind === "event" ? cleanEventRole(args.eventRole) : null;
      const remind = args.remind === false ? 0 : 1;
      const kaito = kind === "post" && args.kaito === true ? 1 : 0;
      const id = await withDb(async (db) => {
        const r = await db.execute(
          sql`INSERT INTO tasks (user_id, project_id, title, time, type, repeat, done, date, post_link, details, event_role, remind, kaito, posted) VALUES (${userId}, ${projectId}, ${title}, ${time}, ${kind}, ${recurring ? 1 : 0}, 0, ${date}, ${postLink}, ${details}, ${eventRole}, ${remind}, ${kaito}, 0) RETURNING id`,
        );
        return (r.rows[0] as { id: number }).id;
      });
      return res.status(200).json({ id });
    }

    if (action === "update") {
      const id = Number(args.id);
      const title = String(args.title ?? "").trim();
      if (!Number.isInteger(id) || id <= 0 || !title || title.length > 120) {
        return res.status(400).json({ error: "Invalid task." });
      }
      if (!isValidTime(args.time ?? null)) {
        return res.status(400).json({ error: "Time must be HH:MM" });
      }
      const kind = cleanKind(args.kind);
      const recurring = args.recurring === true;
      const date = recurring ? null : isValidDate(args.date) ? (args.date as string) : null;
      const projectId =
        Number.isInteger(args.projectId) && args.projectId > 0 ? (args.projectId as number) : null;
      const time = typeof args.time === "string" && args.time ? args.time : null;
      const postLink = cleanStr(args.postLink, 500);
      const details = cleanStr(args.details, 500);
      const eventRole = kind === "event" ? cleanEventRole(args.eventRole) : null;
      const remind = args.remind === false ? 0 : 1;
      const kaito = kind === "post" && args.kaito === true ? 1 : 0;
      await withDb(async (db) => {
        await db.execute(
          sql`UPDATE tasks SET project_id = ${projectId}, title = ${title}, time = ${time}, type = ${kind}, repeat = ${recurring ? 1 : 0}, date = ${date}, post_link = ${postLink}, details = ${details}, event_role = ${eventRole}, remind = ${remind}, kaito = ${kaito} WHERE id = ${id} AND user_id = ${userId}`,
        );
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid task id." });
      }
      await withDb(async (db) => {
        await db.execute(sql`DELETE FROM completions WHERE task_id = ${id}`);
        await db.execute(sql`DELETE FROM tasks WHERE id = ${id} AND user_id = ${userId}`);
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "setDone" || action === "setStatus") {
      const taskId = Number(args.taskId);
      const date = args.date;
      if (!Number.isInteger(taskId) || taskId <= 0 || !isValidDate(date)) {
        return res.status(400).json({ error: "Invalid task or date." });
      }
      // setDone {done} maps onto the three-state status; setStatus takes
      // status 'done' | 'missed' | null (null = back to pending, row removed
      // only when the task was never posted that day either).
      let status: TaskStatus | null;
      if (action === "setDone") {
        status = args.done === true ? "done" : null;
      } else if (args.status === "done" || args.status === "missed") {
        status = args.status;
      } else {
        status = null;
      }
      const owned = await withDb(async (db) => {
        const own = await db.execute(
          sql`SELECT id FROM tasks WHERE id = ${taskId} AND user_id = ${userId} LIMIT 1`,
        );
        if (own.rows.length === 0) return false;
        const cur = await db.execute(
          sql`SELECT posted, verified, views, likes, reposts, replies FROM completions WHERE task_id = ${taskId} AND date = ${date} LIMIT 1`,
        );
        const curRow = cur.rows[0] as
          | { posted: number; verified: number; views: number | null; likes: number | null; reposts: number | null; replies: number | null }
          | undefined;
        const curPosted = curRow?.posted ?? 0;
        // A row carrying a verification or engagement keeps its data: clear
        // the status, do not delete the row.
        if (status === null && curPosted === 0 && !completionCarriesCheck(curRow as CompletionRow | undefined)) {
          await db.execute(sql`DELETE FROM completions WHERE task_id = ${taskId} AND date = ${date}`);
        } else {
          await db.execute(sql`
            INSERT INTO completions (task_id, date, done, status, posted) VALUES (${taskId}, ${date}, ${status === "done" ? 1 : 0}, ${status}, ${curPosted})
            ON CONFLICT (task_id, date) DO UPDATE SET done = EXCLUDED.done, status = EXCLUDED.status`);
        }
        // Keep the tasks.done mirror in sync for one-off dated tasks.
        const t = await db.execute(sql`SELECT repeat FROM tasks WHERE id = ${taskId} LIMIT 1`);
        const row = t.rows[0] as { repeat: number } | undefined;
        if (row && row.repeat === 0) {
          await db.execute(sql`UPDATE tasks SET done = ${status === "done" ? 1 : 0} WHERE id = ${taskId}`);
        }
        return true;
      });
      if (!owned) return res.status(400).json({ error: "Unknown task." });
      return res.status(200).json({ ok: true });
    }

    if (action === "setPosted") {
      const taskId = Number(args.taskId);
      const date = args.date;
      const posted = args.posted === true;
      if (!Number.isInteger(taskId) || taskId <= 0 || !isValidDate(date)) {
        return res.status(400).json({ error: "Invalid task or date." });
      }
      const owned = await withDb(async (db) => {
        const own = await db.execute(
          sql`SELECT id FROM tasks WHERE id = ${taskId} AND user_id = ${userId} LIMIT 1`,
        );
        if (own.rows.length === 0) return false;
        const cur = await db.execute(
          sql`SELECT done, status, verified, views, likes, reposts, replies FROM completions WHERE task_id = ${taskId} AND date = ${date} LIMIT 1`,
        );
        const curRow = cur.rows[0] as
          | { done: number; status: string | null; verified: number; views: number | null; likes: number | null; reposts: number | null; replies: number | null }
          | undefined;
        if (!posted && !curRow) {
          // Nothing recorded for this day: nothing to clear.
        } else if (
          !posted &&
          curRow &&
          curRow.status === null &&
          curRow.done === 0 &&
          !completionCarriesCheck(curRow as CompletionRow | undefined)
        ) {
          await db.execute(sql`DELETE FROM completions WHERE task_id = ${taskId} AND date = ${date}`);
        } else {
          await db.execute(sql`
            INSERT INTO completions (task_id, date, done, status, posted) VALUES (${taskId}, ${date}, ${curRow?.done ?? 0}, ${curRow?.status ?? null}, ${posted ? 1 : 0})
            ON CONFLICT (task_id, date) DO UPDATE SET posted = EXCLUDED.posted`);
        }
        const t = await db.execute(sql`SELECT repeat FROM tasks WHERE id = ${taskId} LIMIT 1`);
        const row = t.rows[0] as { repeat: number } | undefined;
        if (row && row.repeat === 0) {
          await db.execute(sql`UPDATE tasks SET posted = ${posted ? 1 : 0} WHERE id = ${taskId}`);
        }
        return true;
      });
      if (!owned) return res.status(400).json({ error: "Unknown task." });
      return res.status(200).json({ ok: true });
    }

    // setVerified: Rio's daily post check. The site cannot check X itself
    // (free API gives no post reads, no X login on the site), so Rio checks
    // the signed-in X tab and writes the result here. `source` records who
    // checked: "rio-check" for Rio, "manual" for a hand check. Only post
    // tasks can be verified.
    if (action === "setVerified") {
      const taskId = Number(args.taskId);
      const date = args.date;
      const verified = args.verified === true;
      const source = cleanSource(args.source);
      if (!Number.isInteger(taskId) || taskId <= 0 || !isValidDate(date)) {
        return res.status(400).json({ error: "Invalid task or date." });
      }
      const owned = await withDb(async (db) => {
        const own = await db.execute(
          sql`SELECT id, type FROM tasks WHERE id = ${taskId} AND user_id = ${userId} LIMIT 1`,
        );
        const t = own.rows[0] as { id: number; type: string } | undefined;
        if (!t) return "unknown";
        if (t.type !== "post") return "not-post";
        const cur = await db.execute(
          sql`SELECT ${sql.raw(COMPLETION_COLS)} FROM completions WHERE task_id = ${taskId} AND date = ${date} LIMIT 1`,
        );
        const curRow = cur.rows[0] as CompletionRow | undefined;
        const hasOther =
          (curRow?.status ?? null) !== null ||
          (curRow?.done ?? 0) === 1 ||
          (curRow?.posted ?? 0) === 1 ||
          curRow?.views != null ||
          curRow?.likes != null ||
          curRow?.reposts != null ||
          curRow?.replies != null;
        if (!verified && !hasOther) {
          await db.execute(sql`DELETE FROM completions WHERE task_id = ${taskId} AND date = ${date}`);
        } else {
          await db.execute(sql`
            INSERT INTO completions (task_id, date, done, status, posted, verified, verified_source) VALUES (${taskId}, ${date}, ${curRow?.done ?? 0}, ${curRow?.status ?? null}, ${curRow?.posted ?? 0}, ${verified ? 1 : 0}, ${verified ? source : null})
            ON CONFLICT (task_id, date) DO UPDATE SET verified = EXCLUDED.verified, verified_source = EXCLUDED.verified_source`);
        }
        return "ok";
      });
      if (owned === "unknown") return res.status(400).json({ error: "Unknown task." });
      if (owned === "not-post") return res.status(400).json({ error: "Only post tasks can be verified." });
      return res.status(200).json({ ok: true });
    }

    // setEngagement: per-post, per-day numbers. Fields omitted from the
    // request are left alone; null clears that number. Only post tasks.
    if (action === "setEngagement") {
      const taskId = Number(args.taskId);
      const date = args.date;
      const views = "views" in args ? cleanEngagement(args.views) : undefined;
      const likes = "likes" in args ? cleanEngagement(args.likes) : undefined;
      const reposts = "reposts" in args ? cleanEngagement(args.reposts) : undefined;
      const replies = "replies" in args ? cleanEngagement(args.replies) : undefined;
      if (
        !Number.isInteger(taskId) ||
        taskId <= 0 ||
        !isValidDate(date) ||
        views === "invalid" ||
        likes === "invalid" ||
        reposts === "invalid" ||
        replies === "invalid"
      ) {
        return res.status(400).json({ error: "Invalid task, date, or engagement numbers." });
      }
      const owned = await withDb(async (db) => {
        const own = await db.execute(
          sql`SELECT id, type FROM tasks WHERE id = ${taskId} AND user_id = ${userId} LIMIT 1`,
        );
        const t = own.rows[0] as { id: number; type: string } | undefined;
        if (!t) return "unknown";
        if (t.type !== "post") return "not-post";
        const cur = await db.execute(
          sql`SELECT ${sql.raw(COMPLETION_COLS)} FROM completions WHERE task_id = ${taskId} AND date = ${date} LIMIT 1`,
        );
        const curRow = cur.rows[0] as CompletionRow | undefined;
        const next = {
          views: views === undefined ? (curRow?.views ?? null) : views,
          likes: likes === undefined ? (curRow?.likes ?? null) : likes,
          reposts: reposts === undefined ? (curRow?.reposts ?? null) : reposts,
          replies: replies === undefined ? (curRow?.replies ?? null) : replies,
        };
        const hasOther =
          (curRow?.status ?? null) !== null ||
          (curRow?.done ?? 0) === 1 ||
          (curRow?.posted ?? 0) === 1 ||
          (curRow?.verified ?? 0) === 1;
        const hasEngagement =
          next.views != null || next.likes != null || next.reposts != null || next.replies != null;
        if (!hasOther && !hasEngagement) {
          await db.execute(sql`DELETE FROM completions WHERE task_id = ${taskId} AND date = ${date}`);
        } else {
          await db.execute(sql`
            INSERT INTO completions (task_id, date, done, status, posted, verified, verified_source, views, likes, reposts, replies) VALUES (${taskId}, ${date}, ${curRow?.done ?? 0}, ${curRow?.status ?? null}, ${curRow?.posted ?? 0}, ${curRow?.verified ?? 0}, ${curRow?.verified_source ?? null}, ${next.views}, ${next.likes}, ${next.reposts}, ${next.replies})
            ON CONFLICT (task_id, date) DO UPDATE SET views = EXCLUDED.views, likes = EXCLUDED.likes, reposts = EXCLUDED.reposts, replies = EXCLUDED.replies`);
        }
        return "ok";
      });
      if (owned === "unknown") return res.status(400).json({ error: "Unknown task." });
      if (owned === "not-post") return res.status(400).json({ error: "Only post tasks take engagement." });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
