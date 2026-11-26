import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";

type DayData = ApiResponse<typeof api, "getDay">;
type DayTask = DayData["tasks"][number];
type Project = DayData["projects"][number];
type ProjectColor = Project["color"];
type TaskKind = DayTask["kind"];
type EventRole = NonNullable<DayTask["eventRole"]>;

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
  event: "EVENT",
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

/* ---- Phone calendar reminders (.ics download + Google Calendar) ---- */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
function icsStamp(dateISO: string, timeHHMM: string): string {
  const [y = 1970, m = 1, d = 1] = dateISO.split("-").map(Number);
  const [hh = 0, mm = 0] = timeHHMM.split(":").map(Number);
  return `${y}${pad2(m)}${pad2(d)}T${pad2(hh)}${pad2(mm)}00`;
}
function shiftTime(timeHHMM: string, mins: number): string {
  const [h = 0, m = 0] = timeHHMM.split(":").map(Number);
  const total = (h * 60 + m + mins + 24 * 60) % (24 * 60);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
function gcalStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
function calDescription(task: DayTask): string {
  return [
    task.details,
    task.kind === "event" ? `Event role: ${task.eventRole ?? "join"}` : null,
    task.postLink ? `Post: ${task.postLink}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}
function buildIcs(task: DayTask, dateISO: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Daily Hub//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${task.id}-${dateISO}@daily-hub`,
    `DTSTAMP:${gcalStamp(new Date())}`,
    ...(task.time
      ? [`DTSTART:${icsStamp(dateISO, task.time)}`, `DTEND:${icsStamp(dateISO, shiftTime(task.time, 30))}`]
      : [
          `DTSTART;VALUE=DATE:${dateISO.replace(/-/g, "")}`,
          `DTEND;VALUE=DATE:${addDays(dateISO, 1).replace(/-/g, "")}`,
        ]),
    `SUMMARY:${icsEscape(task.title)}`,
    `DESCRIPTION:${icsEscape(calDescription(task))}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(task.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}
function googleCalUrl(task: DayTask, dateISO: string): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: task.title,
    details: calDescription(task),
    ctz: "Asia/Kolkata",
  });
  if (task.time) {
    const start = new Date(`${dateISO}T${task.time}:00`);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    params.set("dates", `${gcalStamp(start)}/${gcalStamp(end)}`);
  } else {
    params.set("dates", `${dateISO.replace(/-/g, "")}/${addDays(dateISO, 1).replace(/-/g, "")}`);
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
function downloadIcs(task: DayTask, dateISO: string) {
  const blob = new Blob([buildIcs(task, dateISO)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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

function Avatar({ size }: { size: "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const cls = size === "lg" ? "h-12 w-12 text-xl" : "h-11 w-11 text-lg";
  if (failed) {
    return (
      <div className={`font-display grid ${cls} shrink-0 place-items-center rounded-full bg-gradient-to-br from-teal-300 via-sky-400 to-violet-500 font-bold text-white shadow-lg`}>
        A
      </div>
    );
  }
  return (
    <img
      src="./ayush-pfp.jpg"
      alt="Ayush"
      onError={() => setFailed(true)}
      className={`${cls} shrink-0 rounded-full object-cover shadow-lg ring-2 ring-white/25`}
    />
  );
}

const PROJECT_LOGOS: Record<string, string> = {
  fermah: "./fermah-logo.webp",
  dlicom: "./dlicom-logo.svg",
  primus: "./primus-logo.png",
};

function ProjectLogo({ name, color }: { name: string; color: ProjectColor }) {
  const src = PROJECT_LOGOS[name.toLowerCase()];
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${COLOR_DOT[color]}`} aria-hidden="true" />;
  }
  return (
    <img
      src={src}
      alt={`${name} logo`}
      onError={() => setFailed(true)}
      className="h-6 w-6 shrink-0 rounded-md bg-white/10 object-contain ring-1 ring-white/20"
    />
  );
}

