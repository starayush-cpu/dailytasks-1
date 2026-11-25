// Tasks API: getDay / getMonth / add / update / delete / setDone.
// POST /api/tasks { action, ...args }

import { sql } from "drizzle-orm";
import { withDb, ensureStarterProjects, loadChat, isValidDate, isValidTime } from "./_db";
import type { ProjectColor, TaskKind } from "./_db";

const KINDS: TaskKind[] = ["task", "post", "discord"];

type TaskRow = {
  id: number;
  title: string;
  type: string;
  time: string | null;
  repeat: number;
  done: number;
  date: string | null;
  project_id: number | null;
};

type ProjectRow = { id: number; name: string; color: string; link: string | null; note: string | null };

function cleanKind(k: unknown): TaskKind {
  return KINDS.includes(k as TaskKind) ? (k as TaskKind) : "task";
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
        const byId = new Map(projects.map((p) => [p.id, p]));
        const taskRes = await db.execute(
          sql`SELECT id, title, type, time, repeat, done, date, project_id FROM tasks WHERE repeat = 1 OR date = ${date} ORDER BY time ASC NULLS FIRST, id ASC`,
        );
        const rows = taskRes.rows as TaskRow[];
        const ids = rows.map((r) => r.id);
        const doneSet = new Set<number>();
        if (ids.length > 0) {
          const compRes = await db.execute(
            sql`SELECT task_id FROM completions WHERE date = ${date} AND done = 1`,
          );
          for (const c of compRes.rows as { task_id: number }[]) {
            if (ids.includes(c.task_id)) doneSet.add(c.task_id);
          }
        }
        const chat = await loadChat(db, date);
        return {
          date,
          projects,
          tasks: rows.map((r) => {
            const proj = r.project_id != null ? byId.get(r.project_id) : undefined;
            return {
              id: r.id,
              title: r.title,
              kind: r.type as TaskKind,
              time: r.time,
              recurring: r.repeat === 1,
              projectId: r.project_id,
              projectName: proj?.name ?? null,
              projectColor: proj?.color ?? null,
              done: doneSet.has(r.id),
            };
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
          sql`SELECT task_id, date FROM completions WHERE date LIKE ${month + "%"} AND done = 1`,
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
        for (const c of compRes.rows as { task_id: number; date: string }[]) {
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
      const id = await withDb(async (db) => {
        const r = await db.execute(
          sql`INSERT INTO tasks (project_id, title, time, type, repeat, done, date) VALUES (${projectId}, ${title}, ${time}, ${kind}, ${recurring ? 1 : 0}, 0, ${date}) RETURNING id`,
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
      await withDb(async (db) => {
        await db.execute(
          sql`UPDATE tasks SET project_id = ${projectId}, title = ${title}, time = ${time}, type = ${kind}, repeat = ${recurring ? 1 : 0}, date = ${date} WHERE id = ${id}`,
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

    if (action === "setDone") {
      const taskId = Number(args.taskId);
      const date = args.date;
      const done = args.done === true;
      if (!Number.isInteger(taskId) || taskId <= 0 || !isValidDate(date)) {
        return res.status(400).json({ error: "Invalid task or date." });
      }
      await withDb(async (db) => {
        await db.execute(sql`
          INSERT INTO completions (task_id, date, done) VALUES (${taskId}, ${date}, ${done ? 1 : 0})
          ON CONFLICT (task_id, date) DO UPDATE SET done = EXCLUDED.done`);
        // Keep the tasks.done mirror in sync for one-off dated tasks.
        const t = await db.execute(sql`SELECT repeat FROM tasks WHERE id = ${taskId} LIMIT 1`);
        const row = (t.rows[0] as { repeat: number } | undefined);
        if (row && row.repeat === 0) {
          await db.execute(sql`UPDATE tasks SET done = ${done ? 1 : 0} WHERE id = ${taskId}`);
        }
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
