// Typed API client for the Daily Hub static build.
//
// Every method first tries the Vercel Postgres serverless routes under
// /api (api/users.ts, api/projects.ts, api/tasks.ts, api/chat.ts). If the
// API call fails (e.g. no Postgres database is linked yet, so
// POSTGRES_URL is unset), it falls back to a localStorage store with the
// same shape, so the page still works. Once the database is linked, the
// API answers and the server data is used.
//
// Task status is THREE-state per day: done, missed, pending. A completion
// row with status 'done' | 'missed' means decided; no row means pending.
// Done and Posted are separate states: marking a post Done never flips
// it to Posted; `posted` is tracked per task per day too.
//
// Multi-user: every user has their own projects, tasks, completions and
// chat counts. Ayush (id 1) is the default user. The active user id is
// kept in localStorage; all API calls and the local fallback are scoped
// to it. No passwords or auth — just local profiles on this site.

export type ProjectColor = "blue" | "violet" | "green" | "orange" | "pink" | "teal";
export type TaskKind = "task" | "post" | "discord" | "event";
export type EventRole = "play" | "host";
export type TaskStatus = "done" | "missed" | "pending";

export type User = {
  id: number;
  name: string;
  photo: string | null;
};

export type Project = {
  id: number;
  name: string;
  color: ProjectColor;
  link: string | null;
  note: string | null;
  logo: string | null;
  ended: boolean;
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
  projectEnded: boolean;
  done: boolean;
  status: TaskStatus;
  posted: boolean;
  verified: boolean;
  verifiedSource: string | null;
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  kaito: boolean;
  postLink: string | null;
  details: string | null;
  eventRole: EventRole | null;
  remind: boolean;
};

export type Chat = { target: number; sent: number };
export type ProjectChat = { projectId: number; sent: number; target: number };

export type GetDayResponse = {
  date: string;
  projects: Project[];
  tasks: DayTask[];
  chat: Chat;
  projectChat: ProjectChat[];
};

export type GetMonthResponse = {
  days: { date: string; total: number; done: number }[];
  recurringCount: number;
};

export type HistoryDay = {
  date: string;
  tasks: DayTask[];
  chat: Chat;
  projectChat: ProjectChat[];
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

/* ================= active user ================= */

const ACTIVE_USER_KEY = "daily-hub-user";

export function getActiveUserId(): number {
  try {
    const n = Number(localStorage.getItem(ACTIVE_USER_KEY));
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // Ignore storage errors.
  }
  return 1;
}

export function setActiveUserId(id: number): void {
  try {
    localStorage.setItem(ACTIVE_USER_KEY, String(id));
  } catch {
    // Ignore storage errors.
  }
}

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

/* ================= localStorage fallback (per user) ================= */

const USERS_KEY = "daily-hub-users-v1";
const LEGACY_STORE_KEY = "daily-hub-v1";
const AYUSH_PHOTO = "./ayush-pfp.jpg";

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
  kaito: boolean;
  posted: boolean;
};

type LocalProject = Project;

type Store = {
  projects: LocalProject[];
  tasks: LocalTask[];
  completions: {
    taskId: number;
    date: string;
    status: "done" | "missed" | null;
    posted: boolean;
    verified: boolean;
    verifiedSource: string | null;
    views: number | null;
    likes: number | null;
    reposts: number | null;
    replies: number | null;
  }[];
  chatDays: Record<string, Chat>;
  projectChat: Record<string, { sent: number; target: number }>;
  nextProjectId: number;
  nextTaskId: number;
};

/** A completion row carries something worth keeping when it has a status,
 * a posted flag, a verification, or any engagement number. */
function completionKeeps(c: Store["completions"][number]): boolean {
  return (
    c.status !== null ||
    c.posted ||
    c.verified ||
    c.views != null ||
    c.likes != null ||
    c.reposts != null ||
    c.replies != null
  );
}

type UsersRecord = { users: User[]; nextUserId: number };

const STARTERS: { name: string; color: ProjectColor }[] = [
  { name: "Fermah", color: "violet" },
  { name: "Dlicom", color: "blue" },
  { name: "Primus", color: "teal" },
];

function emptyStore(): Store {
  return {
    projects: [],
    tasks: [],
    completions: [],
    chatDays: {},
    projectChat: {},
    nextProjectId: 1,
    nextTaskId: 1,
  };
}