/* ================= Voice announcements (Web Speech API) ================= */

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const byName = (re: RegExp) => voices.find((v) => re.test(v.name));
  return (
    byName(/Google US English/i) ??
    voices.find((v) => /^en[-_]US$/i.test(v.lang) && /natural|neural|samantha|aria|guy|jenny/i.test(v.name)) ??
    voices.find((v) => /^en[-_]US$/i.test(v.lang)) ??
    voices.find((v) => /^en[-_]IN$/i.test(v.lang)) ??
    voices.find((v) => /^en/i.test(v.lang)) ??
    null
  );
}

function speak(text: string) {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = "en-US";
  }
  u.rate = 1;
  u.pitch = 1;
  speechSynthesis.speak(u);
}

function announceText(t: DayTask, chat: { target: number; sent: number }): string {
  if (t.kind === "post") {
    const about = t.projectName ? ` about ${t.projectName}` : "";
    const hoursLeft = Math.max(0, 23 - new Date().getHours());
    return `Ayush, you have not posted${about} today, ${hoursLeft} ${hoursLeft === 1 ? "hour" : "hours"} left.`;
  }
  if (t.kind === "discord") {
    const remaining = Math.max(0, chat.target - chat.sent);
    const chatPart =
      remaining > 0
        ? ` You still have ${remaining} chats to go today.`
        : ` You have reached your chat target today.`;
    return `Ayush, time for ${t.title}.${chatPart}`;
  }
  return `Ayush, time for ${t.title}.`;
}

