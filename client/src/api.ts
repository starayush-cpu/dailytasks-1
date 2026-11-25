// Typed API client for the Daily Hub static build.
//
// Every method first tries the Vercel Postgres serverless routes under
// /api (api/projects.ts, api/tasks.ts, api/chat.ts). If the API call fails
// (e.g. no Postgres database is linked yet, so POSTGRES_URL is unset),
// it falls back to a localStorage store with the same shape, so the page
// still works. Once the database is linked, the API answers and the
// server data is used.

export type ProjectColor = "blue" | "violet" | "green" | "orange" | "pink" | "teal";
export type TaskKind = "task" | "post" | "discord";

export type Project = {
  id: number;
  name: string;
  color: ProjectColor;
  link: string | null;
  note: string | null;
};

export type DayTask = {
  id: number;
  title: string;
  kind: TaskKind;
  time: string | null;
  recurring: boolean;
  projectId: number | null;
  projectName: string | null;
  projectColor: ProjectColor | null;
  done: boolean;
};

export type Chat = { target: number; sent: number };

export type GetDayResponse = {
  date: string;
  projects: Project[];
  tasks: DayTask[];
  chat: Chat;
};

export type GetMonthResponse = {
  days: { date: string; total: number; done: number }[];
  recurringCount: number;
};

export type ApiResponse<C, K extends keyof C> = C[K] extends (args: never) => Promise<infer R>
  ? R
  : C[K] extends (args: infer _A) => Promise<infer R>
    ? R
    : never;
export type ApiRequest<C, K extends keyof C> = C[K] extends (args: infer A) => Promise<unknown>
  ? A
  : never;

