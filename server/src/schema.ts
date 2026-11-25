import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  color: text("color", {
    enum: ["blue", "violet", "green", "orange", "pink", "teal"],
  })
    .notNull()
    .default("blue"),
  link: text("link"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id"),
  title: text("title").notNull(),
  kind: text("kind", { enum: ["task", "post", "discord"] })
    .notNull()
    .default("task"),
  // Local wall-clock "HH:MM", null = no fixed time.
  time: text("time"),
  // "YYYY-MM-DD" for one-off tasks; null when the task repeats every day.
  date: text("date"),
  recurring: integer("recurring").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const completions = sqliteTable(
  "completions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    date: text("date").notNull(),
    done: integer("done").notNull().default(1),
  },
  (t) => [uniqueIndex("completions_task_date").on(t.taskId, t.date)],
);

export const chatDays = sqliteTable("chat_days", {
  date: text("date").primaryKey(),
  target: integer("target").notNull().default(50),
  sent: integer("sent").notNull().default(0),
});
