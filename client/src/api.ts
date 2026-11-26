// Typed API client for the Daily Hub static build.
//
// Every method first tries the Vercel Postgres serverless routes under
// /api (api/projects.ts, api/tasks.ts, api/chat.ts). If the API call fails
// (e.g. no Postgres database is linked yet, so POSTGRES_URL is unset),
// it falls back to a localStorage store with the same shape, so the page
// still works. Once the database is linked, the API answers and the
// server data is used.
//
// Task status is THREE-state per day: done, missed, pending. A completion
// row with status 'done' | 'missed' means decided; no row means pending.

export type ProjectColor = "blue" | "violet" | "green" | "orange" | "pink" | "teal";
export type TaskKind = "task" | "post" | "discord" | "event";
export type EventRole = "join" | "host";
export type TaskStatus = "done" | "missed" | "pending";

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
  status: TaskStatus;
  postLink: string | null;
  details: string | null;
  eventRole: EventRole | null;
  remind: boolean;
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

export type HistoryDay = {
  date: string;
  tasks: DayTask[];
  chat: Chat;
};

export type GetHistoryResponse = { days: HistoryDay[] };

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
  postLink: string | null;
  details: string | null;
  eventRole: EventRole | null;
  remind: boolean;
};

type Store = {
  projects: Project[];
  tasks: LocalTask[];
  completions: { taskId: number; date: string; status: "done" | "missed" }[];
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
    const s = { ...emptyStore(), ...parsed };
    // Migrate very old rows that lack the new fields.
    s.tasks = s.tasks.map((t) => ({
      ...t,
      postLink: t.postLink ?? null,
      details: t.details ?? null,
      eventRole: t.eventRole ?? null,
      remind: t.remind !== false,
    }));
    return s;
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

function toDayTask(s: Store, r: LocalTask, date: string): DayTask {
  const byId = new Map(s.projects.map((p) => [p.id, p]));
  const proj = r.projectId != null ? byId.get(r.projectId) : undefined;
  const comp = s.completions.find((c) => c.taskId === r.id && c.date === date);
  const status: TaskStatus = comp ? comp.status : "pending";
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    time: r.time,
    recurring: r.recurring,
    projectId: r.projectId,
    projectName: proj?.name ?? null,
    projectColor: proj?.color ?? null,
    done: status === "done",
    status,
    postLink: r.postLink ?? null,
    details: r.details ?? null,
    eventRole: r.eventRole ?? null,
    remind: r.remind !== false,
  };
}

const local = {
  getDay(args: { date: string }): GetDayResponse {
    const s = loadStore();
    seedProjects(s);
    const rows = s.tasks
      .filter((t) => t.recurring || t.date === args.date)
      .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.id - b.id);
    return {
      date: args.date,
      projects: [...s.projects].sort((a, b) => a.id - b.id),
      tasks: rows.map((r) => toDayTask(s, r, args.date)),
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
      if (c.status !== "done" || !c.date.startsWith(args.month)) continue;
      const t = taskById.get(c.taskId);
      if (!t) continue;
      if (t.recurring || t.date === c.date) entryFor(c.date).done += 1;
    }
    return {
      days: [...totals.entries()].map(([date, v]) => ({ date, total: v.total, done: v.done })),
      recurringCount,
    };
  },

  getHistory(args: { from: string; to: string }): GetHistoryResponse {
    const s = loadStore();
    seedProjects(s);
    const days: HistoryDay[] = [];
    const fromD = new Date(args.from + "T00:00:00Z");
    const toD = new Date(args.to + "T00:00:00Z");
    for (let d = new Date(fromD); d <= toD; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const dayTasks = s.tasks
        .filter((t) => t.recurring || t.date === key)
        .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.id - b.id)
        .map((r) => toDayTask(s, r, key));
      const hasChat = key in s.chatDays;
      if (dayTasks.length > 0 || hasChat) {
        days.push({ date: key, tasks: dayTasks, chat: localLoadChat(s, key) });
      }
    }
    return { days };
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
    postLink?: string | null;
    details?: string | null;
    eventRole?: EventRole | null;
    remind?: boolean;
  }): { id: number } {
    const s = loadStore();
    const title = args.title.trim();
    if (!title) throw new Error("Title is required.");
    const id = s.nextTaskId++;
    const kind = args.kind ?? "task";
    s.tasks.push({
      id,
      title: title.slice(0, 120),
      kind,
      time: args.time ?? null,
      recurring: args.recurring === true,
      projectId: args.projectId ?? null,
      date: args.recurring === true ? null : (args.date ?? null),
      postLink: args.postLink?.trim() ? args.postLink.trim().slice(0, 500) : null,
      details: args.details?.trim() ? args.details.trim().slice(0, 500) : null,
      eventRole: kind === "event" && (args.eventRole === "join" || args.eventRole === "host") ? args.eventRole : null,
      remind: args.remind === false ? false : true,
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
    postLink?: string | null;
    details?: string | null;
    eventRole?: EventRole | null;
    remind?: boolean;
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
    t.postLink = args.postLink?.trim() ? args.postLink.trim().slice(0, 500) : null;
    t.details = args.details?.trim() ? args.details.trim().slice(0, 500) : null;
    t.eventRole =
      args.kind === "event" && (args.eventRole === "join" || args.eventRole === "host") ? args.eventRole : null;
    t.remind = args.remind === false ? false : true;
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

  setTaskStatus(args: { taskId: number; date: string; status: "done" | "missed" | null }): { ok: true } {
    const s = loadStore();
    const idx = s.completions.findIndex((c) => c.taskId === args.taskId && c.date === args.date);
    if (args.status === null) {
      if (idx >= 0) s.completions.splice(idx, 1);
    } else if (idx >= 0) {
      s.completions[idx]!.status = args.status;
    } else {
      s.completions.push({ taskId: args.taskId, date: args.date, status: args.status });
    }
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
  getHistory: (args: { from: string; to: string }) =>
    withFallback(() => callApi<GetHistoryResponse>("/api/tasks", { action: "getHistory", ...args }), () =>
      local.getHistory(args),
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
    postLink?: string | null;
    details?: string | null;
    eventRole?: EventRole | null;
    remind?: boolean;
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
    postLink?: string | null;
    details?: string | null;
    eventRole?: EventRole | null;
    remind?: boolean;
  }) =>
    withFallback(() => callApi<{ ok: true }>("/api/tasks", { action: "update", ...args }), () =>
      local.updateTask(args),
    ),
  deleteTask: (args: { id: number }) =>
    withFallback(() => callApi<{ ok: true }>("/api/tasks", { action: "delete", ...args }), () =>
      local.deleteTask(args),
    ),
  setTaskDone: (args: { taskId: number; date: string; done: boolean }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "setDone", ...args }),
      () => local.setTaskStatus({ taskId: args.taskId, date: args.date, status: args.done ? "done" : null }),
    ),
  setTaskStatus: (args: { taskId: number; date: string; status: "done" | "missed" | null }) =>
    withFallback(() => callApi<{ ok: true }>("/api/tasks", { action: "setStatus", ...args }), () =>
      local.setTaskStatus(args),
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
