// Tasks API: getDay / getMonth / getHistory / add / update / delete /
// setDone / setStatus. POST /api/tasks { action, ...args }
//
// Task status is THREE-state per day: done, missed, pending.
// `completions` stores an explicit status ('done' | 'missed'); no row
// means pending. `tasks.done` mirrors the latest toggle for one-off
// dated tasks only.

import { sql } from "drizzle-orm";
import { withDb, ensureStarterProjects, loadChat, isValidDate, isValidTime } from "./_db";
import type { Db, EventRole, ProjectColor, TaskKind, TaskStatus } from "./_db";

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
};

type ProjectRow = { id: number; name: string; color: string; link: string | null; note: string | null };

type CompletionRow = { task_id: number; date: string; done: number; status: string | null };

function cleanKind(k: unknown): TaskKind {
  return KINDS.includes(k as TaskKind) ? (k as TaskKind) : "task";
}

function cleanEventRole(v: unknown): EventRole | null {
  return v === "join" || v === "host" ? v : null;
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

function toDayTask(
  r: TaskRow,
  proj: { name: string; color: ProjectColor } | undefined,
  status: TaskStatus,
) {
  return {
    id: r.id,
    title: r.title,
    kind: r.type as TaskKind,
    time: r.time,
    recurring: r.repeat === 1,
    projectId: r.project_id,
    projectName: proj?.name ?? null,
    projectColor: proj?.color ?? null,
    done: status === "done",
    status,
    postLink: r.post_link ?? null,
    details: r.details ?? null,
    eventRole: (r.event_role === "join" || r.event_role === "host" ? r.event_role : null) as EventRole | null,
    remind: r.remind !== 0,
  };
}

async function loadProjects(db: Db) {
  const projRes = await db.execute(
    sql`SELECT id, name, color, link, note FROM projects ORDER BY id ASC`,
  );
  const projects = (projRes.rows as ProjectRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color as ProjectColor,
    link: r.link ?? null,
    note: r.note ?? null,
  }));
  return { projects, byId: new Map(projects.map((p) => [p.id, p])) };
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action, ...args } = body;

    if (action === "getDay") {
      const date = args.date;
      if (!isValidDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
      await ensureStarterProjects();
      const out = await withDb(async (db) => {
        const { projects, byId } = await loadProjects(db);
        const taskRes = await db.execute(
          sql`SELECT id, title, type, time, repeat, done, date, project_id, post_link, details, event_role, remind FROM tasks WHERE repeat = 1 OR date = ${date} ORDER BY time ASC NULLS FIRST, id ASC`,
        );
        const rows = taskRes.rows as TaskRow[];
        const compByTask = new Map<number, CompletionRow>();
        if (rows.length > 0) {
          const compRes = await db.execute(
            sql`SELECT task_id, date, done, status FROM completions WHERE date = ${date}`,
          );
          for (const c of compRes.rows as CompletionRow[]) compByTask.set(c.task_id, c);
        }
        const chat = await loadChat(db, date);
        return {
          date,
          projects,
          tasks: rows.map((r) => {
            const proj = r.project_id != null ? byId.get(r.project_id) : undefined;
            return toDayTask(r, proj, statusOf(compByTask.get(r.id)));
          }),
          chat,
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
        const recRes = await db.execute(sql`SELECT COUNT(*)::int AS n FROM tasks WHERE repeat = 1`);
        const recurringCount = (recRes.rows[0] as { n: number }).n;
        const taskRes = await db.execute(
          sql`SELECT id, repeat, date FROM tasks WHERE date LIKE ${month + "%"} OR repeat = 1`,
        );
        const compRes = await db.execute(
          sql`SELECT task_id, date, done, status FROM completions WHERE date LIKE ${month + "%"}`,
        );
        const taskById = new Map(
          (taskRes.rows as { id: number; repeat: number; date: string | null }[]).map((t) => [t.id, t]),
        );
        const totals = new Map<string, { total: number; done: number }>();
        const entryFor = (d: string) => {
          const e = totals.get(d) ?? { total: 0, done: 0 };
          totals.set(d, e);
          return e;
        };
        for (const t of taskById.values()) {
          if (t.repeat === 1 || !t.date) continue;
          entryFor(t.date).total += 1;
        }
        for (const c of compRes.rows as CompletionRow[]) {
          if (statusOf(c) !== "done") continue;
          const t = taskById.get(c.task_id);
          if (!t) continue;
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
      await ensureStarterProjects();
      const out = await withDb(async (db) => {
        const { byId } = await loadProjects(db);
        const taskRes = await db.execute(
          sql`SELECT id, title, type, time, repeat, done, date, project_id, post_link, details, event_role, remind FROM tasks WHERE repeat = 1 OR (date >= ${from} AND date <= ${to}) ORDER BY time ASC NULLS FIRST, id ASC`,
        );
        const rows = taskRes.rows as TaskRow[];
        const compRes = await db.execute(
          sql`SELECT task_id, date, done, status FROM completions WHERE date >= ${from} AND date <= ${to}`,
        );
        const compByKey = new Map<string, CompletionRow>();
        for (const c of compRes.rows as CompletionRow[]) compByKey.set(`${c.task_id}|${c.date}`, c);
        const chatRes = await db.execute(
          sql`SELECT date, sent, target FROM chat_days WHERE date >= ${from} AND date <= ${to}`,
        );
        const chatByDate = new Map(
          (chatRes.rows as { date: string; sent: number; target: number }[]).map((c) => [
            c.date,
            { target: c.target, sent: c.sent },
          ]),
        );
        const days: { date: string; tasks: ReturnType<typeof toDayTask>[]; chat: { target: number; sent: number } }[] = [];
        for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
          const key = d.toISOString().slice(0, 10);
          const dayTasks = rows
            .filter((r) => r.repeat === 1 || r.date === key)
            .map((r) => {
              const proj = r.project_id != null ? byId.get(r.project_id) : undefined;
              return toDayTask(r, proj, statusOf(compByKey.get(`${r.id}|${key}`)));
            });
          const chat = chatByDate.get(key) ?? (await loadChat(db, key));
          if (dayTasks.length > 0 || chatByDate.has(key)) {
            days.push({ date: key, tasks: dayTasks, chat });
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
      const id = await withDb(async (db) => {
        const r = await db.execute(
          sql`INSERT INTO tasks (project_id, title, time, type, repeat, done, date, post_link, details, event_role, remind) VALUES (${projectId}, ${title}, ${time}, ${kind}, ${recurring ? 1 : 0}, 0, ${date}, ${postLink}, ${details}, ${eventRole}, ${remind}) RETURNING id`,
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
      await withDb(async (db) => {
        await db.execute(
          sql`UPDATE tasks SET project_id = ${projectId}, title = ${title}, time = ${time}, type = ${kind}, repeat = ${recurring ? 1 : 0}, date = ${date}, post_link = ${postLink}, details = ${details}, event_role = ${eventRole}, remind = ${remind} WHERE id = ${id}`,
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
        await db.execute(sql`DELETE FROM tasks WHERE id = ${id}`);
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
      // status 'done' | 'missed' | null (null = back to pending, row removed).
      let status: TaskStatus | null;
      if (action === "setDone") {
        status = args.done === true ? "done" : null;
      } else if (args.status === "done" || args.status === "missed") {
        status = args.status;
      } else {
        status = null;
      }
      await withDb(async (db) => {
        if (status === null) {
          await db.execute(sql`DELETE FROM completions WHERE task_id = ${taskId} AND date = ${date}`);
        } else {
          await db.execute(sql`
            INSERT INTO completions (task_id, date, done, status) VALUES (${taskId}, ${date}, ${status === "done" ? 1 : 0}, ${status})
            ON CONFLICT (task_id, date) DO UPDATE SET done = EXCLUDED.done, status = EXCLUDED.status`);
        }
        // Keep the tasks.done mirror in sync for one-off dated tasks.
        const t = await db.execute(sql`SELECT repeat FROM tasks WHERE id = ${taskId} LIMIT 1`);
        const row = t.rows[0] as { repeat: number } | undefined;
        if (row && row.repeat === 0) {
          await db.execute(sql`UPDATE tasks SET done = ${status === "done" ? 1 : 0} WHERE id = ${taskId}`);
        }
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
