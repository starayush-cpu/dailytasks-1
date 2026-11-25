// Discord chat tracker API: get / setTarget / setSent / rollover.
// POST /api/chat { action, ...args }

import { sql } from "drizzle-orm";
import { withDb, loadChat, upsertChat, todayInKolkata, isValidDate } from "./_db";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action, ...args } = body;

    if (action === "get") {
      const date = args.date;
      if (!isValidDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
      const chat = await withDb(async (db) => loadChat(db, date));
      return res.status(200).json(chat);
    }

    if (action === "setTarget") {
      const date = args.date;
      const target = Number(args.target);
      if (!isValidDate(date) || !Number.isInteger(target) || target < 1 || target > 1000) {
        return res.status(400).json({ error: "Invalid date or target (1-1000)." });
      }
      await withDb(async (db) => {
        const current = await loadChat(db, date);
        await upsertChat(db, date, target, current.sent);
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
        const current = await loadChat(db, date);
        await upsertChat(db, date, current.target, sent);
      });
      return res.status(200).json({ ok: true });
    }

    if (action === "rollover") {
      const out = await withDb(async (db) => {
        const today = todayInKolkata();
        const chat = await loadChat(db, today);
        await db.execute(sql`
          INSERT INTO chat_days (date, target, sent) VALUES (${today}, ${chat.target}, ${chat.sent})
          ON CONFLICT (date) DO NOTHING`);
        const rec = await db.execute(sql`SELECT COUNT(*)::int AS n FROM tasks WHERE repeat = 1`);
        return { date: today, target: chat.target, recurringTasks: (rec.rows[0] as { n: number }).n };
      });
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: `Unknown action: ${String(action)}` });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