export function App() {
  const queryClient = useQueryClient();
  const todayKey = useMemo(() => keyOf(new Date()), []);
  const [date, setDate] = useState(todayKey);
  const [view, setView] = useState<"schedule" | "calendar" | "history">("schedule");
  const [monthCursor, setMonthCursor] = useState(todayKey.slice(0, 7));
  const [notice, setNotice] = useState<string | null>(null);
  const discordRef = useRef<HTMLElement | null>(null);
  const [remindersOn, setRemindersOn] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );
  const [soundOn, setSoundOn] = useState(() => {
    try {
      return localStorage.getItem("daily-hub-sound") === "on";
    } catch {
      return false;
    }
  });
  const notifiedRef = useRef<Set<string>>(new Set());

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
  const today = useQuery({
    queryKey: ["day", todayKey],
    queryFn: () => api.getDay({ date: todayKey }),
  });

  // Reminder engine: every minute while the site is open, fire a browser
  // notification and/or a voice announcement for each of today's pending
  // tasks whose set time has arrived (and that opted into reminders).
  useEffect(() => {
    if (!remindersOn && !soundOn) return;
    const check = () => {
      const data = today.data;
      if (!data) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      for (const t of data.tasks) {
        if (!t.time || t.time !== hhmm) continue;
        if (t.status !== "pending" || !t.remind) continue;
        const key = `${todayKey}:${t.id}`;
        if (notifiedRef.current.has(key)) continue;
        notifiedRef.current.add(key);
        if (remindersOn && typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(`Time for: ${t.title}`, { body: `${fmtTime(t.time)} · Daily Hub` });
          } catch {
            // Notifications can throw if the document is not focused enough; ignore.
          }
        }
        if (soundOn) speak(announceText(t, data.chat));
      }
    };
    check();
    const id = window.setInterval(check, 60000);
    return () => window.clearInterval(id);
  }, [today.data, remindersOn, soundOn, todayKey]);

  const enableReminders = async () => {
    if (typeof Notification === "undefined") {
      setNotice("This browser does not support notifications.");
      return;
    }
    const perm = await Notification.requestPermission();
    setRemindersOn(perm === "granted");
    if (perm === "denied") {
      setNotice("Notifications are blocked for this site. Allow them in your browser settings to get reminders.");
    }
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    try {
      localStorage.setItem("daily-hub-sound", next ? "on" : "off");
    } catch {
      // Ignore storage errors.
    }
    if (next) speak("Voice reminders are on, Ayush.");
    else if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  };

  const testVoice = () => speak("Ayush, you have not posted about Fermah today, 2 hours left.");

  const nextUp = useMemo(() => {
    if (!today.data) return null;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const upcoming = today.data.tasks
      .filter((t) => t.status === "pending" && t.time && t.time > hhmm)
      .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return upcoming[0] ?? null;
  }, [today.data]);

  const notifBlocked = typeof Notification !== "undefined" && Notification.permission === "denied";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["day"] });
    queryClient.invalidateQueries({ queryKey: ["month"] });
  };

  const setTaskStatus = useMutation({
    mutationFn: async (args: { t: DayTask; status: "done" | "missed" | null }) =>
      await api.setTaskStatus({ taskId: args.t.id, date, status: args.status }),
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
    <div className="min-h-screen overflow-x-clip">
      <div className="mx-auto max-w-[1460px] px-3 pb-24 pt-4 sm:px-5 lg:pb-10">
        {/* Compact profile bar (phones) */}
        <div className="glass mt-3 flex items-center gap-3 px-4 py-3 lg:hidden">
          <LogoMark compact />
          <Avatar size="md" />
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
                <Avatar size="lg" />
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
                  onClick={() => setView("history")}
                  className={`flex min-h-10 items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold ${view === "history" ? "bg-white/15 text-white" : "text-[var(--dim)] hover:bg-white/8 hover:text-white"}`}
                >
                  <span aria-hidden="true">◷</span> History
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

              {/* Reminders + voice */}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={enableReminders}
                  disabled={remindersOn}
                  className="glass-soft min-h-9 px-3 text-xs font-bold hover:bg-white/12 disabled:opacity-70"
                >
                  {remindersOn ? "🔔 Reminders on" : notifBlocked ? "🔕 Reminders blocked" : "🔔 Enable reminders"}
                </button>
                <button
                  type="button"
                  onClick={toggleSound}
                  className="glass-soft min-h-9 px-3 text-xs font-bold hover:bg-white/12"
                >
                  {soundOn ? "🔊 Sound on" : "🔇 Sound off"}
                </button>
                <button
                  type="button"
                  onClick={testVoice}
                  disabled={!soundOn}
                  className="glass-soft min-h-9 px-3 text-xs font-bold hover:bg-white/12 disabled:opacity-40"
                >
                  ▶ Test voice
                </button>
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
              ) : view === "history" ? (
                <HistoryView
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
                  {isToday && nextUp && (
                    <div className="glass-soft mt-4 flex items-center gap-3 px-4 py-3">
                      <span aria-hidden="true">⏰</span>
                      <p className="text-sm">
                        <span className="font-bold">Up next: {nextUp.title}</span>{" "}
                        <span className="text-[var(--dim)]">
                          at {fmtTime(nextUp.time)} · {KIND_LABEL[nextUp.kind]}
                        </span>
                      </p>
                    </div>
                  )}
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
                            onSetStatus={(status) => setTaskStatus.mutate({ t, status })}
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

        {/* Mobile bottom nav (phones): sidebar becomes a thumb bar */}
        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#0a1626]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
          aria-label="Sections"
        >
          <div className="grid grid-cols-5">
            <button
              type="button"
              onClick={() => {
                setView("schedule");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`flex min-h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${
                view === "schedule" ? "text-orange-300" : "text-slate-400"
              }`}
            >
              <span className="text-base leading-none" aria-hidden="true">⌂</span>
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => {
                setView("schedule");
                setTimeout(() => {
                  document.getElementById("add-task-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
                  document.getElementById("add-task-title")?.focus({ preventScroll: true });
                }, 120);
              }}
              className="flex min-h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-bold text-slate-400"
            >
              <span className="text-base leading-none" aria-hidden="true">＋</span>
              Add task
            </button>
            <button
              type="button"
              onClick={() => {
                setView("calendar");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`flex min-h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${
                view === "calendar" ? "text-orange-300" : "text-slate-400"
              }`}
            >
              <span className="text-base leading-none" aria-hidden="true">▦</span>
              Calendar
            </button>
            <button
              type="button"
              onClick={() => {
                setView("history");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`flex min-h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${
                view === "history" ? "text-orange-300" : "text-slate-400"
              }`}
            >
              <span className="text-base leading-none" aria-hidden="true">↺</span>
              History
            </button>
            <button
              type="button"
              onClick={scrollToDiscord}
              className="flex min-h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-bold text-slate-400"
            >
              <span className="text-base leading-none" aria-hidden="true">💬</span>
              Discord
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}

/* ================= Task row ================= */

function TaskRow({
  task,
  date,
  onSetStatus,
  onChanged,
  onError,
  projects,
}: {
  task: DayTask;
  date: string;
  onSetStatus: (status: "done" | "missed" | null) => void;
  onChanged: () => void;
  onError: (m: string | null) => void;
  projects: Project[];
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLinkEditor, setShowLinkEditor] = useState(false);
  const [showCal, setShowCal] = useState(false);
  const [linkDraft, setLinkDraft] = useState(task.postLink ?? "");

  const del = useMutation({
    mutationFn: async () => await api.deleteTask({ id: task.id }),
    onSuccess: onChanged,
    onError: (e) => onError(errText(e)),
  });

  const updateTask = useMutation({
    mutationFn: async (patch: Partial<Pick<DayTask, "postLink" | "remind">>) =>
      await api.updateTask({
        id: task.id,
        title: task.title,
        kind: task.kind,
        time: task.time,
        projectId: task.projectId,
        date: task.recurring ? null : date,
        recurring: task.recurring,
        postLink: patch.postLink !== undefined ? patch.postLink : task.postLink,
        details: task.details,
        eventRole: task.eventRole,
        remind: patch.remind !== undefined ? patch.remind : task.remind,
      }),
    onSuccess: onChanged,
    onError: (e) => onError(errText(e)),
  });

  if (editing) {
    return (
      <li className="relative pl-12">
        <div className="absolute left-0 top-3">
          <CheckCircle done={task.done} onToggle={() => onSetStatus(task.status === "done" ? null : "done")} label={`Mark ${task.title} ${task.done ? "not done" : "done"}`} />
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
  const isMissed = task.status === "missed";
  const cardClass = isMissed
    ? "border-red-400/50 bg-red-500/12 backdrop-blur-md"
    : isPost
      ? "border-white/25 bg-[linear-gradient(115deg,rgba(22,163,74,0.85),rgba(2,132,199,0.9))] shadow-[0_14px_35px_rgba(2,132,199,0.35)]"
      : task.kind === "discord"
        ? "border-[#5865f2]/50 bg-[#5865f2]/15 backdrop-blur-md"
        : task.kind === "event"
          ? "border-violet-400/50 bg-violet-500/15 backdrop-blur-md"
          : "border-white/12 bg-white/6 backdrop-blur-md";

  return (
    <li className="relative pl-12">
      <div className="absolute left-0 top-3 z-10">
        <CheckCircle done={task.done} onToggle={() => onSetStatus(task.status === "done" ? null : "done")} label={`Mark ${task.title} ${task.done ? "not done" : "done"}`} />
      </div>
      <div
        className={`rounded-2xl border p-3.5 sm:p-4 ${cardClass} ${task.done ? "opacity-75" : ""} ${isMissed ? "opacity-90" : ""}`}
      >
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:gap-3">
          <div className="min-w-0 flex-1">
            <p className={`text-xs font-bold tracking-wide ${isPost ? "text-white/85" : "text-[var(--dim)]"}`}>
              {fmtTime(task.time)} | {KIND_LABEL[task.kind]}
              {task.recurring ? " · EVERY DAY" : ""}
            </p>
            <p className={`font-display mt-0.5 text-lg font-bold leading-snug ${task.done ? "line-through decoration-2" : ""} ${isMissed ? "text-red-200" : ""}`}>
              {task.title}
            </p>
            {task.details && (
              <p className={`mt-1 text-sm leading-relaxed ${isPost ? "text-white/85" : "text-[var(--dim)]"}`}>
                {task.details}
              </p>
            )}
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
              {task.kind === "event" && (
                <span className="rounded-full bg-violet-400/25 px-2 py-0.5 text-[11px] font-bold text-violet-100">
                  {task.eventRole === "host" ? "Hosting" : "Joining"}
                </span>
              )}
              {isMissed && (
                <span className="rounded-full bg-red-500/80 px-2 py-0.5 text-[11px] font-bold text-white">
                  Missed ✕
                </span>
              )}
              {task.postLink && (
                <a
                  href={task.postLink}
                  target="_blank"
                  rel="noreferrer"
                  className={`break-all rounded-full px-2 py-0.5 text-[11px] font-bold underline ${isPost ? "bg-white/15 text-white" : "bg-white/10 text-sky-200"}`}
                >
                  View post ↗
                </a>
              )}
            </div>
            {showLinkEditor && (
              <form
                className="mt-2.5 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  updateTask.mutate({ postLink: linkDraft.trim() ? linkDraft.trim() : null });
                  setShowLinkEditor(false);
                }}
              >
                <label htmlFor={`post-link-${task.id}`} className="sr-only">
                  Post link
                </label>
                <input
                  id={`post-link-${task.id}`}
                  type="url"
                  className="field"
                  placeholder="Paste the post URL…"
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={updateTask.isPending}
                  className="min-h-10 shrink-0 rounded-xl bg-gradient-to-r from-teal-400 to-sky-500 px-3 text-sm font-bold text-[#062a33] disabled:opacity-60"
                >
                  Save
                </button>
              </form>
            )}
            {showCal && (
              <div className="mt-2.5 rounded-xl border border-white/15 bg-black/25 p-3">
                <p className="text-xs font-bold tracking-wide text-white/90">Set phone reminder</p>
                <p className="mt-0.5 text-xs leading-relaxed text-white/70">
                  Adds this task to your phone calendar with a reminder at{" "}
                  {task.time ? fmtTime(task.time) : "its set time"} on {longDate(date)}.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => downloadIcs(task, date)}
                    className="min-h-10 rounded-xl bg-gradient-to-r from-teal-400 to-sky-500 px-3 text-sm font-bold text-[#062a33]"
                  >
                    Download .ics file
                  </button>
                  <a
                    href={googleCalUrl(task, date)}
                    target="_blank"
                    rel="noreferrer"
                    className="grid min-h-10 place-items-center rounded-xl border border-white/25 bg-white/10 px-3 text-sm font-bold text-white hover:bg-white/20"
                  >
                    Add to Google Calendar ↗
                  </a>
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
            {isPost && (
              <CheckCircle done={task.done} onToggle={() => onSetStatus(task.status === "done" ? null : "done")} label={`Mark post ${task.title} ${task.done ? "not posted" : "posted"}`} large />
            )}
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                aria-label={isMissed ? `Clear missed for ${task.title}` : `Mark ${task.title} missed`}
                aria-pressed={isMissed}
                onClick={() => onSetStatus(isMissed ? null : "missed")}
                className={`grid h-8 w-8 place-items-center rounded-lg text-sm ${isMissed ? "bg-red-500/85 text-white" : isPost ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/8 text-[var(--dim)] hover:bg-red-500/40 hover:text-white"}`}
              >
                ✕
              </button>
              <button
                type="button"
                aria-label={`Post link for ${task.title}`}
                aria-pressed={showLinkEditor}
                onClick={() => {
                  setLinkDraft(task.postLink ?? "");
                  setShowLinkEditor(!showLinkEditor);
                }}
                className={`grid h-8 w-8 place-items-center rounded-lg text-sm ${isPost ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/8 text-[var(--dim)] hover:bg-white/15 hover:text-white"}`}
              >
                🔗
              </button>
              <button
                type="button"
                aria-label={`${task.remind ? "Turn off" : "Turn on"} reminder for ${task.title}`}
                aria-pressed={task.remind}
                onClick={() => updateTask.mutate({ remind: !task.remind })}
                className={`grid h-8 w-8 place-items-center rounded-lg text-sm ${isPost ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/8 text-[var(--dim)] hover:bg-white/15 hover:text-white"} ${task.remind ? "" : "opacity-50"}`}
              >
                {task.remind ? "🔔" : "🔕"}
              </button>
              <button
                type="button"
                aria-label={`Set phone reminder for ${task.title}`}
                aria-pressed={showCal}
                title="Set phone reminder"
                onClick={() => setShowCal(!showCal)}
                className={`grid h-8 w-8 place-items-center rounded-lg text-sm ${isPost ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/8 text-[var(--dim)] hover:bg-white/15 hover:text-white"}`}
              >
                📅
              </button>
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
  const [postLink, setPostLink] = useState(existing?.postLink ?? "");
  const [details, setDetails] = useState(existing?.details ?? "");
  const [eventRole, setEventRole] = useState<EventRole | "">((existing?.eventRole ?? "") as EventRole | "");
  const [remind, setRemind] = useState(existing?.remind ?? true);
  const [titleError, setTitleError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        title: title.trim(),
        kind,
        time: time ? time : null,
        projectId: projectId ? Number(projectId) : null,
        recurring: repeat === "daily",
        postLink: postLink.trim() ? postLink.trim() : null,
        details: details.trim() ? details.trim() : null,
        eventRole: kind === "event" && (eventRole === "join" || eventRole === "host") ? eventRole : null,
        remind,
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

  const uid = (field: string) => `${existing ? "edit" : "new"}-${field}`;

  return (
    <form onSubmit={submit} id={existing ? undefined : "add-task-form"} className="glass-soft mt-4 p-3.5 sm:p-4" aria-label={existing ? "Edit item" : "Add an item"}>
      <p className="font-display text-sm font-bold">{existing ? "Edit item" : "Add to this day"}</p>
      <div className="mt-2.5 flex flex-col gap-2.5">
        <div>
          <label htmlFor={existing ? uid("title") : "add-task-title"} className="sr-only">
            Title
          </label>
          <input
            id={existing ? uid("title") : "add-task-title"}
            maxLength={120}
            className="field"
            placeholder="e.g. Fermah chat session, X post, Design review…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {titleError && <p className="mt-1 text-xs font-semibold text-red-200">{titleError}</p>}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div>
            <label htmlFor={uid("time")} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Time
            </label>
            <input
              id={uid("time")}
              type="time"
              className="field"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={uid("kind")} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Type
            </label>
            <select
              id={uid("kind")}
              className="field"
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              <option value="task">Task</option>
              <option value="post">Post</option>
              <option value="discord">Discord</option>
              <option value="event">Event</option>
            </select>
          </div>
          <div>
            <label htmlFor={uid("project")} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Project
            </label>
            <select
              id={uid("project")}
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
            <label htmlFor={uid("repeat")} className="mb-1 block text-xs font-bold text-[var(--dim)]">
              Repeat
            </label>
            <select
              id={uid("repeat")}
              className="field"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as "day" | "daily")}
            >
              <option value="day">This day only</option>
              <option value="daily">Every day</option>
            </select>
          </div>
        </div>
        <div>
          <label htmlFor={uid("post-link")} className="mb-1 block text-xs font-bold text-[var(--dim)]">
            Post link (optional)
          </label>
          <input
            id={uid("post-link")}
            type="url"
            maxLength={500}
            className="field"
            placeholder="https://x.com/.../status/... — paste after you post"
            value={postLink}
            onChange={(e) => setPostLink(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={uid("details")} className="mb-1 block text-xs font-bold text-[var(--dim)]">
            Details (optional)
          </label>
          <input
            id={uid("details")}
            maxLength={500}
            className="field"
            placeholder="Timing, notes, what to say…"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {kind === "event" && (
            <div className="min-w-40 flex-1">
              <label htmlFor={uid("event-role")} className="mb-1 block text-xs font-bold text-[var(--dim)]">
                Event role
              </label>
              <select
                id={uid("event-role")}
                className="field"
                value={eventRole}
                onChange={(e) => setEventRole(e.target.value as EventRole | "")}
              >
                <option value="">Pick one…</option>
                <option value="join">Join</option>
                <option value="host">Host</option>
              </select>
            </div>
          )}
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={remind}
              onChange={(e) => setRemind(e.target.checked)}
              className="h-5 w-5 accent-teal-400"
            />
            Remind me at this time
          </label>
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
                <ProjectLogo name={p.name} color={p.color} />
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
          maxLength={60}
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
        maxLength={300}
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
        maxLength={200}
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

/* ================= History ================= */

function HistoryView({
  todayKey,
  onPick,
}: {
  todayKey: string;
  onPick: (k: string) => void;
}) {
  const [endOffset, setEndOffset] = useState(0);
  const end = addDays(todayKey, -endOffset * 30);
  const start = addDays(end, -29);
  const hist = useQuery({
    queryKey: ["history", start, end],
    queryFn: () => api.getHistory({ from: start, to: end }),
  });

  const days = useMemo(() => [...(hist.data?.days ?? [])].reverse(), [hist.data]);

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold">History</h2>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label="Older days"
            onClick={() => setEndOffset((n) => n + 1)}
            className="glass-soft min-h-9 px-3 text-sm font-bold hover:bg-white/12"
          >
            ← Older
          </button>
          <button
            type="button"
            aria-label="Newer days"
            disabled={endOffset === 0}
            onClick={() => setEndOffset((n) => Math.max(0, n - 1))}
            className="glass-soft min-h-9 px-3 text-sm font-bold hover:bg-white/12 disabled:opacity-40"
          >
            Newer →
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">
        {longDate(start)} – {longDate(end)} · saved forever, never wiped by rollover
      </p>
      {hist.isPending ? (
        <p className="py-10 text-center text-sm text-[var(--dim)]">Loading history…</p>
      ) : hist.isError ? (
        <div className="py-10 text-center">
          <p className="text-sm text-red-200">Could not load history.</p>
          <button
            type="button"
            onClick={() => hist.refetch()}
            className="glass-soft mt-3 min-h-10 px-4 text-sm font-bold"
          >
            Retry
          </button>
        </div>
      ) : days.length === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--dim)]">No work saved in this window yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {days.map((d) => {
            const done = d.tasks.filter((t) => t.status === "done").length;
            const missed = d.tasks.filter((t) => t.status === "missed").length;
            return (
              <li key={d.date} className="glass-soft p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onPick(d.date)}
                    className="font-display text-base font-bold hover:underline"
                  >
                    {longDate(d.date)}
                  </button>
                  <span className="ml-auto text-xs font-bold text-[var(--dim)]">
                    {done} done · {missed} missed · {d.tasks.length - done - missed} pending
                  </span>
                  <span className="text-xs font-bold text-[var(--dim)]">
                    Discord {d.chat.sent}/{d.chat.target}
                  </span>
                </div>
                {d.tasks.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--dim)]">No tasks — chat only.</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {d.tasks.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-[var(--dim)]">{fmtTime(t.time)}</span>
                        <span
                          className={
                            t.status === "done"
                              ? "line-through opacity-70"
                              : t.status === "missed"
                                ? "text-red-300"
                                : ""
                          }
                        >
                          {t.title}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            t.status === "done"
                              ? "bg-teal-400/20 text-teal-200"
                              : t.status === "missed"
                                ? "bg-red-500/25 text-red-200"
                                : "bg-white/10 text-[var(--dim)]"
                          }`}
                        >
                          {t.status === "done" ? "Done ✓" : t.status === "missed" ? "Missed ✕" : "Pending"}
                        </span>
                        {t.projectName && (
                          <span className="text-xs font-bold text-[var(--dim)]">#{t.projectName}</span>
                        )}
                        {t.postLink && (
                          <a
                            href={t.postLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-bold text-sky-300 underline"
                          >
                            View post ↗
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
