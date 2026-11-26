// Users API: list / add / update / delete.
// POST /api/users { action, ...args }
//
// No passwords or auth: local profiles on this site. Ayush is user 1,
// the default user. Every user owns their own projects, tasks,
// completions and chat counts; deleting a user deletes all of their data.

import { sql } from "drizzle-orm";
import { withDb, ensureUser, cleanUserId, listUsers } from "./_db.js";

function cleanStr(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.slice(0, max);
}

function cleanPhoto(v: unknown): string | null {
  const s = cleanStr(v, 500);
  if (!s) return null;
  if (!/^(\.\/|https?:\/\/)/.test(s)) return null;
  return s;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action, ...args } = body;

    if (action === "list") {
      await ensureUser(1);
      const users = await listUsers();
      return res.status(200).json({ users });
    }

    if (action === "add") {
      const name = String(args.name ?? "").trim();
      if (!name || name.length > 60) {
        return res.status(400).json({ error: "Name is required (max 60 chars)." });
      }
      const photo = cleanPhoto(args.photo);
      const id = await withDb(async (db) => {
        const r = await db.execute(
          sql`INSERT INTO users (name, photo) VALUES (${name}, ${photo}) RETURNING id`,
        );
        return (r.rows[0] as { id: number }).id;
      });
      return res.status(200).json({ id });
    }

    if (action === "update") {
      const id = cleanUserId(args.id);
      const name = String(args.name ?? "").trim();
      if (!name || name.length > 60) {
        return res.status(400).json({ error: "Name is required (max 60 chars)." });
      }
      const photo = cleanPhoto(args.photo);
      await ensureUser(id);
      await withDb(async (db) => {
        await db.execute(sql`UPDATE users SET name = ${name}, photo = ${photo} WHERE id = ${id}`);
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      const id = cleanUserId(args.id);
      const users = await listUsers();
      if (users.length <= 1) {
        return res.status(400).json({ error: "Cannot delete the last user." });
      }
      if (!users.some((u) => u.id === id)) {
        return res.status(400).json({ error: "Unknown user." });
      }
      await withDb(async (db) => {
        await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
