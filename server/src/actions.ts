import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, or } from "drizzle-orm";
import * as schema from "./schema";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

const dateStr = z.string().regex(dateRe, "Date must be YYYY-MM-DD");
const timeStr = z
  .string()
  .regex(timeRe, "Time must be HH:MM")
  .nullable()
  .optional();

const projectColor = z.enum(["blue", "violet", "green", "orange", "pink", "teal"]);
const taskKind = z.enum(["task", "post", "discord"]);

const projectOut = z.object({
  id: z.number(),
  name: z.string(),
  color: projectColor,
  link: z.string().nullable(),
  note: z.string().nullable(),
});

const dayTaskOut = z.object({
  id: z.number(),
  title: z.string(),
  kind: taskKind,
  time: z.string().nullable(),
  recurring: z.boolean(),
  projectId: z.number().nullable(),
  projectName: z.string().nullable(),
  projectColor: projectColor.nullable(),
  done: z.boolean(),
});

const chatOut = z.object({
  target: z.number(),
  sent: z.number(),
});

function todayInKolkata(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function loadProjects(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.projects)
    .orderBy(asc(schema.projects.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    link: r.link,
    note: r.note,
  }));
}

async function loadChat(ctx: Ctx, date: string) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.chatDays)
    .where(eq(schema.chatDays.date, date))
    .limit(1);
  const row = rows[0];
  if (row) return { target: row.target, sent: row.sent };
  // Carry the most recent earlier target forward so the goal survives day changes.
  const prior = await db
    .select()
    .from(schema.chatDays)
    .orderBy(desc(schema.chatDays.date))
    .limit(1);
  return { target: prior[0]?.target ?? 50, sent: 0 };
}

