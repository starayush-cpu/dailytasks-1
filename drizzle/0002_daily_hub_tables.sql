DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  link TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task',
  time TEXT,
  date TEXT,
  recurring INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX completions_task_date ON completions (task_id, date);
--> statement-breakpoint
CREATE TABLE chat_days (
  date TEXT PRIMARY KEY,
  target INTEGER NOT NULL DEFAULT 50,
  sent INTEGER NOT NULL DEFAULT 0
);