async function callApi<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${route} failed: ${res.status}`);
  const data: unknown = await res.json();
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return data as T;
}

/* ================= localStorage fallback ================= */

const STORE_KEY = "daily-hub-v1";

type LocalTask = {
  id: number;
  title: string;
  kind: TaskKind;
  time: string | null;
  recurring: boolean;
  projectId: number | null;
  date: string | null;
};

type Store = {
  projects: Project[];
  tasks: LocalTask[];
  completions: { taskId: number; date: string; done: boolean }[];
  chatDays: Record<string, Chat>;
  nextProjectId: number;
  nextTaskId: number;
};

const STARTERS: { name: string; color: ProjectColor }[] = [
  { name: "Fermah", color: "violet" },
  { name: "Dlicom", color: "blue" },
  { name: "Primus", color: "teal" },
];

function emptyStore(): Store {
  return { projects: [], tasks: [], completions: [], chatDays: {}, nextProjectId: 1, nextTaskId: 1 };
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<Store>;
    return { ...emptyStore(), ...parsed };
  } catch {
    return emptyStore();
  }
}

function saveStore(s: Store): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // Storage full or unavailable: keep running in memory only.
  }
}

function seedProjects(s: Store): number {
  if (s.projects.length > 0) return 0;
  for (const p of STARTERS) {
    s.projects.push({ id: s.nextProjectId++, name: p.name, color: p.color, link: null, note: null });
  }
  saveStore(s);
  return STARTERS.length;
}

function todayInKolkata(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function localLoadChat(s: Store, date: string): Chat {
  const row = s.chatDays[date];
  if (row) return { target: row.target, sent: row.sent };
  const priorDates = Object.keys(s.chatDays).sort();
  const last = priorDates.length > 0 ? s.chatDays[priorDates[priorDates.length - 1]!] : undefined;
  return { target: last?.target ?? 50, sent: 0 };
}

const local = {
  getDay(args: { date: string }): GetDayResponse {
    const s = loadStore();
    seedProjects(s);
    const byId = new Map(s.projects.map((p) => [p.id, p]));
    const rows = s.tasks
      .filter((t) => t.recurring || t.date === args.date)
      .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.id - b.id);
    const doneSet = new Set(
      s.completions.filter((c) => c.date === args.date && c.done).map((c) => c.taskId),
    );
    return {
      date: args.date,
      projects: [...s.projects].sort((a, b) => a.id - b.id),
      tasks: rows.map((r) => {
        const proj = r.projectId != null ? byId.get(r.projectId) : undefined;
        return {
          id: r.id,
          title: r.title,
          kind: r.kind,
          time: r.time,
          recurring: r.recurring,
          projectId: r.projectId,
          projectName: proj?.name ?? null,
          projectColor: proj?.color ?? null,
          done: doneSet.has(r.id),
        };
      }),
      chat: localLoadChat(s, args.date),
    };
  },

  getMonth(args: { month: string }): GetMonthResponse {
    const s = loadStore();
    const recurringCount = s.tasks.filter((t) => t.recurring).length;
    const taskById = new Map(s.tasks.map((t) => [t.id, t]));
    const totals = new Map<string, { total: number; done: number }>();
    const entryFor = (d: string) => {
      const e = totals.get(d) ?? { total: 0, done: 0 };
      totals.set(d, e);
      return e;
    };
    for (const t of s.tasks) {
      if (t.recurring || !t.date || !t.date.startsWith(args.month)) continue;
      entryFor(t.date).total += 1;
    }
    for (const c of s.completions) {
      if (!c.done || !c.date.startsWith(args.month)) continue;
      const t = taskById.get(c.taskId);
      if (!t) continue;
      if (t.recurring || t.date === c.date) entryFor(c.date).done += 1;
    }
    return {
      days: [...totals.entries()].map(([date, v]) => ({ date, total: v.total, done: v.done })),
      recurringCount,
    };
  },

  addProject(args: { name: string; color?: ProjectColor; link?: string; note?: string }): { id: number } {
    const s = loadStore();
    const name = args.name.trim();
    if (!name) throw new Error("Project name is required.");
    const id = s.nextProjectId++;
    s.projects.push({
      id,
      name: name.slice(0, 60),
      color: args.color ?? "blue",
      link: args.link?.trim() ? args.link.trim().slice(0, 300) : null,
      note: args.note?.trim() ? args.note.trim().slice(0, 200) : null,
    });
    saveStore(s);
    return { id };
  },

  updateProject(args: {
    id: number;
    name: string;
    color: ProjectColor;
    link: string | null;
    note: string | null;
  }): { ok: true } {
    const s = loadStore();
    const p = s.projects.find((x) => x.id === args.id);
    if (!p) throw new Error("Project not found.");
    p.name = args.name.trim().slice(0, 60);
    p.color = args.color;
    p.link = args.link?.trim() ? args.link.trim().slice(0, 300) : null;
    p.note = args.note?.trim() ? args.note.trim().slice(0, 200) : null;
    saveStore(s);
    return { ok: true };
  },

  deleteProject(args: { id: number }): { ok: true } {
    const s = loadStore();
    for (const t of s.tasks) if (t.projectId === args.id) t.projectId = null;
    s.projects = s.projects.filter((p) => p.id !== args.id);
    saveStore(s);
    return { ok: true };
  },

  addTask(args: {
    title: string;
    kind?: TaskKind;
    time?: string | null;
    projectId?: number | null;
    date?: string | null;
    recurring?: boolean;
  }): { id: number } {
    const s = loadStore();
    const title = args.title.trim();
    if (!title) throw new Error("Title is required.");
    const id = s.nextTaskId++;
    s.tasks.push({
      id,
      title: title.slice(0, 120),
      kind: args.kind ?? "task",
      time: args.time ?? null,
      recurring: args.recurring === true,
      projectId: args.projectId ?? null,
      date: args.recurring === true ? null : (args.date ?? null),
    });
    saveStore(s);
    return { id };
  },

  updateTask(args: {
    id: number;
    title: string;
    kind: TaskKind;
    time: string | null;
    projectId: number | null;
    date: string | null;
    recurring: boolean;
  }): { ok: true } {
    const s = loadStore();
    const t = s.tasks.find((x) => x.id === args.id);
    if (!t) throw new Error("Task not found.");
    t.title = args.title.trim().slice(0, 120);
    t.kind = args.kind;
    t.time = args.time ?? null;
    t.projectId = args.projectId ?? null;
    t.recurring = args.recurring;
    t.date = args.recurring ? null : (args.date ?? null);
    saveStore(s);
    return { ok: true };
  },

  deleteTask(args: { id: number }): { ok: true } {
    const s = loadStore();
    s.completions = s.completions.filter((c) => c.taskId !== args.id);
    s.tasks = s.tasks.filter((t) => t.id !== args.id);
    saveStore(s);
    return { ok: true };
  },

  setTaskDone(args: { taskId: number; date: string; done: boolean }): { ok: true } {
    const s = loadStore();
    const existing = s.completions.find((c) => c.taskId === args.taskId && c.date === args.date);
    if (existing) existing.done = args.done;
    else s.completions.push({ taskId: args.taskId, date: args.date, done: args.done });
    saveStore(s);
    return { ok: true };
  },

  setChatTarget(args: { date: string; target: number }): { ok: true } {
    const s = loadStore();
    const current = localLoadChat(s, args.date);
    s.chatDays[args.date] = { target: args.target, sent: current.sent };
    saveStore(s);
    return { ok: true };
  },

  setChatSent(args: { date: string; sent: number }): { ok: true } {
    const s = loadStore();
    const current = localLoadChat(s, args.date);
    s.chatDays[args.date] = { target: current.target, sent: args.sent };
    saveStore(s);
    return { ok: true };
  },

  rolloverDay(_args: Record<string, never>): { date: string; target: number; recurringTasks: number } {
    const s = loadStore();
    const today = todayInKolkata();
    const chat = localLoadChat(s, today);
    if (!s.chatDays[today]) {
      s.chatDays[today] = { target: chat.target, sent: chat.sent };
      saveStore(s);
    }
    return { date: today, target: chat.target, recurringTasks: s.tasks.filter((t) => t.recurring).length };
  },

  ensureStarterProjects(_args: Record<string, never>): { inserted: number } {
    const s = loadStore();
    return { inserted: seedProjects(s) };
  },
};

/* ================= public API: server first, local fallback ================= */

async function withFallback<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback();
  }
}

export const api = {
  getDay: (args: { date: string }) =>
    withFallback(() => callApi<GetDayResponse>("/api/tasks", { action: "getDay", ...args }), () =>
      local.getDay(args),
    ),
  getMonth: (args: { month: string }) =>
    withFallback(() => callApi<GetMonthResponse>("/api/tasks", { action: "getMonth", ...args }), () =>
      local.getMonth(args),
    ),
  addProject: (args: { name: string; color?: ProjectColor; link?: string; note?: string }) =>
    withFallback(() => callApi<{ id: number }>("/api/projects", { action: "add", ...args }), () =>
      local.addProject(args),
    ),
  updateProject: (args: { id: number; name: string; color: ProjectColor; link: string | null; note: string | null }) =>
    withFallback(() => callApi<{ ok: true }>("/api/projects", { action: "update", ...args }), () =>
      local.updateProject(args),
    ),
  deleteProject: (args: { id: number }) =>
    withFallback(() => callApi<{ ok: true }>("/api/projects", { action: "delete", ...args }), () =>
      local.deleteProject(args),
    ),
  addTask: (args: {
    title: string;
    kind?: TaskKind;
    time?: string | null;
    projectId?: number | null;
    date?: string | null;
    recurring?: boolean;
  }) =>
    withFallback(() => callApi<{ id: number }>("/api/tasks", { action: "add", ...args }), () =>
      local.addTask(args),
    ),
  updateTask: (args: {
    id: number;
    title: string;
    kind: TaskKind;
    time: string | null;
    projectId: number | null;
    date: string | null;
    recurring: boolean;
  }) =>
    withFallback(() => callApi<{ ok: true }>("/api/tasks", { action: "update", ...args }), () =>
      local.updateTask(args),
    ),
  deleteTask: (args: { id: number }) =>
    withFallback(() => callApi<{ ok: true }>("/api/tasks", { action: "delete", ...args }), () =>
      local.deleteTask(args),
    ),
  setTaskDone: (args: { taskId: number; date: string; done: boolean }) =>
    withFallback(() => callApi<{ ok: true }>("/api/tasks", { action: "setDone", ...args }), () =>
      local.setTaskDone(args),
    ),
  setChatTarget: (args: { date: string; target: number }) =>
    withFallback(() => callApi<{ ok: true }>("/api/chat", { action: "setTarget", ...args }), () =>
      local.setChatTarget(args),
    ),
  setChatSent: (args: { date: string; sent: number }) =>
    withFallback(() => callApi<{ ok: true }>("/api/chat", { action: "setSent", ...args }), () =>
      local.setChatSent(args),
    ),
  rolloverDay: (args: Record<string, never>) =>
    withFallback(() => callApi<{ date: string; target: number; recurringTasks: number }>("/api/chat", { action: "rollover", ...args }), () =>
      local.rolloverDay(args),
    ),
  ensureStarterProjects: (args: Record<string, never>) =>
    withFallback(() => callApi<{ inserted: number }>("/api/projects", { action: "seed", ...args }), () =>
      local.ensureStarterProjects(args),
    ),
};
