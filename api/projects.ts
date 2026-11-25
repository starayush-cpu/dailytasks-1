// Projects API: list / add / update / delete.
// POST /api/projects { action, ...args }

import { sql } from "drizzle-orm";
import { withDb, ensureStarterProjects } from "./_db";
import type { ProjectColor } from "./_db";

const COLORS: ProjectColor[] = ["blue", "violet", "green", "orange", "pink", "teal"];

type Row = { id: number; name: string; color: string; link: string | null; note: string | null };

function toProject(r: Row) {
  return { id: r.id, name: r.name, color: r.color, link: r.link ?? null, note: r.note ?? null };
}

function cleanColor(c: unknown): ProjectColor {
  return COLORS.includes(c as ProjectColor) ? (c as ProjectColor) : "blue";
}

function cleanStr(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.slice(0, max);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action, ...args } = body;

    if (action === "list") {
      await ensureStarterProjects();
      const projects = await withDb(async (db) => {
        const r = await db.execute(
          sql`SELECT id, name, color, link, note FROM projects ORDER BY id ASC`,
        );
        return (r.rows as Row[]).map(toProject);
      });
      return res.status(200).json({ projects });
    }

    if (action === "add") {
      const name = String(args.name ?? "").trim();
      if (!name || name.length > 60) {
        return res.status(400).json({ error: "Project name is required (max 60 chars)." });
      }
      const color = cleanColor(args.color);
      const link = cleanStr(args.link, 300);
      const note = cleanStr(args.note, 200);
      const id = await withDb(async (db) => {
        const r = await db.execute(
          sql`INSERT INTO projects (name, color, link, note) VALUES (${name}, ${color}, ${link}, ${note}) RETURNING id`,
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
      await withDb(async (db) => {
        await db.execute(
          sql`UPDATE projects SET name = ${name}, color = ${color}, link = ${link}, note = ${note} WHERE id = ${id}`,
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
        await db.execute(sql`UPDATE tasks SET project_id = NULL WHERE project_id = ${id}`);
        await db.execute(sql`DELETE FROM projects WHERE id = ${id}`);
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