function storeKey(userId: number): string {
  return `${LEGACY_STORE_KEY}:u:${userId}`;
}

function loadUsersRecord(): UsersRecord {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UsersRecord>;
      if (Array.isArray(parsed.users) && parsed.users.length > 0) {
        return {
          users: parsed.users.map((u) => ({
            id: u.id,
            name: u.name,
            photo: u.photo ?? null,
          })),
          nextUserId: parsed.nextUserId ?? Math.max(...parsed.users.map((u) => u.id)) + 1,
        };
      }
    }
  } catch {
    // Fall through to migration / fresh record.
  }
  // Migrate a pre-multi-user store: everything in it was Ayush's.
  const legacy = loadLegacyStore();
  const rec: UsersRecord = { users: [{ id: 1, name: "Ayush", photo: AYUSH_PHOTO }], nextUserId: 2 };
  if (legacy) {
    saveStore(1, legacy);
    try {
      localStorage.removeItem(LEGACY_STORE_KEY);
    } catch {
      // Ignore.
    }
  }
  saveUsersRecord(rec);
  return rec;
}

function saveUsersRecord(rec: UsersRecord): void {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(rec));
  } catch {
    // Storage full or unavailable.
  }
}

function loadLegacyStore(): Store | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Store>;
    return normalizeStore({ ...emptyStore(), ...parsed });
  } catch {
    return null;
  }
}

function normalizeStore(s: Store): Store {
  s.projects = s.projects.map((p) => ({
    ...p,
    logo: (p as Partial<LocalProject>).logo ?? null,
    ended: (p as Partial<LocalProject>).ended === true,
  }));
  s.tasks = s.tasks.map((t) => ({
    ...t,
    postLink: t.postLink ?? null,
    details: t.details ?? null,
    eventRole: t.eventRole ?? null,
    remind: t.remind !== false,
    kaito: (t as Partial<LocalTask>).kaito === true,
    posted: (t as Partial<LocalTask>).posted === true,
  }));
  s.completions = (s.completions ?? []).map((c) => ({
    taskId: c.taskId,
    date: c.date,
    status: c.status,
    posted: (c as Partial<{ posted: boolean }>).posted === true,
    verified: (c as Partial<{ verified: boolean }>).verified === true,
    verifiedSource: (c as Partial<{ verifiedSource: string | null }>).verifiedSource ?? null,
    views: (c as Partial<{ views: number | null }>).views ?? null,
    likes: (c as Partial<{ likes: number | null }>).likes ?? null,
    reposts: (c as Partial<{ reposts: number | null }>).reposts ?? null,
    replies: (c as Partial<{ replies: number | null }>).replies ?? null,
  }));
  s.chatDays = s.chatDays ?? {};
  s.projectChat = (s as Partial<Store>).projectChat ?? {};
  return s;
}

function loadStore(userId: number): Store {
  try {
    const raw = localStorage.getItem(storeKey(userId));
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<Store>;
    return normalizeStore({ ...emptyStore(), ...parsed });
  } catch {
    return emptyStore();
  }
}

function saveStore(userId: number, s: Store): void {
  try {
    localStorage.setItem(storeKey(userId), JSON.stringify(s));
  } catch {
    // Storage full or unavailable: keep running in memory only.
  }
}

