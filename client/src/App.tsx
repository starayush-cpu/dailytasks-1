import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

const FIELDS = actionFields<typeof Actions>();

type DayData = ApiResponse<typeof api, "getDay">;
type DayTask = DayData["tasks"][number];
type Project = DayData["projects"][number];
type ProjectColor = Project["color"];
type TaskKind = DayTask["kind"];

const COLOR_ORDER: ProjectColor[] = ["blue", "violet", "green", "orange", "pink", "teal"];
const COLOR_DOT: Record<ProjectColor, string> = {
  blue: "bg-sky-400",
  violet: "bg-violet-400",
  green: "bg-emerald-400",
  orange: "bg-orange-400",
  pink: "bg-pink-400",
  teal: "bg-teal-300",
};
const COLOR_CHIP: Record<ProjectColor, string> = {
  blue: "bg-sky-400/15 text-sky-200 border-sky-300/30",
  violet: "bg-violet-400/15 text-violet-200 border-violet-300/30",
  green: "bg-emerald-400/15 text-emerald-200 border-emerald-300/30",
  orange: "bg-orange-400/15 text-orange-200 border-orange-300/30",
  pink: "bg-pink-400/15 text-pink-200 border-pink-300/30",
  teal: "bg-teal-300/15 text-teal-100 border-teal-200/30",
};
const KIND_LABEL: Record<TaskKind, string> = {
  task: "TASK",
  post: "POST",
  discord: "DISCORD",
};

function keyOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function parseKey(key: string): Date {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key: string, n: number): string {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}
function longDate(key: string): string {
  return parseKey(key).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function fmtTime(t: string | null): string {
  if (!t) return "Anytime";
  const [h = 0, m = 0] = t.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong. Try again.";
}

function LogoMark({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2" aria-label="starayush">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-orange-400 to-amber-500 shadow-[0_6px_16px_rgba(249,115,22,0.45)]" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white">
          <path d="M12 2.6l2.8 5.9 6.5.8-4.8 4.4 1.3 6.4L12 17l-5.8 3.1 1.3-6.4L2.7 9.3l6.5-.8L12 2.6z" />
        </svg>
      </span>
      {!compact && (
        <span className="font-display text-[17px] font-bold lowercase leading-none tracking-tight">
          starayush
        </span>
      )}
    </span>
  );
}

function CheckCircle({
  done,
  onToggle,
  label,
  large,
}: {
  done: boolean;
  onToggle: () => void;
  label: string;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={done}
      onClick={onToggle}
      className={`${large ? "h-11 w-11" : "h-8 w-8"} shrink-0 rounded-full border-2 grid place-items-center transition-all ${
        done
          ? "bg-teal-400 border-teal-300 text-[#0b2e28] shadow-[0_0_18px_rgba(45,212,191,0.55)]"
          : "bg-white/10 border-white/35 text-transparent hover:border-teal-300/70"
      }`}
    >
      <svg viewBox="0 0 24 24" className={large ? "h-6 w-6" : "h-4.5 w-4.5"} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12.5 9.5 18 20 6.5" />
      </svg>
    </button>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const todayKey = useMemo(() => keyOf(new Date()), []);
  const [date, setDate] = useState(todayKey);
  const [view, setView] = useState<"schedule" | "calendar">("schedule");
  const [monthCursor, setMonthCursor] = useState(todayKey.slice(0, 7));
  const [notice, setNotice] = useState<string | null>(null);
  const discordRef = useRef<HTMLElement | null>(null);

  // Lazy daily rollover so a fresh day is prepared on open.
  useEffect(() => {
    let live = true;
    api
      .rolloverDay({})
      .then(() => {
        if (live) queryClient.invalidateQueries({ queryKey: ["day"] });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [queryClient]);

  const day = useQuery({
    queryKey: ["day", date],
    queryFn: () => api.getDay({ date }),
  });
  const month = useQuery({
    queryKey: ["month", monthCursor],
    queryFn: () => api.getMonth({ month: monthCursor }),
    enabled: view === "calendar",
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["day"] });
    queryClient.invalidateQueries({ queryKey: ["month"] });
  };

  const toggleTask = useMutation({
    mutationFn: async (t: DayTask) =>
      await api.setTaskDone({ taskId: t.id, date, done: !t.done }),
    onSuccess: refresh,
    onError: (e) => setNotice(errText(e)),
  });

  const data = day.data;
  const tasks = data?.tasks ?? [];
  const projects = data?.projects ?? [];
  const doneCount = tasks.filter((t) => t.done).length;
  const isToday = date === todayKey;

  const goDate = (k: string) => {
    setDate(k);
    setMonthCursor(k.slice(0, 7));
  };

  const scrollToDiscord = () => {
    discordRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen">
      <SafeAreaTopScrim backgroundColor="#171138" />
      <div className="mx-auto max-w-[1460px] px-3 pb-10 sm:px-5">
        {/* Compact profile bar (phones) */}
        <div className="glass mt-3 flex items-center gap-3 px-4 py-3 lg:hidden">
          <LogoMark compact />
          <div className="font-display grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-teal-300 via-sky-400 to-violet-500 text-lg font-bold text-white shadow-lg">
            A
          </div>
          <div className="min-w-0">
            <p className="font-display truncate text-base font-bold leading-tight">Ayush</p>
            <p className="truncate text-xs text-[var(--dim)]">starayush · @_star_ayush</p>
          </div>
          <div className="ml-auto text-right">
            <p className="font-display text-lg font-bold leading-tight">
              {doneCount}/{tasks.length}
            </p>
            <p className="text-[11px] text-[var(--dim)]">tasks done</p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-4 lg:grid lg:grid-cols-[268px_minmax(0,1fr)] xl:grid-cols-[268px_minmax(0,1fr)_336px]">
          {/* ============ SIDEBAR ============ */}
          <aside className="order-2 flex flex-col gap-4 self-start lg:order-1 lg:sticky lg:top-4">
            <div className="glass hidden p-5 lg:block">
              <div className="mb-4 border-b border-white/10 pb-3.5">
                <LogoMark />
              </div>
              <div className="flex items-center gap-3">
                <div className="font-display grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-teal-300 via-sky-400 to-violet-500 text-xl font-bold text-white shadow-lg">
                  A
                </div>
                <div className="min-w-0">
                  <p className="font-display truncate text-lg font-bold leading-tight">Ayush</p>
                  <p className="truncate text-xs text-[var(--dim)]">starayush · @_star_ayush</p>
                </div>
              </div>
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--dim)]">
                Personal Workspace
              </p>
              <nav className="mt-3 flex flex-col gap-1" aria-label="Main">
                <button
                  type="button"
                  onClick={() => setView("schedule")}
                  className={`flex min-h-10 items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold ${view === "schedule" ? "bg-white/15 text-white" : "text-[var(--dim)] hover:bg-white/8 hover:text-white"}`}
                >
                  <span aria-hidden="true">▦</span> Dashboard
                </button>
                <button
                  type="button"
                  onClick={() => setView("schedule")}
                  className="flex min-h-10 items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-[var(--dim)] hover:bg-white/8 hover:text-white"
                >
                  <span aria-hidden="true">☰</span> Tasks
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMonthCursor(date.slice(0, 7));
                    setView("calendar");
                  }}
                  className={`flex min-h-10 items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold ${view === "calendar" ? "bg-white/15 text-white" : "text-[var(--dim)] hover:bg-white/8 hover:text-white"}`}
                >
                  <span aria-hidden="true">▤</span> Calendar
                </button>
                <button
                  type="button"
                  onClick={scrollToDiscord}
                  className="flex min-h-10 items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-[var(--dim)] hover:bg-white/8 hover:text-white"
                >
                  <span aria-hidden="true">◉</span> Discord Chat
                </button>
              </nav>
            </div>

            <ProjectsPanel
              projects={projects}
              onChanged={refresh}
              onError={setNotice}
            />
          </aside>

          {/* ============ MAIN ============ */}
          <main className="order-1 min-w-0 lg:order-2">
            <div className="glass p-4 sm:p-6">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="font-display text-2xl font-bold leading-tight sm:text-[28px]">
                    Daily Schedule
                  </h1>
                  <p className="mt-0.5 text-sm font-medium text-[var(--dim)]">
                    {longDate(date)}
                    {isToday ? " · Today" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Previous day"
                    onClick={() => goDate(addDays(date, -1))}
                    className="glass-soft grid h-10 w-10 place-items-center text-lg hover:bg-white/12"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => goDate(todayKey)}
                    className="glass-soft min-h-10 px-3 text-sm font-bold hover:bg-white/12"
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    aria-label="Next day"
                    onClick={() => goDate(addDays(date, 1))}
                    className="glass-soft grid h-10 w-10 place-items-center text-lg hover:bg-white/12"
                  >
                    ›
                  </button>
                </div>
              </div>

              {/* Week strip */}
              <div className="mt-4 grid grid-cols-7 gap-1.5" role="group" aria-label="Pick a day">
                {[-3, -2, -1, 0, 1, 2, 3].map((off) => {
                  const k = addDays(date, off);
                  const d = parseKey(k);
                  const active = off === 0;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => goDate(k)}
                      aria-label={longDate(k)}
                      aria-pressed={active}
                      className={`rounded-2xl px-1 py-2 text-center transition ${
                        active
                          ? "bg-gradient-to-b from-teal-400/80 to-sky-500/80 text-white shadow-lg"
                          : "bg-white/6 text-[var(--dim)] hover:bg-white/12 hover:text-white"
                      }`}
                    >
                      <span className="block text-[11px] font-bold uppercase tracking-wide">
                        {d.toLocaleDateString("en-IN", { weekday: "short" })}
                      </span>
                      <span className="font-display block text-base font-bold leading-tight">
                        {d.getDate()}
                      </span>
                      {k === todayKey && !active && (
                        <span className="mx-auto mt-0.5 block h-1 w-1 rounded-full bg-teal-300" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Day progress */}
              <div className="mt-4 flex items-center gap-3">
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-teal-300 to-sky-400 transition-all duration-500"
                    style={{
                      width: tasks.length ? `${Math.round((doneCount / tasks.length) * 100)}%` : "0%",
                    }}
                  />
                </div>
                <p className="text-sm font-bold whitespace-nowrap">
                  {doneCount} of {tasks.length} done
                </p>
              </div>

              {notice && (
                <p role="alert" className="mt-3 rounded-xl border border-red-300/40 bg-red-500/15 px-3 py-2 text-sm text-red-100">
                  {notice}
                  <button type="button" className="ml-2 font-bold underline" onClick={() => setNotice(null)}>
                    Dismiss
                  </button>
                </p>
              )}

              {view === "calendar" ? (
                <CalendarView
                  monthCursor={monthCursor}
                  setMonthCursor={setMonthCursor}
                  monthData={month.data}
                  loading={month.isPending}
                  selected={date}
                  todayKey={todayKey}
                  onPick={(k) => {
                    goDate(k);
                    setView("schedule");
                  }}
                />
              ) : day.isPending ? (
                <p className="py-14 text-center text-sm text-[var(--dim)]">Loading your day…</p>
              ) : day.isError ? (
                <div className="py-14 text-center">
                  <p className="text-sm text-red-200">Could not load this day.</p>
                  <button
                    type="button"
                    onClick={() => day.refetch()}
                    className="glass-soft mt-3 min-h-10 px-4 text-sm font-bold"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <>
                  <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-[var(--dim)]">
                    Daily tasks &amp; posts · tap the circle when done
                  </p>
                  {tasks.length === 0 ? (
                    <div className="glass-soft mt-3 px-4 py-8 text-center">
                      <p className="font-display text-base font-semibold">Nothing scheduled for this day yet</p>
                      <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--dim)]">
                        Add your first item below: a task, a post, or a Discord chat session, with its time.
                      </p>
                    </div>
                  ) : (
                    <div className="relative mt-4">
                      <div className="absolute bottom-4 left-[15px] top-2 w-px bg-white/15" aria-hidden="true" />
                      <ul className="flex flex-col gap-3">
                        {tasks.map((t) => (
                          <TaskRow
                            key={t.id}
                            task={t}
                            date={date}
                            onToggle={() => toggleTask.mutate(t)}
                            onChanged={refresh}
                            onError={setNotice}
                            projects={projects}
                          />
                        ))}
                      </ul>
                    </div>
                  )}
                  <TaskForm
                    key={`${date}-${tasks.length}`}
                    date={date}
                    projects={projects}
                    onChanged={refresh}
                    onError={setNotice}
                  />
                </>
              )}
            </div>
          </main>

          {/* ============ DISCORD PANEL ============ */}
          <section
            ref={discordRef}
            className="glass order-3 self-start p-5 lg:col-start-2 xl:col-start-auto xl:sticky xl:top-4"
            aria-label="Discord chat"
          >
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#5865f2] shadow-lg" aria-hidden="true">
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white">
                  <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.2a18 18 0 0 1 2.7 1.4 14.7 14.7 0 0 0-11 0A18 18 0 0 1 9.2 4.2L8.6 3a19.7 19.7 0 0 0-4.9 1.5A20.4 20.4 0 0 0 .2 18.1a19.9 19.9 0 0 0 6 3l1.3-2.1c-.7-.3-1.4-.6-2-1l.5-.4a14 14 0 0 0 12.1 0l.5.4c-.7.4-1.4.7-2.1 1l1.3 2.1a19.8 19.8 0 0 0 6-3.1A20.3 20.3 0 0 0 20.3 4.4ZM8.7 15.3c-1.2 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.2 1 2.1 2.3c0 1.2-.9 2.3-2.1 2.3Zm6.6 0c-1.2 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.2 1 2.1 2.3c0 1.2-.9 2.3-2.1 2.3Z" />
                </svg>
              </span>
              <h2 className="font-display text-sm font-bold uppercase tracking-[0.14em]">Communication</h2>
            </div>

            {data ? (
              <ChatTracker date={date} target={data.chat.target} sent={data.chat.sent} onChanged={refresh} onError={setNotice} />
            ) : (
              <p className="mt-4 text-sm text-[var(--dim)]">Loading chat target…</p>
            )}

            <a
              href="https://discord.com/app"
              target="_blank"
              rel="noreferrer"
              className="mt-4 flex min-h-11 items-center justify-center rounded-xl bg-[#5865f2] px-4 text-sm font-bold text-white shadow-lg transition hover:bg-[#4752c4]"
            >
              Open Discord
            </a>
            <p className="mt-3 text-center text-xs leading-relaxed text-[var(--dim)]">
              Chat in your servers, then log the count here. It saves per day, so every morning starts fresh.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ================= Task row ================= */

function TaskRow({
  task,
  date,
  onToggle,
  onChanged,
  onError,
  projects,
}: {
  task: DayTask;
  date: string;
  onToggle: () => void;
  onChanged: () => void;
  onError: (m: string | null) => void;
  projects: Project[];
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const del = useMutation({
    mutationFn: async () => await api.deleteTask({ id: task.id }),
    onSuccess: onChanged,
    onError: (e) => onError(errText(e)),
  });

  if (editing) {
    return (
      <li className="relative pl-12">
        <div className="absolute left-0 top-3">
          <CheckCircle done={task.done} onToggle={onToggle} label={`Mark ${task.title} ${task.done ? "not done" : "done"}`} />
        </div>
        <TaskForm
          date={date}
          projects={projects}
          existing={task}
          onChanged={() => {
            setEditing(false);
            onChanged();
          }}
          onError={onError}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  const isPost = task.kind === "post";
  return (
    <li className="relative pl-12">
      <div className="absolute left-0 top-3 z-10">
        <CheckCircle done={task.done} onToggle={onToggle} label={`Mark ${task.title} ${task.done ? "not done" : "done"}`} />
      </div>
      <div
        className={`rounded-2xl border p-3.5 sm:p-4 ${
          isPost
            ? "border-white/25 bg-[linear-gradient(115deg,rgba(22,163,74,0.85),rgba(2,132,199,0.9))] shadow-[0_14px_35px_rgba(2,132,199,0.35)]"
            : task.kind === "discord"
              ? "border-[#5865f2]/50 bg-[#5865f2]/15 backdrop-blur-md"
              : "border-white/12 bg-white/6 backdrop-blur-md"
        } ${task.done ? "opacity-75" : ""}`}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className={`text-xs font-bold tracking-wide ${isPost ? "text-white/85" : "text-[var(--dim)]"}`}>
              {fmtTime(task.time)} | {KIND_LABEL[task.kind]}
              {task.recurring ? " · EVERY DAY" : ""}
            </p>
            <p className={`font-display mt-0.5 text-lg font-bold leading-snug ${task.done ? "line-through decoration-2" : ""}`}>
              {task.title}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {task.projectName && task.projectColor && (
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${isPost ? "border-white/40 bg-white/15 text-white" : COLOR_CHIP[task.projectColor]}`}>
                  #{task.projectName}
                </span>
              )}
              {isPost && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${task.done ? "bg-black/35 text-white" : "bg-black/25 text-white/90"}`}>
                  {task.done ? "Posted ✓" : "Pending post"}
                </span>
              )}
              {task.kind === "discord" && (
                <span className="rounded-full bg-[#5865f2]/30 px-2 py-0.5 text-[11px] font-bold text-indigo-100">
                  Discord session
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {isPost && (
              <CheckCircle done={task.done} onToggle={onToggle} label={`Mark post ${task.title} ${task.done ? "not posted" : "posted"}`} large />
            )}
            <div className="flex gap-1">
              <button
                type="button"
                aria-label={`Edit ${task.title}`}
                onClick={() => setEditing(true)}
                className={`grid h-8 w-8 place-items-center rounded-lg text-sm ${isPost ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/8 text-[var(--dim)] hover:bg-white/15 hover:text-white"}`}
              >
                ✎
              </button>
              {confirmDelete ? (
                <button
                  type="button"
                  aria-label={`Confirm delete ${task.title}`}
                  onClick={() => del.mutate()}
                  className="min-h-8 rounded-lg bg-red-500/85 px-2 text-xs font-bold text-white"
                >
                  Delete?
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={`Delete ${task.title}`}
                  onClick={() => setConfirmDelete(true)}
                  className={`grid h-8 w-8 place-items-center rounded-lg text-sm ${isPost ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/8 text-[var(--dim)] hover:bg-red-500/40 hover:text-white"}`}
                >
                  🗑
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/* ================= Task form (add + edit) ================= */

function TaskForm({
  date,
  projects,
  existing,
  onChanged,
  onError,
  onCancel,
}: {
  date: string;
  projects: Project[];
  existing?: DayTask;
  onChanged: () => void;
  onError: (m: string | null) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [kind, setKind] = useState<TaskKind>(existing?.kind ?? "task");
  const [time, setTime] = useState(existing?.time ?? "");
  const [projectId, setProjectId] = useState<string>(existing?.projectId ? String(existing.projectId) : "");
  const [repeat, setRepeat] = useState<"day" | "daily">(existing?.recurring ? "daily" : "day");
  const [titleError, setTitleError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        title: title.trim(),
        kind,
        time: time ? time : null,
        projectId: projectId ? Number(projectId) : null,
        recurring: repeat === "daily",
      };
      return existing
        ? await api.updateTask({ id: existing.id, ...payload, date: repeat === "daily" ? null : date })
        : await api.addTask({ ...payload, date: repeat === "daily" ? null : date });
    },
    onSuccess: () => {
      setTitle("");
      setTime("");
      onChanged();
    },
    onError: (e) => onError(errText(e)),
  });

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!title.trim()) {
      setTitleError("Give the item a title first.");
      return;
    }
    setTitleError(null);
    onError(null);
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="glass-soft mt-4 p-3.5 sm:p-4" aria-label={existing ? "Edit item" : "Add an item"}>
      <p className="font-display text-sm font-bold">{existing ? "Edit item" : "Add to this day"}</p>
      <div className="mt-2.5 flex flex-col gap-2.5">
        <div>
          <label htmlFor={existing ? "edit-title" : "new-title"} className="sr-only">
            Title
          </label>
          <input
            id={existing ? "edit-title" : "new-title"}
            {...FIELDS.addTask.title}
            className="field"
            placeholder="e.g. Fermah chat session, X post, Design review…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {titleError && <p className="mt-1 text-xs font-semibold text-red-200">{titleError}</p>}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div>
            <label htmlFor={existing ? "edit-time" : "new-time"} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Time
            </label>
            <input
              id={existing ? "edit-time" : "new-time"}
              type="time"
              className="field"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={existing ? "edit-kind" : "new-kind"} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Type
            </label>
            <select
              id={existing ? "edit-kind" : "new-kind"}
              className="field"
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              <option value="task">Task</option>
              <option value="post">Post</option>
              <option value="discord">Discord</option>
            </select>
          </div>
          <div>
            <label htmlFor={existing ? "edit-project" : "new-project"} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Project
            </label>
            <select
              id={existing ? "edit-project" : "new-project"}
              className="field"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={existing ? "edit-repeat" : "new-repeat"} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Repeat
            </label>
            <select
              id={existing ? "edit-repeat" : "new-repeat"}
              className="field"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as "day" | "daily")}
            >
              <option value="day">This day only</option>
              <option value="daily">Every day</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={save.isPending}
            className="min-h-10 flex-1 rounded-xl bg-gradient-to-r from-teal-400 to-sky-500 px-4 text-sm font-bold text-[#062a33] shadow-lg transition hover:brightness-110 disabled:opacity-60"
          >
            {save.isPending ? "Saving…" : existing ? "Save changes" : "Add item"}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="glass-soft min-h-10 px-4 text-sm font-bold hover:bg-white/12"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/* ================= Projects panel ================= */

function ProjectsPanel({
  projects,
  onChanged,
  onError,
}: {
  projects: Project[];
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <div className="glass p-5">
      <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--dim)]">Projects</h2>
      {projects.length === 0 && !showForm ? (
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
          No projects yet. Add your first project, then tag tasks and posts with it.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {projects.map((p) =>
            editingId === p.id ? (
              <li key={p.id}>
                <ProjectForm
                  existing={p}
                  onDone={() => {
                    setEditingId(null);
                    onChanged();
                  }}
                  onCancel={() => setEditingId(null)}
                  onError={onError}
                />
              </li>
            ) : (
              <li key={p.id} className="group flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${COLOR_DOT[p.color]}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">#{p.name}</span>
                  {p.note && <span className="block truncate text-xs text-[var(--dim)]">{p.note}</span>}
                </span>
                {p.link && (
                  <a
                    href={p.link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open link for ${p.name}`}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/8 text-xs text-[var(--dim)] hover:bg-white/15 hover:text-white"
                  >
                    ↗
                  </a>
                )}
                <button
                  type="button"
                  aria-label={`Edit project ${p.name}`}
                  onClick={() => setEditingId(p.id)}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/8 text-xs text-[var(--dim)] hover:bg-white/15 hover:text-white"
                >
                  ✎
                </button>
                <ProjectDelete id={p.id} name={p.name} onChanged={onChanged} onError={onError} />
              </li>
            ),
          )}
        </ul>
      )}
      {showForm ? (
        <ProjectForm
          onDone={() => {
            setShowForm(false);
            onChanged();
          }}
          onCancel={() => setShowForm(false)}
          onError={onError}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="mt-4 min-h-11 w-full rounded-xl border border-white/20 bg-white/6 text-sm font-bold transition hover:bg-white/12"
        >
          New Project +
        </button>
      )}
    </div>
  );
}

function ProjectDelete({
  id,
  name,
  onChanged,
  onError,
}: {
  id: number;
  name: string;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: async () => await api.deleteProject({ id }),
    onSuccess: onChanged,
    onError: (e) => onError(errText(e)),
  });
  if (confirm) {
    return (
      <button
        type="button"
        aria-label={`Confirm delete project ${name}`}
        onClick={() => del.mutate()}
        className="min-h-8 shrink-0 rounded-lg bg-red-500/85 px-2 text-xs font-bold text-white"
      >
        Delete?
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Delete project ${name}`}
      onClick={() => setConfirm(true)}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/8 text-xs text-[var(--dim)] hover:bg-red-500/40 hover:text-white"
    >
      🗑
    </button>
  );
}

function ProjectForm({
  existing,
  onDone,
  onCancel,
  onError,
}: {
  existing?: Project;
  onDone: () => void;
  onCancel: () => void;
  onError: (m: string | null) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState<ProjectColor>(existing?.color ?? "blue");
  const [link, setLink] = useState(existing?.link ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [nameError, setNameError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        color,
        link: link.trim() ? link.trim() : null,
        note: note.trim() ? note.trim() : null,
      };
      return existing
        ? await api.updateProject({ id: existing.id, ...payload })
        : await api.addProject({
            name: payload.name,
            color: payload.color,
            link: payload.link ?? undefined,
            note: payload.note ?? undefined,
          });
    },
    onSuccess: onDone,
    onError: (e) => onError(errText(e)),
  });

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!name.trim()) {
      setNameError("Project name is required.");
      return;
    }
    setNameError(null);
    onError(null);
    save.mutate();
  };

  const uid = existing ? `edit-proj-${existing.id}` : "new-proj";
  return (
    <form onSubmit={submit} className="glass-soft p-3" aria-label={existing ? `Edit project ${existing.name}` : "Add a project"}>
      <div>
        <label htmlFor={`${uid}-name`} className="sr-only">
          Project name
        </label>
        <input
          id={`${uid}-name`}
          {...FIELDS.addProject.name}
          className="field"
          placeholder="Project name, e.g. Fermah Quiz Hub"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {nameError && <p className="mt-1 text-xs font-semibold text-red-200">{nameError}</p>}
      </div>
      <div className="mt-2 flex items-center gap-1.5" role="radiogroup" aria-label="Project color">
        {COLOR_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
            className={`h-8 w-8 rounded-full ${COLOR_DOT[c]} ${color === c ? "ring-2 ring-white ring-offset-2 ring-offset-[#1d1747]" : "opacity-60 hover:opacity-100"}`}
          />
        ))}
      </div>
      <label htmlFor={`${uid}-link`} className="sr-only">
        Project link (optional)
      </label>
      <input
        id={`${uid}-link`}
        {...FIELDS.addProject.link}
        type="url"
        className="field mt-2"
        placeholder="Link (optional)"
        value={link}
        onChange={(e) => setLink(e.target.value)}
      />
      <label htmlFor={`${uid}-note`} className="sr-only">
        Short note (optional)
      </label>
      <input
        id={`${uid}-note`}
        {...FIELDS.addProject.note}
        className="field mt-2"
        placeholder="Short note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-2.5 flex gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="min-h-9 flex-1 rounded-lg bg-gradient-to-r from-teal-400 to-sky-500 px-3 text-sm font-bold text-[#062a33] disabled:opacity-60"
        >
          {save.isPending ? "Saving…" : existing ? "Save" : "Add project"}
        </button>
        <button type="button" onClick={onCancel} className="glass-soft min-h-9 px-3 text-sm font-bold">
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ================= Calendar ================= */

function CalendarView({
  monthCursor,
  setMonthCursor,
  monthData,
  loading,
  selected,
  todayKey,
  onPick,
}: {
  monthCursor: string;
  setMonthCursor: (m: string) => void;
  monthData: ApiResponse<typeof api, "getMonth"> | undefined;
  loading: boolean;
  selected: string;
  todayKey: string;
  onPick: (k: string) => void;
}) {
  const [y = 1970, m = 1] = monthCursor.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const byDate = new Map((monthData?.days ?? []).map((d) => [d.date, d]));
  const recurringCount = monthData?.recurringCount ?? 0;

  const shift = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    setMonthCursor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const cells: (string | null)[] = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${monthCursor}-${String(i + 1).padStart(2, "0")}`),
  ];

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold">
          {first.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
        </h2>
        <div className="flex gap-2">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)} className="glass-soft grid h-9 w-9 place-items-center hover:bg-white/12">
            ‹
          </button>
          <button type="button" aria-label="Next month" onClick={() => shift(1)} className="glass-soft grid h-9 w-9 place-items-center hover:bg-white/12">
            ›
          </button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d} className="py-1">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((k, i) =>
          k === null ? (
            <span key={`blank-${i}`} />
          ) : (
            (() => {
              const info = byDate.get(k);
              const total = (info?.total ?? 0) + recurringCount;
              const done = info?.done ?? 0;
              const isSel = k === selected;
              const isTodayCell = k === todayKey;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => onPick(k)}
                  aria-label={`${longDate(k)}${total ? `, ${done} of ${total} done` : ""}`}
                  aria-pressed={isSel}
                  className={`flex min-h-12 flex-col items-center justify-center rounded-xl px-0.5 py-1.5 transition ${
                    isSel
                      ? "bg-gradient-to-b from-teal-400/85 to-sky-500/85 text-white shadow-lg"
                      : "bg-white/5 hover:bg-white/12"
                  } ${isTodayCell && !isSel ? "ring-1 ring-teal-300/70" : ""}`}
                >
                  <span className="font-display text-sm font-bold leading-none">{parseKey(k).getDate()}</span>
                  {total > 0 && (
                    <span className={`mt-1 text-[10px] font-bold leading-none ${isSel ? "text-white/90" : done >= total ? "text-teal-300" : "text-[var(--dim)]"}`}>
                      {done}/{total} ✓
                    </span>
                  )}
                </button>
              );
            })()
          ),
        )}
      </div>
      {loading && <p className="mt-3 text-center text-xs text-[var(--dim)]">Loading month…</p>}
      <p className="mt-3 text-center text-xs text-[var(--dim)]">Tap a day to open its schedule.</p>
    </div>
  );
}

/* ================= Discord chat tracker ================= */

function ChatTracker({
  date,
  target,
  sent,
  onChanged,
  onError,
}: {
  date: string;
  target: number;
  sent: number;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [targetInput, setTargetInput] = useState(String(target));
  const [sentInput, setSentInput] = useState(String(sent));
  useEffect(() => setTargetInput(String(target)), [target, date]);
  useEffect(() => setSentInput(String(sent)), [sent, date]);

  const setSent = useMutation({
    mutationFn: async (n: number) => await api.setChatSent({ date, sent: n }),
    onSuccess: onChanged,
    onError: (e) => onError(errText(e)),
  });
  const setTarget = useMutation({
    mutationFn: async (n: number) => await api.setChatTarget({ date, target: n }),
    onSuccess: onChanged,
    onError: (e) => onError(errText(e)),
  });

  const frac = target > 0 ? Math.min(1, sent / target) : 0;
  const pct = Math.round(frac * 100);
  const reached = sent >= target && target > 0;
  const arcLen = Math.PI * 80;

  return (
    <div className="glass-soft mt-4 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--dim)]">Daily chat target tracker</p>
      <p className="mt-0.5 text-sm text-[var(--dim)]">
        Target: {target} Discord messages daily
      </p>
      <div className="relative mx-auto mt-2 w-full max-w-[220px]">
        <svg viewBox="0 0 180 100" className="w-full" aria-hidden="true">
          <path d="M 10 92 A 80 80 0 0 1 170 92" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="11" strokeLinecap="round" />
          <path
            d="M 10 92 A 80 80 0 0 1 170 92"
            fill="none"
            stroke="url(#chatGrad)"
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={arcLen}
            strokeDashoffset={arcLen * (1 - frac)}
            style={{ transition: "stroke-dashoffset 0.5s ease" }}
          />
          <defs>
            <linearGradient id="chatGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#a78bfa" />
              <stop offset="55%" stopColor="#818cf8" />
              <stop offset="100%" stopColor="#2dd4bf" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center">
          <p className="font-display text-2xl font-bold leading-none">
            {sent} <span className="text-base text-[var(--dim)]">/ {target} sent</span>
          </p>
          <p className="mt-1 text-xs font-semibold text-[var(--dim)]">{pct}% complete</p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          type="button"
          aria-label="Remove one message"
          disabled={sent <= 0 || setSent.isPending}
          onClick={() => setSent.mutate(Math.max(0, sent - 1))}
          className="glass-soft grid h-10 w-10 place-items-center text-lg font-bold hover:bg-white/12 disabled:opacity-40"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setSent.mutate(sent + 1)}
          disabled={setSent.isPending}
          className="min-h-10 rounded-xl bg-[#5865f2] px-4 text-sm font-bold text-white shadow hover:bg-[#4752c4] disabled:opacity-60"
        >
          +1 sent
        </button>
        <button
          type="button"
          onClick={() => setSent.mutate(sent + 5)}
          disabled={setSent.isPending}
          className="glass-soft min-h-10 px-3 text-sm font-bold hover:bg-white/12 disabled:opacity-60"
        >
          +5
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="chat-sent" className="mb-1 block text-[11px] font-bold text-[var(--dim)]">
            Sent count
          </label>
          <div className="flex gap-1.5">
            <input
              id="chat-sent"
              {...FIELDS.setChatSent.sent}
              type="number"
              className="field"
              value={sentInput}
              onChange={(e) => setSentInput(e.target.value)}
            />
            <button
              type="button"
              aria-label="Save sent count"
              onClick={() => {
                const n = Number(sentInput);
                if (Number.isFinite(n) && n >= 0) setSent.mutate(Math.floor(n));
              }}
              className="glass-soft min-h-10 shrink-0 px-3 text-sm font-bold hover:bg-white/12"
            >
              Set
            </button>
          </div>
        </div>
        <div>
          <label htmlFor="chat-target" className="mb-1 block text-[11px] font-bold text-[var(--dim)]">
            Daily target
          </label>
          <div className="flex gap-1.5">
            <input
              id="chat-target"
              {...FIELDS.setChatTarget.target}
              type="number"
              className="field"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
            />
            <button
              type="button"
              aria-label="Save daily target"
              onClick={() => {
                const n = Number(targetInput);
                if (Number.isFinite(n) && n >= 1) setTarget.mutate(Math.floor(n));
              }}
              className="glass-soft min-h-10 shrink-0 px-3 text-sm font-bold hover:bg-white/12"
            >
              Set
            </button>
          </div>
        </div>
      </div>

      <label className="mt-3 flex min-h-9 cursor-pointer items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-sm font-semibold">
        Chat goal reached?
        <input
          type="checkbox"
          checked={reached}
          readOnly
          aria-label="Chat goal reached"
          className="h-5 w-5 accent-teal-400"
        />
      </label>
    </div>
  );
}
