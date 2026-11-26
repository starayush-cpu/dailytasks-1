// Discord chat tracker API: get / setTarget / setSent / rollover /
// getProjectChat / logProjectChat / setProjectTarget / setProjectSent.
// POST /api/chat { action, userId, ...args }
//
// The global daily total (chat_days) stays. Per-project rows
// (project_chat_days) track chats per project per day; logging a project
// chat also bumps the global total, so the global number is the true
// daily total and the per-project rows are its breakdown.

import { sql } from "drizzle-orm";
import {
  withDb,
  ensureUser,
  loadChat,
  upsertChat,
  getProjectChat,
  logProjectChat,
  setProjectTarget,
  setProjectSent,
  todayInKolkata,
  isValidDate,
  cleanUserId,
} from "./_db.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action, ...args } = body;
    const userId = cleanUserId(args.userId);
    await ensureUser(userId);

    if (action === "get") {
      const date = args.date;
      if (!isValidDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
      const out = await withDb(async (db) => {
        const chat = await loadChat(db, userId, date);
        const projectChat = await getProjectChat(db, userId, date);
        return { ...chat, projectChat };
      });
      return res.status(200).json(out);
    }

    if (action === "setTarget") {
      const date = args.date;
      const target = Number(args.target);
      if (!isValidDate(date) || !Number.isInteger(target) || target < 1 || target > 1000) {
        return res.status(400).json({ error: "Invalid date or target (1-1000)." });
      }
      await withDb(async (db) => {
        const current = await loadChat(db, userId, date);
        await upsertChat(db, userId, date, target, current.sent);
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "setSent") {
      const date = args.date;
      const sent = Number(args.sent);
      if (!isValidDate(date) || !Number.isInteger(sent) || sent < 0 || sent > 100000) {
        return res.status(400).json({ error: "Invalid date or sent count." });
      }
      await withDb(async (db) => {
        const current = await loadChat(db, userId, date);
        await upsertChat(db, userId, date, current.target, sent);
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "getProjectChat") {
      const date = args.date;
      if (!isValidDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
      const projectChat = await withDb(async (db) => getProjectChat(db, userId, date));
      return res.status(200).json({ projectChat });
    }

    if (action === "logProjectChat") {
      const date = args.date;
      const projectId = Number(args.projectId);
      const delta = Number(args.delta ?? 1);
      if (!isValidDate(date) || !Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(delta)) {
        return res.status(400).json({ error: "Invalid project chat log." });
      }
      const out = await withDb(async (db) => {
        const owns = await db.execute(
          sql`SELECT id FROM projects WHERE id = ${projectId} AND user_id = ${userId} LIMIT 1`,
        );
        if (owns.rows.length === 0) throw new Error("Unknown project.");
        return logProjectChat(db, userId, date, projectId, delta);
      });
      return res.status(200).json(out);
    }

    if (action === "setProjectTarget") {
      const date = args.date;
      const projectId = Number(args.projectId);
      const target = Number(args.target);
      if (!isValidDate(date) || !Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(target) || target < 0 || target > 1000) {
        return res.status(400).json({ error: "Invalid project target." });
      }
      await withDb(async (db) => {
        const owns = await db.execute(
          sql`SELECT id FROM projects WHERE id = ${projectId} AND user_id = ${userId} LIMIT 1`,
        );
        if (owns.rows.length === 0) throw new Error("Unknown project.");
        await setProjectTarget(db, userId, date, projectId, target);
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "setProjectSent") {
      const date = args.date;
      const projectId = Number(args.projectId);
      const sent = Number(args.sent);
      if (!isValidDate(date) || !Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(sent) || sent < 0 || sent > 100000) {
        return res.status(400).json({ error: "Invalid project sent count." });
      }
      await withDb(async (db) => {
        const owns = await db.execute(
          sql`SELECT id FROM projects WHERE id = ${projectId} AND user_id = ${userId} LIMIT 1`,
        );
        if (owns.rows.length === 0) throw new Error("Unknown project.");
        await setProjectSent(db, userId, date, projectId, sent);
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "rollover") {
      const out = await withDb(async (db) => {
        const today = todayInKolkata();
        const chat = await loadChat(db, userId, today);
        await db.execute(sql`
          INSERT INTO chat_days (user_id, date, target, sent) VALUES (${userId}, ${today}, ${chat.target}, ${chat.sent})
          ON CONFLICT (user_id, date) DO NOTHING`);
        const rec = await db.execute(
          sql`SELECT COUNT(*)::int AS n FROM tasks WHERE user_id = ${userId} AND repeat = 1`,
        );
        return { date: today, target: chat.target, recurringTasks: (rec.rows[0] as { n: number }).n };
      });
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