function seedProjects(userId: number, s: Store): number {
  if (userId !== 1 || s.projects.length > 0) return 0;
  for (const p of STARTERS) {
    s.projects.push({
      id: s.nextProjectId++,
      name: p.name,
      color: p.color,
      link: null,
      note: null,
      logo: null,
      ended: false,
    });
  }
  saveStore(userId, s);
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

function localProjectChat(s: Store, date: string): ProjectChat[] {
  return Object.entries(s.projectChat)
    .filter(([k]) => k.endsWith(`|${date}`))
    .map(([k, v]) => ({ projectId: Number(k.split("|")[0]), sent: v.sent, target: v.target }))
    .sort((a, b) => a.projectId - b.projectId);
}

function toDayTask(s: Store, r: LocalTask, date: string): DayTask {
  const byId = new Map(s.projects.map((p) => [p.id, p]));
  const proj = r.projectId != null ? byId.get(r.projectId) : undefined;
  const comp = s.completions.find((c) => c.taskId === r.id && c.date === date);
  const status: TaskStatus = comp?.status ?? "pending";
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    time: r.time,
    recurring: r.recurring,
    projectId: r.projectId,
    projectName: proj?.name ?? null,
    projectColor: proj?.color ?? null,
    projectEnded: proj?.ended ?? false,
    done: status === "done",
    status,
    posted: comp ? comp.posted : r.posted,
    verified: comp?.verified === true,
    verifiedSource: comp?.verifiedSource ?? null,
    views: comp?.views ?? null,
    likes: comp?.likes ?? null,
    reposts: comp?.reposts ?? null,
    replies: comp?.replies ?? null,
    kaito: r.kaito,
    postLink: r.postLink ?? null,
    details: r.details ?? null,
    eventRole: r.eventRole ?? null,
    remind: r.remind !== false,
  };
}

