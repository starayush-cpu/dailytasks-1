// Projects API: list / add / update / delete / setEnded.
// POST /api/projects { action, userId, ...args }

import { sql } from "drizzle-orm";
import { withDb, ensureUser, ensureStarterProjects, cleanUserId } from "./_db.js";
import type { ProjectColor } from "./_db.js";

const COLORS: ProjectColor[] = ["blue", "violet", "green", "orange", "pink", "teal"];

type Row = {
  id: number;
  name: string;
  color: string;
  link: string | null;
  note: string | null;
  logo: string | null;
  ended: number;
};

function toProject(r: Row) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    link: r.link ?? null,
    note: r.note ?? null,
    logo: r.logo ?? null,
    ended: r.ended === 1,
  };
}

function cleanColor(c: unknown): ProjectColor {
  return COLORS.includes(c as ProjectColor) ? (c as ProjectColor) : "blue";
}

function cleanStr(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.slice(0, max);
}

function cleanLogo(v: unknown): string | null {
  const s = cleanStr(v, 500);
  if (!s) return null;
  if (!/^(\.\/|https?:\/\/|data:image\/)/.test(s)) return null;
  return s;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action, ...args } = body;
    const userId = cleanUserId(args.userId);
    await ensureUser(userId);

    if (action === "list") {
      await ensureStarterProjects(userId);
      const projects = await withDb(async (db) => {
        const r = await db.execute(
          sql`SELECT id, name, color, link, note, logo, ended FROM projects WHERE user_id = ${userId} ORDER BY ended ASC, id ASC`,
        );
        return (r.rows as Row[]).map(toProject);
      });
      return res.status(200).json({ projects });
    }

    if (action === "seed") {
      const inserted = await ensureStarterProjects(userId);
      return res.status(200).json({ inserted });
    }

    if (action === "add") {
      const name = String(args.name ?? "").trim();
      if (!name || name.length > 60) {
        return res.status(400).json({ error: "Project name is required (max 60 chars)." });
      }
      const color = cleanColor(args.color);
      const link = cleanStr(args.link, 300);
      const note = cleanStr(args.note, 200);
      const logo = cleanLogo(args.logo);
      const id = await withDb(async (db) => {
        const r = await db.execute(
          sql`INSERT INTO projects (user_id, name, color, link, note, logo, ended) VALUES (${userId}, ${name}, ${color}, ${link}, ${note}, ${logo}, 0) RETURNING id`,
        );
        return (r.rows[0] as { id: number }).id;
      });
      return res.status(200).json({ id });
    }

    if (action === "update") {
      const id = Number(args.id);
      const name = String(args.name ?? "").trim();
      if (!Number.isInteger(id) || id <= 0 || !name || name.length > 60) {
        return res.status(400).json({ error: "Invalid project." });
      }
      const color = cleanColor(args.color);
      const link = cleanStr(args.link, 300);
      const note = cleanStr(args.note, 200);
      const logo = cleanLogo(args.logo);
      const ended = args.ended === true ? 1 : 0;
      await withDb(async (db) => {
        await db.execute(
          sql`UPDATE projects SET name = ${name}, color = ${color}, link = ${link}, note = ${note}, logo = ${logo}, ended = ${ended} WHERE id = ${id} AND user_id = ${userId}`,
        );
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "setEnded") {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid project id." });
      }
      const ended = args.ended === true ? 1 : 0;
      await withDb(async (db) => {
        await db.execute(
          sql`UPDATE projects SET ended = ${ended} WHERE id = ${id} AND user_id = ${userId}`,
        );
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid project id." });
      }
      await withDb(async (db) => {
        await db.execute(sql`UPDATE tasks SET project_id = NULL WHERE project_id = ${id} AND user_id = ${userId}`);
        await db.execute(sql`DELETE FROM projects WHERE id = ${id} AND user_id = ${userId}`);
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