export const Actions = {
  getDay: defineAction({
    description:
      "Returns one day's schedule: projects, timed tasks and posts with done state for the date, and the Discord chat target progress.",
    request: z.object({ date: dateStr }),
    response: z.object({
      date: z.string(),
      projects: z.array(projectOut),
      tasks: z.array(dayTaskOut),
      chat: chatOut,
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const projects = await loadProjects(ctx);
      const byId = new Map(projects.map((p) => [p.id, p]));
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(
          or(
            eq(schema.tasks.recurring, 1),
            eq(schema.tasks.date, args.date),
          ),
        )
        .orderBy(asc(schema.tasks.time), asc(schema.tasks.id));
      const taskIds = rows.map((r) => r.id);
      const doneSet = new Set<number>();
      if (taskIds.length > 0) {
        const comps = await db
          .select()
          .from(schema.completions)
          .where(eq(schema.completions.date, args.date));
        for (const c of comps) {
          if (c.done === 1 && taskIds.includes(c.taskId)) doneSet.add(c.taskId);
        }
      }
      const chat = await loadChat(ctx, args.date);
      return {
        date: args.date,
        projects,
        tasks: rows.map((r) => {
          const proj = r.projectId != null ? byId.get(r.projectId) : undefined;
          return {
            id: r.id,
            title: r.title,
            kind: r.kind,
            time: r.time,
            recurring: r.recurring === 1,
            projectId: r.projectId,
            projectName: proj?.name ?? null,
            projectColor: proj?.color ?? null,
            done: doneSet.has(r.id),
          };
        }),
        chat,
      };
    },
  }),

  getMonth: defineAction({
    description:
      "Returns per-day task totals and completions for every day of a month that has one-off tasks, plus which days have any recurring tasks.",
    request: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }),
    response: z.object({
      days: z.array(
        z.object({
          date: z.string(),
          total: z.number(),
          done: z.number(),
        }),
      ),
      recurringCount: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const recurring = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.recurring, 1));
      const dated = await db.select().from(schema.tasks);
      const comps = await db.select().from(schema.completions);
      const taskById = new Map(dated.map((t) => [t.id, t]));
      const totals = new Map<string, { total: number; done: number }>();
      const entryFor = (date: string) => {
        const entry = totals.get(date) ?? { total: 0, done: 0 };
        totals.set(date, entry);
        return entry;
      };
      for (const t of dated) {
        if (t.recurring === 1 || !t.date || !t.date.startsWith(args.month)) {
          continue;
        }
        entryFor(t.date).total += 1;
      }
      for (const c of comps) {
        if (c.done !== 1 || !c.date.startsWith(args.month)) continue;
        const t = taskById.get(c.taskId);
        if (!t) continue;
        if (t.recurring === 1 || t.date === c.date) entryFor(c.date).done += 1;
      }
      return {
        days: [...totals.entries()].map(([date, v]) => ({
          date,
          total: v.total,
          done: v.done,
        })),
        recurringCount: recurring.length,
      };
    },
  }),

  addProject: defineAction({
    description: "Adds a project with a name, color tag, and optional link and note.",
    request: z.object({
      name: z.string().trim().min(1).max(60),
      color: projectColor.default("blue"),
      link: z.string().trim().max(300).optional(),
      note: z.string().trim().max(200).optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.projects)
        .values({
          name: args.name,
          color: args.color,
          link: args.link?.trim() ? args.link.trim() : null,
          note: args.note?.trim() ? args.note.trim() : null,
        })
        .returning({ id: schema.projects.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addProject: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateProject: defineAction({
    description: "Edits a project's name, color tag, link, or note.",
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(60),
      color: projectColor,
      link: z.string().trim().max(300).nullable(),
      note: z.string().trim().max(200).nullable(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.projects)
        .set({
          name: args.name,
          color: args.color,
          link: args.link?.trim() ? args.link.trim() : null,
          note: args.note?.trim() ? args.note.trim() : null,
        })
        .where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteProject: defineAction({
    description:
      "Deletes a project. Its tasks stay on the schedule but lose the project tag.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.tasks)
        .set({ projectId: null })
        .where(eq(schema.tasks.projectId, args.id));
      await db
        .delete(schema.projects)
        .where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addTask: defineAction({
    description:
      "Adds a timed task, post, or Discord item to a date, or as an every-day recurring item.",
    request: z.object({
      title: z.string().trim().min(1).max(120),
      kind: taskKind.default("task"),
      time: timeStr,
      projectId: z.number().int().positive().nullable().optional(),
      date: dateStr.nullable().optional(),
      recurring: z.boolean().default(false),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.tasks)
        .values({
          title: args.title,
          kind: args.kind,
          time: args.time ?? null,
          projectId: args.projectId ?? null,
          date: args.recurring ? null : (args.date ?? null),
          recurring: args.recurring ? 1 : 0,
        })
        .returning({ id: schema.tasks.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addTask: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateTask: defineAction({
    description: "Edits a task's title, kind, time, project, date, or recurrence.",
    request: z.object({
      id: z.number().int().positive(),
      title: z.string().trim().min(1).max(120),
      kind: taskKind,
      time: timeStr,
      projectId: z.number().int().positive().nullable(),
      date: dateStr.nullable(),
      recurring: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.tasks)
        .set({
          title: args.title,
          kind: args.kind,
          time: args.time ?? null,
          projectId: args.projectId ?? null,
          date: args.recurring ? null : args.date,
          recurring: args.recurring ? 1 : 0,
        })
        .where(eq(schema.tasks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteTask: defineAction({
    description: "Deletes a task and its completion history.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.completions)
        .where(eq(schema.completions.taskId, args.id));
      await db.delete(schema.tasks).where(eq(schema.tasks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setTaskDone: defineAction({
    description: "Marks a task done or not done for one specific date.",
    request: z.object({
      taskId: z.number().int().positive(),
      date: dateStr,
      done: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.completions)
        .where(
          and(
            eq(schema.completions.taskId, args.taskId),
            eq(schema.completions.date, args.date),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await db
          .update(schema.completions)
          .set({ done: args.done ? 1 : 0 })
          .where(eq(schema.completions.id, existing[0].id));
      } else {
        await db.insert(schema.completions).values({
          taskId: args.taskId,
          date: args.date,
          done: args.done ? 1 : 0,
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setChatTarget: defineAction({
    description: "Sets the Discord daily chat message target for a date.",
    request: z.object({
      date: dateStr,
      target: z.number().int().min(1).max(1000),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const current = await loadChat(ctx, args.date);
      await db
        .insert(schema.chatDays)
        .values({ date: args.date, target: args.target, sent: current.sent })
        .onConflictDoUpdate({
          target: schema.chatDays.date,
          set: { target: args.target },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setChatSent: defineAction({
    description: "Sets how many Discord chat messages have been sent on a date.",
    request: z.object({
      date: dateStr,
      sent: z.number().int().min(0).max(100000),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const current = await loadChat(ctx, args.date);
      await db
        .insert(schema.chatDays)
        .values({ date: args.date, target: current.target, sent: args.sent })
        .onConflictDoUpdate({
          target: schema.chatDays.date,
          set: { sent: args.sent },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  ensureStarterProjects: defineAction({
    description:
      "Seeds the user's three named projects (Fermah, Dlicom, Primus) only when the projects list is completely empty; never overwrites or resurrects user edits.",
    request: z.object({}),
    response: z.object({ inserted: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.projects).limit(1);
      if (existing.length > 0) return { inserted: 0 };
      const starters: { name: string; color: "violet" | "blue" | "teal" }[] = [
        { name: "Fermah", color: "violet" },
        { name: "Dlicom", color: "blue" },
        { name: "Primus", color: "teal" },
      ];
      for (const s of starters) {
        await db.insert(schema.projects).values({ name: s.name, color: s.color });
      }
      ctx.invalidateQueries();
      return { inserted: starters.length };
    },
  }),

  rolloverDay: defineAction({
    description:
      "Daily rollover: prepares today (Asia/Kolkata) by carrying the Discord chat target forward to a fresh day row; recurring tasks automatically appear unchecked on the new date and past days stay as history.",
    request: z.object({}),
    response: z.object({
      date: z.string(),
      target: z.number(),
      recurringTasks: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const today = todayInKolkata();
      const chat = await loadChat(ctx, today);
      await db
        .insert(schema.chatDays)
        .values({ date: today, target: chat.target, sent: chat.sent })
        .onConflictDoNothing();
      const recurring = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.recurring, 1));
      ctx.invalidateQueries();
      return { date: today, target: chat.target, recurringTasks: recurring.length };
    },
  }),
} satisfies ActionsModule;