const local = {
  getUsers(): { users: User[] } {
    return { users: loadUsersRecord().users };
  },

  addUser(args: { name: string; photo?: string | null }): { id: number } {
    const rec = loadUsersRecord();
    const name = args.name.trim();
    if (!name) throw new Error("Name is required.");
    const id = rec.nextUserId++;
    rec.users.push({ id, name: name.slice(0, 60), photo: args.photo?.trim() ? args.photo.trim().slice(0, 500) : null });
    saveUsersRecord(rec);
    return { id };
  },

  updateUser(args: { id: number; name: string; photo: string | null }): { ok: true } {
    const rec = loadUsersRecord();
    const u = rec.users.find((x) => x.id === args.id);
    if (!u) throw new Error("User not found.");
    u.name = args.name.trim().slice(0, 60);
    u.photo = args.photo?.trim() ? args.photo.trim().slice(0, 500) : null;
    saveUsersRecord(rec);
    return { ok: true };
  },

  deleteUser(args: { id: number }): { ok: true } {
    const rec = loadUsersRecord();
    if (rec.users.length <= 1) throw new Error("Cannot delete the last user.");
    rec.users = rec.users.filter((u) => u.id !== args.id);
    saveUsersRecord(rec);
    try {
      localStorage.removeItem(storeKey(args.id));
    } catch {
      // Ignore.
    }
    return { ok: true };
  },

  getDay(userId: number, args: { date: string }): GetDayResponse {
    const s = loadStore(userId);
    seedProjects(userId, s);
    const rows = s.tasks
      .filter((t) => t.recurring || t.date === args.date)
      .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.id - b.id);
    const activeProjects = s.projects.filter((p) => !p.ended);
    return {
      date: args.date,
      projects: [...s.projects].sort((a, b) => Number(a.ended) - Number(b.ended) || a.id - b.id),
      // Ended projects' tasks stay in history but leave the active schedule.
      tasks: rows
        .filter((r) => {
          const proj = r.projectId != null ? s.projects.find((p) => p.id === r.projectId) : undefined;
          return !proj?.ended;
        })
        .map((r) => toDayTask(s, r, args.date)),
      chat: localLoadChat(s, args.date),
      projectChat: localProjectChat(s, args.date).filter((pc) =>
        activeProjects.some((p) => p.id === pc.projectId),
      ),
    };
  },

  getMonth(userId: number, args: { month: string }): GetMonthResponse {
    const s = loadStore(userId);
    const recurringCount = s.tasks.filter((t) => t.recurring).length;
    const taskById = new Map(s.tasks.map((t) => [t.id, t]));
    const isEnded = (t: LocalTask) => {
      const p = t.projectId != null ? s.projects.find((x) => x.id === t.projectId) : undefined;
      return p?.ended === true;
    };
    const totals = new Map<string, { total: number; done: number }>();
    const entryFor = (d: string) => {
      const e = totals.get(d) ?? { total: 0, done: 0 };
      totals.set(d, e);
      return e;
    };
    for (const t of s.tasks) {
      if (t.recurring || !t.date || !t.date.startsWith(args.month) || isEnded(t)) continue;
      entryFor(t.date).total += 1;
    }
    for (const c of s.completions) {
      if (c.status !== "done" || !c.date.startsWith(args.month)) continue;
      const t = taskById.get(c.taskId);
      if (!t || isEnded(t)) continue;
      if (t.recurring || t.date === c.date) entryFor(c.date).done += 1;
    }
    return {
      days: [...totals.entries()].map(([date, v]) => ({ date, total: v.total, done: v.done })),
      recurringCount,
    };
  },

  getHistory(userId: number, args: { from: string; to: string }): GetHistoryResponse {
    const s = loadStore(userId);
    seedProjects(userId, s);
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
        days.push({ date: key, tasks: dayTasks, chat: localLoadChat(s, key), projectChat: localProjectChat(s, key) });
      }
    }
    return { days };
  },

  addProject(
    userId: number,
    args: { name: string; color?: ProjectColor; link?: string; note?: string; logo?: string | null },
  ): { id: number } {
    const s = loadStore(userId);
    const name = args.name.trim();
    if (!name) throw new Error("Project name is required.");
    const id = s.nextProjectId++;
    s.projects.push({
      id,
      name: name.slice(0, 60),
      color: args.color ?? "blue",
      link: args.link?.trim() ? args.link.trim().slice(0, 300) : null,
      note: args.note?.trim() ? args.note.trim().slice(0, 200) : null,
      logo: args.logo?.trim() ? args.logo.trim().slice(0, 500) : null,
      ended: false,
    });
    saveStore(userId, s);
    return { id };
  },

  updateProject(
    userId: number,
    args: { id: number; name: string; color: ProjectColor; link: string | null; note: string | null; logo: string | null; ended: boolean },
  ): { ok: true } {
    const s = loadStore(userId);
    const p = s.projects.find((x) => x.id === args.id);
    if (!p) throw new Error("Project not found.");
    p.name = args.name.trim().slice(0, 60);
    p.color = args.color;
    p.link = args.link?.trim() ? args.link.trim().slice(0, 300) : null;
    p.note = args.note?.trim() ? args.note.trim().slice(0, 200) : null;
    p.logo = args.logo?.trim() ? args.logo.trim().slice(0, 500) : null;
    p.ended = args.ended === true;
    saveStore(userId, s);
    return { ok: true };
  },

  setProjectEnded(userId: number, args: { id: number; ended: boolean }): { ok: true } {
    const s = loadStore(userId);
    const p = s.projects.find((x) => x.id === args.id);
    if (!p) throw new Error("Project not found.");
    p.ended = args.ended === true;
    saveStore(userId, s);
    return { ok: true };
  },

  deleteProject(userId: number, args: { id: number }): { ok: true } {
    const s = loadStore(userId);
    for (const t of s.tasks) if (t.projectId === args.id) t.projectId = null;
    s.projects = s.projects.filter((p) => p.id !== args.id);
    saveStore(userId, s);
    return { ok: true };
  },

  addTask(
    userId: number,
    args: {
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
      kaito?: boolean;
    },
  ): { id: number } {
    const s = loadStore(userId);
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
      eventRole: kind === "event" && (args.eventRole === "play" || args.eventRole === "host") ? args.eventRole : null,
      remind: args.remind === false ? false : true,
      kaito: kind === "post" && args.kaito === true,
      posted: false,
    });
    saveStore(userId, s);
    return { id };
  },

  updateTask(
    userId: number,
    args: {
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
      kaito?: boolean;
      posted?: boolean;
    },
  ): { ok: true } {
    const s = loadStore(userId);
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
      args.kind === "event" && (args.eventRole === "play" || args.eventRole === "host") ? args.eventRole : null;
    t.remind = args.remind === false ? false : true;
    t.kaito = args.kind === "post" && args.kaito === true;
    if (args.posted !== undefined) t.posted = args.posted;
    saveStore(userId, s);
    return { ok: true };
  },

  deleteTask(userId: number, args: { id: number }): { ok: true } {
    const s = loadStore(userId);
    s.completions = s.completions.filter((c) => c.taskId !== args.id);
    s.tasks = s.tasks.filter((t) => t.id !== args.id);
    saveStore(userId, s);
    return { ok: true };
  },

  setTaskStatus(
    userId: number,
    args: { taskId: number; date: string; status: "done" | "missed" | null },
  ): { ok: true } {
    const s = loadStore(userId);
    const idx = s.completions.findIndex((c) => c.taskId === args.taskId && c.date === args.date);
    if (args.status === null) {
      if (idx >= 0 && !completionKeeps({ ...s.completions[idx]!, status: null })) s.completions.splice(idx, 1);
      else if (idx >= 0) s.completions[idx]!.status = null;
    } else if (idx >= 0) {
      s.completions[idx]!.status = args.status;
    } else {
      s.completions.push({
        taskId: args.taskId,
        date: args.date,
        status: args.status,
        posted: false,
        verified: false,
        verifiedSource: null,
        views: null,
        likes: null,
        reposts: null,
        replies: null,
      });
    }
    // A completion carrying nothing worth keeping is dropped.
    s.completions = s.completions.filter(completionKeeps);
    saveStore(userId, s);
    return { ok: true };
  },

  setTaskPosted(
    userId: number,
    args: { taskId: number; date: string; posted: boolean },
  ): { ok: true } {
    const s = loadStore(userId);
    const t = s.tasks.find((x) => x.id === args.taskId);
    if (t && !t.recurring) t.posted = args.posted;
    const idx = s.completions.findIndex((c) => c.taskId === args.taskId && c.date === args.date);
    if (idx >= 0) {
      s.completions[idx]!.posted = args.posted;
    } else if (args.posted) {
      s.completions.push({
        taskId: args.taskId,
        date: args.date,
        status: null,
        posted: true,
        verified: false,
        verifiedSource: null,
        views: null,
        likes: null,
        reposts: null,
        replies: null,
      });
    }
    s.completions = s.completions.filter(completionKeeps);
    saveStore(userId, s);
    return { ok: true };
  },

  setTaskVerified(
    userId: number,
    args: { taskId: number; date: string; verified: boolean; source?: string },
  ): { ok: true } {
    const s = loadStore(userId);
    const idx = s.completions.findIndex((c) => c.taskId === args.taskId && c.date === args.date);
    if (idx >= 0) {
      s.completions[idx]!.verified = args.verified;
      s.completions[idx]!.verifiedSource = args.verified
        ? args.source?.trim().slice(0, 40) || "manual"
        : null;
    } else if (args.verified) {
      s.completions.push({
        taskId: args.taskId,
        date: args.date,
        status: null,
        posted: false,
        verified: true,
        verifiedSource: args.source?.trim().slice(0, 40) || "manual",
        views: null,
        likes: null,
        reposts: null,
        replies: null,
      });
    }
    s.completions = s.completions.filter(completionKeeps);
    saveStore(userId, s);
    return { ok: true };
  },

  setEngagement(
    userId: number,
    args: {
      taskId: number;
      date: string;
      views?: number | null;
      likes?: number | null;
      reposts?: number | null;
      replies?: number | null;
    },
  ): { ok: true } {
    const s = loadStore(userId);
    const clean = (v: number | null | undefined, cur: number | null): number | null => {
      if (v === undefined) return cur;
      if (v === null) return null;
      return Number.isInteger(v) && v >= 0 ? v : cur;
    };
    const idx = s.completions.findIndex((c) => c.taskId === args.taskId && c.date === args.date);
    if (idx >= 0) {
      const c = s.completions[idx]!;
      c.views = clean(args.views, c.views);
      c.likes = clean(args.likes, c.likes);
      c.reposts = clean(args.reposts, c.reposts);
      c.replies = clean(args.replies, c.replies);
    } else {
      s.completions.push({
        taskId: args.taskId,
        date: args.date,
        status: null,
        posted: false,
        verified: false,
        verifiedSource: null,
        views: args.views ?? null,
        likes: args.likes ?? null,
        reposts: args.reposts ?? null,
        replies: args.replies ?? null,
      });
    }
    s.completions = s.completions.filter(completionKeeps);
    saveStore(userId, s);
    return { ok: true };
  },

  setChatTarget(userId: number, args: { date: string; target: number }): { ok: true } {
    const s = loadStore(userId);
    const current = localLoadChat(s, args.date);
    s.chatDays[args.date] = { target: args.target, sent: current.sent };
    saveStore(userId, s);
    return { ok: true };
  },

  setChatSent(userId: number, args: { date: string; sent: number }): { ok: true } {
    const s = loadStore(userId);
    const current = localLoadChat(s, args.date);
    s.chatDays[args.date] = { target: current.target, sent: args.sent };
    saveStore(userId, s);
    return { ok: true };
  },

  getProjectChat(userId: number, args: { date: string }): { projectChat: ProjectChat[] } {
    const s = loadStore(userId);
    return { projectChat: localProjectChat(s, args.date) };
  },

  logProjectChat(
    userId: number,
    args: { date: string; projectId: number; delta: number },
  ): { projectSent: number; globalSent: number } {
    const s = loadStore(userId);
    const key = `${args.projectId}|${args.date}`;
    const row = s.projectChat[key] ?? { sent: 0, target: 0 };
    row.sent = Math.max(0, row.sent + args.delta);
    s.projectChat[key] = row;
    const current = localLoadChat(s, args.date);
    s.chatDays[args.date] = { target: current.target, sent: Math.max(0, current.sent + args.delta) };
    saveStore(userId, s);
    return { projectSent: row.sent, globalSent: s.chatDays[args.date]!.sent };
  },

  setProjectTarget(
    userId: number,
    args: { date: string; projectId: number; target: number },
  ): { ok: true } {
    const s = loadStore(userId);
    const key = `${args.projectId}|${args.date}`;
    const row = s.projectChat[key] ?? { sent: 0, target: 0 };
    row.target = args.target;
    s.projectChat[key] = row;
    saveStore(userId, s);
    return { ok: true };
  },

  setProjectSent(
    userId: number,
    args: { date: string; projectId: number; sent: number },
  ): { ok: true } {
    const s = loadStore(userId);
    const key = `${args.projectId}|${args.date}`;
    const row = s.projectChat[key] ?? { sent: 0, target: 0 };
    row.sent = args.sent;
    s.projectChat[key] = row;
    saveStore(userId, s);
    return { ok: true };
  },

  rolloverDay(
    userId: number,
    _args: Record<string, never>,
  ): { date: string; target: number; recurringTasks: number } {
    const s = loadStore(userId);
    const today = todayInKolkata();
    const chat = localLoadChat(s, today);
    if (!s.chatDays[today]) {
      s.chatDays[today] = { target: chat.target, sent: chat.sent };
      saveStore(userId, s);
    }
    return { date: today, target: chat.target, recurringTasks: s.tasks.filter((t) => t.recurring).length };
  },

  ensureStarterProjects(userId: number, _args: Record<string, never>): { inserted: number } {
    const s = loadStore(userId);
    return { inserted: seedProjects(userId, s) };
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

function uid(): number {
  return getActiveUserId();
}

export const api = {
  getUsers: () =>
    withFallback(() => callApi<{ users: User[] }>("/api/users", { action: "list" }), () =>
      local.getUsers(),
    ),
  addUser: (args: { name: string; photo?: string | null }) =>
    withFallback(() => callApi<{ id: number }>("/api/users", { action: "add", ...args }), () =>
      local.addUser(args),
    ),
  updateUser: (args: { id: number; name: string; photo: string | null }) =>
    withFallback(() => callApi<{ ok: true }>("/api/users", { action: "update", ...args }), () =>
      local.updateUser(args),
    ),
  deleteUser: (args: { id: number }) =>
    withFallback(() => callApi<{ ok: true }>("/api/users", { action: "delete", ...args }), () =>
      local.deleteUser(args),
    ),
  getDay: (args: { date: string }) =>
    withFallback(
      () => callApi<GetDayResponse>("/api/tasks", { action: "getDay", userId: uid(), ...args }),
      () => local.getDay(uid(), args),
    ),
  getMonth: (args: { month: string }) =>
    withFallback(
      () => callApi<GetMonthResponse>("/api/tasks", { action: "getMonth", userId: uid(), ...args }),
      () => local.getMonth(uid(), args),
    ),
  getHistory: (args: { from: string; to: string }) =>
    withFallback(
      () => callApi<GetHistoryResponse>("/api/tasks", { action: "getHistory", userId: uid(), ...args }),
      () => local.getHistory(uid(), args),
    ),
  addProject: (args: { name: string; color?: ProjectColor; link?: string; note?: string; logo?: string | null }) =>
    withFallback(
      () => callApi<{ id: number }>("/api/projects", { action: "add", userId: uid(), ...args }),
      () => local.addProject(uid(), args),
    ),
  updateProject: (args: {
    id: number;
    name: string;
    color: ProjectColor;
    link: string | null;
    note: string | null;
    logo: string | null;
    ended: boolean;
  }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/projects", { action: "update", userId: uid(), ...args }),
      () => local.updateProject(uid(), args),
    ),
  setProjectEnded: (args: { id: number; ended: boolean }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/projects", { action: "setEnded", userId: uid(), ...args }),
      () => local.setProjectEnded(uid(), args),
    ),
  deleteProject: (args: { id: number }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/projects", { action: "delete", userId: uid(), ...args }),
      () => local.deleteProject(uid(), args),
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
    kaito?: boolean;
  }) =>
    withFallback(
      () => callApi<{ id: number }>("/api/tasks", { action: "add", userId: uid(), ...args }),
      () => local.addTask(uid(), args),
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
    kaito?: boolean;
    posted?: boolean;
  }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "update", userId: uid(), ...args }),
      () => local.updateTask(uid(), args),
    ),
  deleteTask: (args: { id: number }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "delete", userId: uid(), ...args }),
      () => local.deleteTask(uid(), args),
    ),
  setTaskDone: (args: { taskId: number; date: string; done: boolean }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "setDone", userId: uid(), ...args }),
      () => local.setTaskStatus(uid(), { taskId: args.taskId, date: args.date, status: args.done ? "done" : null }),
    ),
  setTaskStatus: (args: { taskId: number; date: string; status: "done" | "missed" | null }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "setStatus", userId: uid(), ...args }),
      () => local.setTaskStatus(uid(), args),
    ),
  setTaskPosted: (args: { taskId: number; date: string; posted: boolean }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "setPosted", userId: uid(), ...args }),
      () => local.setTaskPosted(uid(), args),
    ),
  setTaskVerified: (args: { taskId: number; date: string; verified: boolean; source?: string }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "setVerified", userId: uid(), ...args }),
      () => local.setTaskVerified(uid(), args),
    ),
  setEngagement: (args: {
    taskId: number;
    date: string;
    views?: number | null;
    likes?: number | null;
    reposts?: number | null;
    replies?: number | null;
  }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/tasks", { action: "setEngagement", userId: uid(), ...args }),
      () => local.setEngagement(uid(), args),
    ),
  setChatTarget: (args: { date: string; target: number }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/chat", { action: "setTarget", userId: uid(), ...args }),
      () => local.setChatTarget(uid(), args),
    ),
  setChatSent: (args: { date: string; sent: number }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/chat", { action: "setSent", userId: uid(), ...args }),
      () => local.setChatSent(uid(), args),
    ),
  getProjectChat: (args: { date: string }) =>
    withFallback(
      () => callApi<{ projectChat: ProjectChat[] }>("/api/chat", { action: "getProjectChat", userId: uid(), ...args }),
      () => local.getProjectChat(uid(), args),
    ),
  logProjectChat: (args: { date: string; projectId: number; delta: number }) =>
    withFallback(
      () =>
        callApi<{ projectSent: number; globalSent: number }>("/api/chat", {
          action: "logProjectChat",
          userId: uid(),
          ...args,
        }),
      () => local.logProjectChat(uid(), args),
    ),
  setProjectTarget: (args: { date: string; projectId: number; target: number }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/chat", { action: "setProjectTarget", userId: uid(), ...args }),
      () => local.setProjectTarget(uid(), args),
    ),
  setProjectSent: (args: { date: string; projectId: number; sent: number }) =>
    withFallback(
      () => callApi<{ ok: true }>("/api/chat", { action: "setProjectSent", userId: uid(), ...args }),
      () => local.setProjectSent(uid(), args),
    ),
  rolloverDay: (args: Record<string, never>) =>
    withFallback(
      () =>
        callApi<{ date: string; target: number; recurringTasks: number }>("/api/chat", {
          action: "rollover",
          userId: uid(),
          ...args,
        }),
      () => local.rolloverDay(uid(), args),
    ),
  ensureStarterProjects: (args: Record<string, never>) =>
    withFallback(
      () => callApi<{ inserted: number }>("/api/projects", { action: "seed", userId: uid(), ...args }),
      () => local.ensureStarterProjects(uid(), args),
    ),
};
