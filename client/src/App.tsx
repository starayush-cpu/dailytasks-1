import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  getActiveUserId,
  setActiveUserId,
  type DayTask,
  type EventRole,
  type GetHistoryResponse,
  type HistoryDay,
  type Project,
  type ProjectChat,
  type ProjectColor,
  type TaskKind,
  type TaskStatus,
  type User,
} from "./api";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

type View = "today" | "calendar" | "history" | "chat";
type Filter = "all" | "pending" | "done" | "missed" | "kaito" | "posted";

const COLOR_HEX: Record<ProjectColor, string> = {
  blue: "#3b82f6",
  violet: "#8b5cf6",
  green: "#22c55e",
  orange: "#f59e0b",
  pink: "#ec4899",
  teal: "#14b8a6",
};

const PROJECT_LOGOS: Record<string, string> = {
  fermah: "./fermah-logo.webp",
  dlicom: "./dlicom-logo.svg",
  primus: "./primus-logo.png",
};

const KIND_LABEL: Record<TaskKind, string> = {
  task: "Task",
  post: "Post",
  discord: "Chat",
  event: "Event",
};

const PLATFORM_ICONS = {
  discord: { src: "./discord-logo.svg", label: "Discord" },
  x: { src: "./x-logo.svg", label: "X" },
  kaito: { src: "./kaito-logo.jpg", label: "Kaito" },
} as const;

function platformIcon(src: string, label: string, size = 16) {
  return (
    <img
      src={src}
      alt={label}
      title={label}
      className="platform-icon"
      style={{ width: size, height: size }}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

function projectLogoSrc(p: Pick<Project, "name" | "logo">): string | null {
  if (p.logo) return p.logo;
  const key = p.name.trim().toLowerCase();
  return PROJECT_LOGOS[key] ?? null;
}

// ---------------------------------------------------------------------------
// Date / time helpers (Asia/Kolkata for "today"; task times are local clock)
// ---------------------------------------------------------------------------

function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(dateStr: string, n: number): string {
  // Parse at UTC noon: local-midnight parsing + toISOString() shifts the
  // date by one in IST (midnight IST is 18:30 UTC the day before), which
  // used to make "Yesterday" land on the day before yesterday.
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateLabel(dateStr: string): string {
  const today = todayStr();
  if (dateStr === today) return "Today";
  if (dateStr === addDays(today, 1)) return "Tomorrow";
  if (dateStr === addDays(today, -1)) return "Yesterday";
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

function longDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function fmtTime12(t: string | null): string {
  if (!t) return "Any time";
  const parts = t.split(":");
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** "in 2h 15m" / "30m left" / "Due now" — countdown to the task's own set time. */
function timeLeftLabel(dateStr: string, time: string | null, now: Date): string {
  if (!time) return "Any time today";
  const target = new Date(`${dateStr}T${time}:00`);
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return "Due now";
  const totalMin = Math.floor(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m left`;
  if (m === 0) return `${h}h left`;
  return `${h}h ${m}m left`;
}

function statusOf(t: DayTask): TaskStatus {
  return t.status;
}

function statusLabel(s: TaskStatus): string {
  return s === "done" ? "Done" : s === "missed" ? "Missed" : "Pending";
}

function statusClass(s: TaskStatus): string {
  return s === "done" ? "done" : s === "missed" ? "missed" : "pending";
}

// ---------------------------------------------------------------------------
// Post verification — did the post actually go out?
// The site cannot check X itself (free API gives no post reads, no X login
// on the site), so Rio checks the signed-in X tab daily and writes the
// result here. The badge is quiet by design: nothing extra before the
// task's time, "Posted ✓" once verified, "Not posted yet" once the time
// has passed without a verification, "Link saved" when a link is saved
// but nothing is verified yet.
// ---------------------------------------------------------------------------

function timePassed(dateStr: string, time: string | null, now: Date): boolean {
  const today = todayStr();
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  if (!time) return false;
  const parts = time.split(":");
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

function verifyBadge(t: DayTask, dateStr: string, now: Date): React.ReactNode {
  if (t.kind !== "post") return null;
  if (t.verified) {
    return (
      <span
        className="verified-badge"
        title={t.verifiedSource ? `Post checked live via ${t.verifiedSource}` : "Post checked live"}
      >
        Posted ✓
      </span>
    );
  }
  if (t.posted) return <span className="posted-badge">Posted</span>;
  if (timePassed(dateStr, t.time, now)) return <span className="not-posted-badge">Not posted yet</span>;
  if (t.postLink) return <span className="link-saved-badge">Link saved</span>;
  return null;
}

function hasEngagement(t: DayTask): boolean {
  return t.views != null || t.likes != null || t.reposts != null || t.replies != null;
}

function engagementTotal(t: DayTask): number {
  return (t.views ?? 0) + (t.likes ?? 0) + (t.reposts ?? 0) + (t.replies ?? 0);
}

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? "AM" : "PM"}`;
}

// ---------------------------------------------------------------------------
// Phone reminders (.ics + Google Calendar) — always name the project.
// ---------------------------------------------------------------------------

function icsText(t: DayTask, dateStr: string, time: string): string {
  const dt = dateStr.replace(/-/g, "") + "T" + time.replace(":", "") + "00";
  const end = new Date(`${dateStr}T${time}:00`);
  end.setMinutes(end.getMinutes() + 15);
  const endDt =
    end.toISOString().slice(0, 10).replace(/-/g, "") +
    "T" +
    end.toISOString().slice(11, 16).replace(":", "") +
    "00";
  const project = t.projectName ? `[${t.projectName}] ` : "";
  const title = `${project}${t.title}`;
  const descParts = [`Project: ${t.projectName ?? "No project"}`, `Type: ${KIND_LABEL[t.kind]}`];
  if (t.kind === "event" && t.eventRole) descParts.push(`Role: ${t.eventRole === "play" ? "Play" : "Host"}`);
  if (t.kind === "post" && t.kaito) descParts.push("Post on Kaito: yes");
  if (t.details) descParts.push(t.details);
  if (t.postLink) descParts.push(`Post link: ${t.postLink}`);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Daily Hub//EN",
    "BEGIN:VEVENT",
    `UID:${t.id}-${dateStr}@dailyhub`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
    `DTSTART:${dt}`,
    `DTEND:${endDt}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${descParts.join(" | ")}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${title}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function gcalLink(t: DayTask, dateStr: string, time: string): string {
  const start = new Date(`${dateStr}T${time}:00`);
  const end = new Date(start.getTime() + 15 * 60000);
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const project = t.projectName ? `[${t.projectName}] ` : "";
  const details = [
    `Project: ${t.projectName ?? "No project"}`,
    `Type: ${KIND_LABEL[t.kind]}`,
    t.kind === "event" && t.eventRole ? `Role: ${t.eventRole === "play" ? "Play" : "Host"}` : "",
    t.kind === "post" && t.kaito ? "Post on Kaito: yes" : "",
    t.details ?? "",
  ]
    .filter(Boolean)
    .join(" | ");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${project}${t.title}`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function downloadIcs(t: DayTask, dateStr: string) {
  const time = t.time ?? "09:00";
  const blob = new Blob([icsText(t, dateStr, time)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `daily-hub-${t.id}-${dateStr}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Avatar({ src, name, size = 40 }: { src?: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  if (!src || failed) {
    return (
      <span className="avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.42 }}>
        {initial}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      className="avatar-img"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}

function ProjectAvatar({ project, size = 30 }: { project: Pick<Project, "name" | "color" | "logo">; size?: number }) {
  const src = projectLogoSrc(project);
  if (src) {
    return (
      <img
        src={src}
        alt={project.name}
        className="project-logo"
        style={{ width: size, height: size }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span
      className="color-dot"
      style={{ background: COLOR_HEX[project.color], width: size, height: size, flexShrink: 0 }}
    />
  );
}

function StatusCircle({
  status,
  onDone,
  onMissed,
  size = 26,
}: {
  status: TaskStatus;
  onDone: () => void;
  onMissed: () => void;
  size?: number;
}) {
  return (
    <button
      type="button"
      className={`status-circle ${statusClass(status)}`}
      style={{ width: size, height: size, fontSize: size * 0.62 }}
      onClick={(e) => {
        e.stopPropagation();
        onDone();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMissed();
      }}
      title={status === "done" ? "Done — click to undo, right-click to mark missed" : "Click to mark done, right-click to mark missed"}
      aria-label={status === "done" ? "Done, click to undo" : "Mark done"}
    >
      {status === "done" ? "✓" : status === "missed" ? "✕" : ""}
    </button>
  );
}

function TimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // Stored value stays 24h "HH:MM"; the picker shows 12h with an AM/PM toggle.
  const parts = value.split(":");
  const h24 = Number(parts[0] ?? 0) || 0;
  const minute = Number(parts[1] ?? 0) || 0;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

  const emit = (nextH12: number, nextMinute: number, nextAmpm: "AM" | "PM") => {
    // 12 AM = 00, 12 PM = 12, 1-11 AM = same, 1-11 PM = +12.
    const hh = nextAmpm === "AM" ? nextH12 % 12 : (nextH12 % 12) + 12;
    onChange(`${String(hh).padStart(2, "0")}:${String(nextMinute).padStart(2, "0")}`);
  };

  const QUICK_TIMES = [
    { label: "9 AM", value: "09:00" },
    { label: "12 PM", value: "12:00" },
    { label: "6 PM", value: "18:00" },
    { label: "9 PM", value: "21:00" },
  ] as const;

  return (
    <div className="time-picker">
      <div className="time-12h">
        <select
          value={h12}
          onChange={(e) => emit(Number(e.target.value), minute, ampm)}
          aria-label="Hour"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span className="time-colon" aria-hidden="true">
          :
        </span>
        <select
          value={minute}
          onChange={(e) => emit(h12, Number(e.target.value), ampm)}
          aria-label="Minute"
        >
          {Array.from({ length: 60 }, (_, i) => i).map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, "0")}
            </option>
          ))}
        </select>
        <div className="ampm-toggle" role="group" aria-label="AM or PM">
          <button
            type="button"
            className={ampm === "AM" ? "active" : ""}
            aria-pressed={ampm === "AM"}
            onClick={() => emit(h12, minute, "AM")}
          >
            AM
          </button>
          <button
            type="button"
            className={ampm === "PM" ? "active" : ""}
            aria-pressed={ampm === "PM"}
            onClick={() => emit(h12, minute, "PM")}
          >
            PM
          </button>
        </div>
      </div>
      <div className="time-quick-row" role="group" aria-label="Quick times">
        {QUICK_TIMES.map((q) => (
          <button
            key={q.value}
            type="button"
            className={`time-quick ${value === q.value ? "active" : ""}`}
            aria-pressed={value === q.value}
            onClick={() => onChange(q.value)}
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

type TaskRowProps = {
  t: DayTask;
  dateStr: string;
  now: Date;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleDone: () => void;
  onMarkMissed: () => void;
  onTogglePosted: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSaved: (msg: string) => void;
  saving: boolean;
};

function TaskRow({
  t,
  dateStr,
  now,
  expanded,
  onToggleExpand,
  onToggleDone,
  onMarkMissed,
  onTogglePosted,
  onEdit,
  onDelete,
  onSaved,
  saving,
}: TaskRowProps) {
  const st = statusOf(t);
  const [linkDraft, setLinkDraft] = useState(t.postLink ?? "");
  const [linkSaved, setLinkSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setLinkDraft(t.postLink ?? ""), [t.postLink]);
  const color = t.projectColor ? COLOR_HEX[t.projectColor] : "rgba(255,255,255,0.25)";
  const timeLeft = timeLeftLabel(dateStr, t.time, now);
  // The title often already names the project ("Post about fermah") — then
  // the chip shows just the project mark instead of repeating the name.
  const titleNamesProject =
    !!t.projectName && t.title.toLowerCase().includes(t.projectName.toLowerCase());

  return (
    <div
      className={`task-row ${statusClass(st)} ${expanded ? "expanded" : ""}`}
      style={{ borderLeftColor: color }}
    >
      <div className="task-main" onClick={onToggleExpand} role="button" tabIndex={0}>
        <StatusCircle status={st} onDone={onToggleDone} onMissed={onMarkMissed} />
        <div className="task-text">
          <div className="task-title-row">
            <span className="task-title">{t.title}</span>
            {t.kind === "post" && t.kaito && (
              <span className="kaito-badge" title="Post on Kaito">
                {platformIcon(PLATFORM_ICONS.kaito.src, "Kaito", 16)} Kaito
              </span>
            )}
            {verifyBadge(t, dateStr, now)}
            {t.kind === "event" && t.eventRole && (
              <span className={`event-role-badge ${t.eventRole}`}>
                {t.eventRole === "play" ? "▶ Play" : "🎤 Host"}
              </span>
            )}
          </div>
          <div className="task-meta">
            {t.projectName && (
              <span className="task-project" title={titleNamesProject ? t.projectName : undefined}>
                <ProjectAvatar
                  project={{
                    name: t.projectName,
                    color: t.projectColor ?? "blue",
                    logo: null,
                  }}
                  size={30}
                />
                {!titleNamesProject && t.projectName}
              </span>
            )}
            <span className="task-time">🕐 {fmtTime12(t.time)}</span>
            {t.time && st === "pending" && <span className="task-countdown">{timeLeft}</span>}
            {t.kind === "post" && (
              <span className="task-platforms">
                {platformIcon(PLATFORM_ICONS.x.src, "X", 18)}
                {t.kaito && platformIcon(PLATFORM_ICONS.kaito.src, "Kaito", 18)}
              </span>
            )}
            {t.kind === "discord" && (
              <span className="task-platforms">{platformIcon(PLATFORM_ICONS.discord.src, "Discord", 18)}</span>
            )}
            {t.recurring && <span className="task-recurring">↻ Daily</span>}
          </div>
        </div>
        <span className="task-expand" aria-hidden>
          {expanded ? "▴" : "▾"}
        </span>
      </div>

      {expanded && (
        <div className="task-detail">
          {t.details && <p className="task-details">{t.details}</p>}
          {t.kind === "post" && hasEngagement(t) && (
            <p className="task-engagement">
              👁 {fmtNum(t.views)} views · ♥ {fmtNum(t.likes)} · ↻ {fmtNum(t.reposts)} reposts · 💬{" "}
              {fmtNum(t.replies)} replies
            </p>
          )}
          {t.kind === "post" && (
            <div className="task-link-row">
              <input
                type="url"
                value={linkDraft}
                placeholder="Paste the post link here…"
                onChange={(e) => {
                  setLinkDraft(e.target.value);
                  setLinkSaved(false);
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label="Post link"
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={saving || linkDraft === (t.postLink ?? "")}
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.updateTask({
                    id: t.id,
                    title: t.title,
                    kind: t.kind,
                    time: t.time,
                    projectId: t.projectId,
                    date: dateStr,
                    recurring: t.recurring,
                    postLink: linkDraft.trim() || null,
                    details: t.details,
                    eventRole: t.eventRole,
                    remind: t.remind,
                    kaito: t.kaito,
                  });
                  setLinkSaved(true);
                  onSaved("Post link saved");
                }}
              >
                {saving ? "Saving…" : linkSaved ? "Saved ✓" : "Save link"}
              </button>
              {t.postLink && (
                <a className="btn btn-ghost" href={t.postLink} target="_blank" rel="noreferrer">
                  Open post ↗
                </a>
              )}
            </div>
          )}
          <div className="task-actions">
            <button type="button" className="btn btn-primary" onClick={onToggleDone} disabled={saving}>
              {st === "done" ? "Undo done" : "Mark done"}
            </button>
            {st !== "missed" && (
              <button type="button" className="btn btn-secondary" onClick={onMarkMissed} disabled={saving}>
                Mark missed
              </button>
            )}
            {t.kind === "post" && (
              <button
                type="button"
                className={`btn ${t.posted ? "btn-ghost" : "btn-secondary"}`}
                onClick={onTogglePosted}
                disabled={saving}
                title="Posted is separate from Done — mark it only when the post is actually live"
              >
                {t.posted ? "Unmark posted" : "Mark posted"}
              </button>
            )}
            {t.remind && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    downloadIcs(t, dateStr);
                    onSaved("Calendar file downloaded");
                  }}
                >
                  📅 Add to phone
                </button>
                <a className="btn btn-ghost" href={gcalLink(t, dateStr, t.time ?? "09:00")} target="_blank" rel="noreferrer">
                  Google Calendar
                </a>
              </>
            )}
            <button type="button" className="btn btn-ghost" onClick={onEdit}>
              Edit
            </button>
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={onDelete}
                  disabled={saving}
                >
                  Delete now
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-ghost btn-danger-text" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task form (add + edit)
// ---------------------------------------------------------------------------

type TaskFormProps = {
  projects: Project[];
  initial: {
    id?: number;
    title: string;
    kind: TaskKind;
    time: string;
    projectId: number | null;
    date: string;
    recurring: boolean;
    postLink: string;
    details: string;
    eventRole: EventRole | null;
    remind: boolean;
    kaito: boolean;
    // Engagement belongs to this task on `date` (the day being edited).
    engagement?: {
      views: number | null;
      likes: number | null;
      reposts: number | null;
      replies: number | null;
    };
  };
  onSave: (v: TaskFormProps["initial"]) => Promise<void> | void;
  onCancel: () => void;
  saving: boolean;
};

function TaskForm({ projects, initial, onSave, onCancel, saving }: TaskFormProps) {
  const [title, setTitle] = useState(initial.title);
  const [kind, setKind] = useState<TaskKind>(initial.kind);
  const [time, setTime] = useState(initial.time);
  const [projectId, setProjectId] = useState<number | null>(initial.projectId);
  const [date, setDate] = useState(initial.date);
  const [recurring, setRecurring] = useState(initial.recurring);
  const [postLink, setPostLink] = useState(initial.postLink);
  const [details, setDetails] = useState(initial.details);
  const [eventRole, setEventRole] = useState<EventRole | null>(initial.eventRole);
  const [remind, setRemind] = useState(initial.remind);
  const [kaito, setKaito] = useState(initial.kaito);
  const [views, setViews] = useState(initial.engagement?.views != null ? String(initial.engagement.views) : "");
  const [likes, setLikes] = useState(initial.engagement?.likes != null ? String(initial.engagement.likes) : "");
  const [reposts, setReposts] = useState(
    initial.engagement?.reposts != null ? String(initial.engagement.reposts) : "",
  );
  const [replies, setReplies] = useState(
    initial.engagement?.replies != null ? String(initial.engagement.replies) : "",
  );
  const [error, setError] = useState("");

  function parseEng(v: string): number | null {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  const activeProjects = projects.filter((p) => !p.ended);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Give the task a title.");
      return;
    }
    if (kind === "event" && !eventRole) {
      setError("Pick Play or Host for this event.");
      return;
    }
    onSave({
      ...initial,
      title: title.trim(),
      kind,
      time: time || "",
      projectId,
      date,
      recurring,
      postLink: postLink.trim(),
      details: details.trim(),
      eventRole: kind === "event" ? eventRole : null,
      remind,
      kaito: kind === "post" ? kaito : false,
      engagement:
        kind === "post" && initial.id
          ? { views: parseEng(views), likes: parseEng(likes), reposts: parseEng(reposts), replies: parseEng(replies) }
          : undefined,
    });
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Post about Fermah" autoFocus />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            <option value="task">Task</option>
            <option value="post">Post</option>
            <option value="discord">Discord chat</option>
            <option value="event">Event</option>
          </select>
        </label>
        <label className="field">
          <span>Project</span>
          <select
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">No project</option>
            {activeProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {kind === "event" && (
        <div className="field">
          <span>Event role</span>
          <div className="segmented">
            <button
              type="button"
              className={eventRole === "play" ? "active" : ""}
              onClick={() => setEventRole("play")}
              aria-pressed={eventRole === "play"}
            >
              ▶ Play
            </button>
            <button
              type="button"
              className={eventRole === "host" ? "active" : ""}
              onClick={() => setEventRole("host")}
              aria-pressed={eventRole === "host"}
            >
              🎤 Host
            </button>
          </div>
          <small className="field-hint">
            Play and Host are separate — the same project can have both on the same day, at different times.
          </small>
        </div>
      )}
      <div className="field-row">
        <div className="field">
          <span>Time</span>
          <TimePicker value={time} onChange={setTime} />
        </div>
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={recurring} />
        </label>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
        <span>Repeat every day</span>
      </label>
      {kind === "post" && (
        <>
          <label className="field">
            <span>Post link (optional)</span>
            <input
              type="url"
              value={postLink}
              onChange={(e) => setPostLink(e.target.value)}
              placeholder="https://x.com/…"
            />
          </label>
          <label className="check-row kaito-row">
            <input type="checkbox" checked={kaito} onChange={(e) => setKaito(e.target.checked)} />
            {platformIcon(PLATFORM_ICONS.kaito.src, "Kaito", 20)}
            <span>Post this on Kaito too</span>
          </label>
          {initial.id && (
            <div className="field">
              <span>Engagement for {dateLabel(date)} (optional)</span>
              <div className="engagement-grid">
                <label>
                  <span>Views</span>
                  <input type="text" inputMode="numeric" value={views} onChange={(e) => setViews(e.target.value)} placeholder="0" aria-label="Views" />
                </label>
                <label>
                  <span>Likes</span>
                  <input type="text" inputMode="numeric" value={likes} onChange={(e) => setLikes(e.target.value)} placeholder="0" aria-label="Likes" />
                </label>
                <label>
                  <span>Reposts</span>
                  <input type="text" inputMode="numeric" value={reposts} onChange={(e) => setReposts(e.target.value)} placeholder="0" aria-label="Reposts" />
                </label>
                <label>
                  <span>Replies</span>
                  <input type="text" inputMode="numeric" value={replies} onChange={(e) => setReplies(e.target.value)} placeholder="0" aria-label="Replies" />
                </label>
              </div>
              <small className="field-hint">Numbers for this day&apos;s post — they feed the best-time-to-post panel.</small>
            </div>
          )}
        </>
      )}
      <label className="field">
        <span>Details (optional)</span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2} placeholder="Anything to remember…" />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
        <span>Remind me at this time</span>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : initial.id ? "Save changes" : "Add task"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Project form (add + edit) — logo field, Ended toggle
// ---------------------------------------------------------------------------

type ProjectFormProps = {
  initial?: { id: number; name: string; color: ProjectColor; link: string; note: string; logo: string; ended: boolean };
  onSave: (v: { id?: number; name: string; color: ProjectColor; link: string; note: string; logo: string; ended: boolean }) => Promise<void> | void;
  onCancel: () => void;
  saving: boolean;
};

const COLOR_ORDER: ProjectColor[] = ["blue", "violet", "green", "orange", "pink", "teal"];

function ProjectForm({ initial, onSave, onCancel, saving }: ProjectFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<ProjectColor>(initial?.color ?? "blue");
  const [link, setLink] = useState(initial?.link ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [logo, setLogo] = useState(initial?.logo ?? "");
  const [ended, setEnded] = useState(initial?.ended ?? false);
  const [error, setError] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the project a name.");
      return;
    }
    onSave({ id: initial?.id, name: name.trim(), color, link: link.trim(), note: note.trim(), logo: logo.trim(), ended });
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <label className="field">
        <span>Project name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fermah" autoFocus />
      </label>
      <div className="field">
        <span>Colour</span>
        <div className="color-row">
          {COLOR_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-pick ${color === c ? "active" : ""}`}
              style={{ background: COLOR_HEX[c] }}
              onClick={() => setColor(c)}
              aria-label={c}
              aria-pressed={color === c}
            />
          ))}
        </div>
      </div>
      <label className="field">
        <span>Discord link (optional)</span>
        <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://discord.com/…" />
      </label>
      <label className="field">
        <span>Logo image URL (optional)</span>
        <input
          type="url"
          value={logo}
          onChange={(e) => setLogo(e.target.value)}
          placeholder="https://…/logo.png — or tell me and I will add it"
        />
        <small className="field-hint">Shown next to the project name. Leave empty to use the colour dot.</small>
        {logo.trim() && (
          <span className="logo-preview">
            <span>Preview</span>
            <ProjectAvatar project={{ name: name.trim() || "Project", color, logo: logo.trim() }} size={30} />
          </span>
        )}
      </label>
      <label className="field">
        <span>Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is this project about?" />
      </label>
      {initial && (
        <label className="check-row">
          <input type="checkbox" checked={ended} onChange={(e) => setEnded(e.target.checked)} />
          <span>Project ended — hide from the active schedule, keep all history</span>
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : initial ? "Save project" : "Add project"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// User form (add + edit) — name + photo URL
// ---------------------------------------------------------------------------

type UserFormProps = {
  initial?: User;
  onSave: (v: { id?: number; name: string; photo: string }) => Promise<void> | void;
  onCancel: () => void;
  saving: boolean;
};

function UserForm({ initial, onSave, onCancel, saving }: UserFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [photo, setPhoto] = useState(initial?.photo ?? "");
  const [error, setError] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the user a name.");
      return;
    }
    onSave({ id: initial?.id, name: name.trim(), photo: photo.trim() });
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ayush" autoFocus />
      </label>
      <label className="field">
        <span>Photo image URL (optional)</span>
        <input type="url" value={photo} onChange={(e) => setPhoto(e.target.value)} placeholder="https://…/photo.jpg" />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : initial ? "Save user" : "Add user"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Day detail — click any date to see what happened that day
// ---------------------------------------------------------------------------

function DayDetail({
  date,
  onClose,
  onJumpToSchedule,
}: {
  date: string;
  onClose: () => void;
  onJumpToSchedule: (date: string) => void;
}) {
  const initialDay = api.getCachedHistory({ from: date, to: date });
  const [day, setDay] = useState<HistoryDay | null>(initialDay?.days[0] ?? null);
  const [loading, setLoading] = useState(initialDay == null);
  useEffect(() => {
    if (api.getCachedHistory({ from: date, to: date })) return;
    let alive = true;
    setLoading(true);
    api
      .getHistory({ from: date, to: date })
      .then((h: GetHistoryResponse) => {
        if (alive) setDay(h.days[0] ?? null);
      })
      .catch(() => {
        if (alive) setDay(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [date]);

  const tasks = day?.tasks ?? [];
  const done = tasks.filter((t) => t.status === "done").length;
  const missed = tasks.filter((t) => t.status === "missed").length;
  const pending = tasks.length - done - missed;
  const byProject = useMemo(() => {
    const map = new Map<string, DayTask[]>();
    for (const t of tasks) {
      const key = t.projectName ?? "No project";
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [tasks]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal day-detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`What happened on ${date}`}>
        <div className="modal-head">
          <div>
            <h3>{longDateLabel(date)}</h3>
            <p className="modal-sub">
              {loading
                ? "Loading…"
                : tasks.length === 0
                  ? "Nothing scheduled that day."
                  : `${done} done · ${missed} missed · ${pending} pending`}
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>
        {loading ? (
          <div className="skeleton-block" aria-label="Loading that day">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        ) : tasks.length === 0 ? (
          <p className="empty-note">No tasks were scheduled for this day.</p>
        ) : (
          <div className="day-detail-list">
            {byProject.map(([name, list]) => (
              <div key={name} className="day-detail-project">
                <h4>{name}</h4>
                {list.map((t) => (
                  <div key={t.id} className={`day-detail-task ${statusClass(t.status)}`}>
                    <span className="day-detail-status">{t.status === "done" ? "✓" : t.status === "missed" ? "✕" : "○"}</span>
                    <span className="day-detail-title">{t.title}</span>
                    <span className="day-detail-time">{fmtTime12(t.time)}</span>
                    {verifyBadge(t, date, new Date()) ?? (
                      <span className={`day-detail-badge ${statusClass(t.status)}`}>{statusLabel(t.status)}</span>
                    )}
                    {t.kind === "event" && t.eventRole && (
                      <span className={`event-role-badge ${t.eventRole}`}>
                        {t.eventRole === "play" ? "▶ Play" : "🎤 Host"}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="day-detail-foot">
          <span>
            Discord chat: {day?.chat.sent ?? 0} / {day?.chat.target ?? 50} messages
          </span>
          <button type="button" className="btn btn-primary" onClick={() => onJumpToSchedule(date)}>
            Open in schedule
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Best time to post — average engagement per posting hour, from verified
// posts that have engagement numbers. Needs at least 5 such posts before
// it says anything; until then it says so plainly.
// ---------------------------------------------------------------------------

function BestTimePanel() {
  const range = useMemo(() => {
    const to = todayStr();
    const fromD = new Date(to + "T12:00:00Z");
    fromD.setUTCDate(fromD.getUTCDate() - 29);
    return { from: fromD.toISOString().slice(0, 10), to };
  }, []);
  // Render instantly from the history cache when a recent read exists
  // (returning from History/Calendar remounts this panel — no refetch).
  const initialHistory = api.getCachedHistory(range);
  const [history, setHistory] = useState<GetHistoryResponse | null>(initialHistory);
  const [loading, setLoading] = useState(initialHistory == null);

  useEffect(() => {
    if (api.getCachedHistory(range)) return;
    let alive = true;
    setLoading(true);
    api
      .getHistory(range)
      .then((h: GetHistoryResponse) => {
        if (alive) setHistory(h);
      })
      .catch(() => {
        if (alive) setHistory(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range]);

  const samples = useMemo(() => {
    if (!history) return [];
    const out: { hour: number; total: number }[] = [];
    for (const d of history.days) {
      for (const t of d.tasks) {
        if (t.kind !== "post" || !t.verified || !t.time) continue;
        if (!hasEngagement(t)) continue;
        out.push({ hour: Number(t.time.split(":")[0] ?? 0), total: engagementTotal(t) });
      }
    }
    return out;
  }, [history]);

  const byHour = useMemo(() => {
    const m = new Map<number, { n: number; sum: number }>();
    for (const s of samples) {
      const e = m.get(s.hour) ?? { n: 0, sum: 0 };
      e.n += 1;
      e.sum += s.total;
      m.set(s.hour, e);
    }
    return [...m.entries()]
      .map(([hour, v]) => ({ hour, n: v.n, avg: Math.round(v.sum / v.n) }))
      .sort((a, b) => a.hour - b.hour);
  }, [samples]);

  const best = byHour.length > 0 ? Math.max(...byHour.map((b) => b.avg)) : 0;

  return (
    <section className="panel best-time-panel">
      <div className="panel-head">
        <div>
          <h2>Best time to post</h2>
          <p className="panel-sub">Average engagement per posting hour, from verified posts.</p>
        </div>
      </div>
      {loading ? (
        <div className="skeleton-block" aria-label="Loading post data">
          <div className="skeleton-line" style={{ width: "72%" }} />
          <div className="skeleton-line" style={{ width: "54%" }} />
          <div className="skeleton-line" style={{ width: "63%" }} />
        </div>
      ) : samples.length < 5 ? (
        <p className="empty-note">
          Not enough data yet — fill engagement on a few posted tasks and the best time will appear here. (
          {samples.length} of 5 posted tasks with engagement so far.)
        </p>
      ) : (
        <div className="best-time-list">
          {byHour.map((b) => (
            <div key={b.hour} className="best-time-row">
              <span className="best-time-label">{hourLabel(b.hour)}</span>
              <div className="best-time-track">
                <span
                  className={`best-time-fill ${b.avg === best ? "best" : ""}`}
                  style={{ width: `${best > 0 ? Math.max(4, Math.round((b.avg / best) * 100)) : 0}%` }}
                />
              </div>
              <span className="best-time-val">
                {fmtNum(b.avg)} avg · {b.n} {b.n === 1 ? "post" : "posts"}
              </span>
            </div>
          ))}
          <p className="panel-sub">
            Best: {byHour.filter((b) => b.avg === best).map((b) => hourLabel(b.hour)).join(", ")} — based on{" "}
            {samples.length} verified posts from the last 30 days.
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------

function HistoryView({ onDayClick }: { onDayClick: (date: string) => void }) {
  const [range, setRange] = useState(14);
  const rangeKey = useMemo(() => {
    const to = todayStr();
    return { from: addDays(to, -(range - 1)), to };
  }, [range]);
  const initialData = api.getCachedHistory(rangeKey);
  const [data, setData] = useState<GetHistoryResponse | null>(initialData);
  const [loading, setLoading] = useState(initialData == null);

  useEffect(() => {
    if (api.getCachedHistory(rangeKey)) return;
    let alive = true;
    setLoading(true);
    api
      .getHistory(rangeKey)
      .then((h) => {
        if (alive) setData(h);
      })
      .catch(() => {
        if (alive) setData({ days: [] });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [rangeKey]);

  // One row per date, newest first (defensive: collapse any duplicate date
  // the server might ever return).
  const days = useMemo(() => {
    const seen = new Set<string>();
    return [...(data?.days ?? [])]
      .filter((d) => (seen.has(d.date) ? false : (seen.add(d.date), true)))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [data]);

  return (
    <section className="panel history-panel">
      <div className="panel-head">
        <div>
          <h2>History</h2>
          <p className="panel-sub">Every day is saved forever. Click a day to see what you did.</p>
        </div>
        <div className="segmented">
          {[7, 14, 30].map((r) => (
            <button key={r} type="button" className={range === r ? "active" : ""} onClick={() => setRange(r)}>
              {r} days
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="skeleton-block" aria-label="Loading history">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : days.length === 0 ? (
        <p className="empty-note">No history yet. Complete a task and it will show up here.</p>
      ) : (
        <div className="history-list">
          {days.map((d) => {
            const done = d.tasks.filter((t) => t.status === "done").length;
            const missed = d.tasks.filter((t) => t.status === "missed").length;
            const pending = d.tasks.length - done - missed;
            const pct = d.tasks.length > 0 ? Math.round((done / d.tasks.length) * 100) : 0;
            return (
              <button key={d.date} type="button" className="history-day" onClick={() => onDayClick(d.date)}>
                <div className="history-day-main">
                  <span className="history-date">{dateLabel(d.date)}</span>
                  <span className="history-counts">
                    {done} done · {missed} missed · {pending} pending
                  </span>
                  <span className="history-chat">💬 {d.chat.sent}/{d.chat.target}</span>
                </div>
                <div className="history-bar">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="history-pct">{pct}%</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

export function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [activeUserId, setActiveUserIdState] = useState<number>(getActiveUserId());
  const [view, setView] = useState<View>("today");
  const [selectedDate, setSelectedDate] = useState<string>(todayStr());
  const [data, setData] = useState<{
    date: string;
    projects: Project[];
    tasks: DayTask[];
    chat: { target: number; sent: number };
    projectChat: ProjectChat[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [editingTask, setEditingTask] = useState<DayTask | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showUserForm, setShowUserForm] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [dayDetailDate, setDayDetailDate] = useState<string | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [sound, setSound] = useState(true);
  const [reminders, setReminders] = useState(true);
  const [month, setMonth] = useState(() => {
    const t = todayStr();
    return { year: Number(t.slice(0, 4)), month: Number(t.slice(5, 7)) - 1 };
  });
  const [monthData, setMonthData] = useState<{ days: { date: string; total: number; done: number }[]; recurringCount: number } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [chatTargetDraft, setChatTargetDraft] = useState("50");
  const announcedRef = useRef<Set<string>>(new Set());
  const toastTimer = useRef<number | null>(null);
  // Monotonic id of the latest loadDay request. Day loads are async and
  // Neon response times vary a lot (cold starts), so an older request can
  // resolve AFTER a newer one; without this guard the stale response
  // overwrites the selected day's data and the list shows the wrong day
  // until a hard refresh. Only the latest request may touch state.
  const loadDaySeq = useRef(0);

  const activeUser = users.find((u) => u.id === activeUserId) ?? users[0] ?? null;
  const activeProjects = useMemo(() => (data?.projects ?? []).filter((p) => !p.ended), [data]);
  const endedProjects = useMemo(() => (data?.projects ?? []).filter((p) => p.ended), [data]);
  const isToday = selectedDate === todayStr();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const res = await api.getUsers();
      setUsers(res.users);
      if (!res.users.some((u) => u.id === activeUserId) && res.users.length > 0) {
        setActiveUserIdState(res.users[0]!.id);
        setActiveUserId(res.users[0]!.id);
      }
    } catch {
      setUsers([{ id: 1, name: "Ayush", photo: "./ayush-pfp.jpg" }]);
    }
  }, [activeUserId]);

  const loadDay = useCallback(
    async (date: string) => {
      const mySeq = ++loadDaySeq.current;
      setLoading(true);
      try {
        const res = await api.getDay({ date });
        // A newer day was requested while this one was in flight: drop the
        // stale response instead of overwriting the selected day's list.
        if (mySeq !== loadDaySeq.current) return;
        setData(res);
        setChatTargetDraft(String(res.chat.target));
      } catch {
        if (mySeq !== loadDaySeq.current) return;
        setData(null);
      } finally {
        if (mySeq === loadDaySeq.current) setLoading(false);
      }
    },
    [],
  );

  const loadMonth = useCallback(async (year: number, m: number) => {
    try {
      const res = await api.getMonth({ month: `${year}-${String(m + 1).padStart(2, "0")}` });
      setMonthData(res);
    } catch {
      setMonthData(null);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    loadDay(selectedDate);
  }, [selectedDate, activeUserId, loadDay]);

  useEffect(() => {
    if (view === "calendar") loadMonth(month.year, month.month);
  }, [view, month, loadMonth]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(t);
  }, []);

  // ---- announcements: name the task's own project, count to its own time ----
  const announceText = useCallback((t: DayTask, dateStr: string, nowDate: Date): string => {
    const name = activeUser?.name ?? "Ayush";
    const project = t.projectName ? ` for ${t.projectName}` : "";
    const when = t.time ? ` at ${fmtTime12(t.time)}` : "";
    const left = timeLeftLabel(dateStr, t.time, nowDate);
    return `${name}, time for${project} — ${t.title}${when}. ${left === "Due now" ? "It is due now." : `${left}.`}`;
  }, [activeUser]);

  const speak = useCallback(
    (text: string) => {
      if (!sound || !("speechSynthesis" in window)) return;
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      } catch {
        // Speech unavailable.
      }
    },
    [sound],
  );

  const notify = useCallback((title: string, body: string) => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      try {
        new Notification(title, { body });
      } catch {
        // Notifications unavailable.
      }
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  const announceTask = useCallback(
    (t: DayTask, dateStr: string, nowDate: Date) => {
      const text = announceText(t, dateStr, nowDate);
      speak(text);
      notify(`Daily Hub — ${t.projectName ?? "Task"}`, `${t.title} · ${fmtTime12(t.time)}`);
    },
    [announceText, speak, notify],
  );

  // Scheduled reminders: only for today's pending tasks with reminders on,
  // and only while this project is still active (ended projects are not in
  // the day data at all, so their reminders stop by construction).
  useEffect(() => {
    if (!reminders || !data || !isToday) return;
    const id = window.setInterval(() => {
      const current = new Date();
      for (const t of data.tasks) {
        if (!t.remind || t.status !== "pending" || !t.time) continue;
        const key = `${t.id}|${data.date}|${t.time}`;
        if (announcedRef.current.has(key)) continue;
        const target = new Date(`${data.date}T${t.time}:00`);
        const diff = current.getTime() - target.getTime();
        if (diff >= 0 && diff < 120000) {
          announcedRef.current.add(key);
          announceTask(t, data.date, current);
        }
      }
    }, 30000);
    return () => window.clearInterval(id);
  }, [reminders, data, isToday, announceTask]);

  const testVoice = useCallback(() => {
    const next =
      data?.tasks.find((t) => t.kind === "post" && t.status === "pending") ??
      data?.tasks.find((t) => t.status === "pending");
    if (next && data) {
      speak(announceText(next, data.date, new Date()));
    } else {
      speak(`${activeUser?.name ?? "Ayush"}, all caught up. No pending tasks right now.`);
    }
    showToast("Test announcement played");
  }, [data, activeUser, announceText, speak, showToast]);

  // ---- derived day stats ----
  const tasks = data?.tasks ?? [];
  const sortedTasks = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const ta = a.time ?? "99:99";
        const tb = b.time ?? "99:99";
        return ta.localeCompare(tb) || a.id - b.id;
      }),
    [tasks],
  );
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const missedCount = tasks.filter((t) => t.status === "missed").length;
  const pendingCount = tasks.length - doneCount - missedCount;
  const progressPct = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;
  const nextTask = useMemo(() => {
    if (!isToday) return null;
    const pending = sortedTasks.filter((t) => t.status === "pending" && t.time);
    if (pending.length === 0) return null;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const upcoming = pending.filter((t) => {
      const parts = t.time!.split(":");
      const h = Number(parts[0] ?? 0);
      const m = Number(parts[1] ?? 0);
      return h * 60 + m >= nowMin;
    });
    return upcoming[0] ?? pending[pending.length - 1]!;
  }, [sortedTasks, isToday, now]);
  // Sidebar glance: the next thing coming up (today's next task, or the
  // first pending task of the selected day when browsing another date).
  const glanceNext = nextTask ?? sortedTasks.find((t) => t.status === "pending") ?? null;

  const filteredTasks = useMemo(() => {
    switch (filter) {
      case "pending":
        return sortedTasks.filter((t) => t.status === "pending");
      case "done":
        return sortedTasks.filter((t) => t.status === "done");
      case "missed":
        return sortedTasks.filter((t) => t.status === "missed");
      case "kaito":
        return sortedTasks.filter((t) => t.kind === "post" && t.kaito);
      case "posted":
        return sortedTasks.filter((t) => t.kind === "post" && t.posted);
      default:
        return sortedTasks;
    }
  }, [sortedTasks, filter]);

  const chat = data?.chat ?? { target: 50, sent: 0 };
  const chatPct = chat.target > 0 ? Math.min(100, Math.round((chat.sent / chat.target) * 100)) : 0;
  const projectChatById = useMemo(
    () => new Map((data?.projectChat ?? []).map((pc) => [pc.projectId, pc])),
    [data],
  );

  // ---- mutations (each shows a spinner + quick confirmation) ----
  async function withSave<T>(fn: () => Promise<T>, msg: string): Promise<T> {
    setSaving(true);
    try {
      const out = await fn();
      showToast(msg);
      return out;
    } finally {
      setSaving(false);
    }
  }

  async function refresh() {
    await loadDay(selectedDate);
    if (view === "calendar") loadMonth(month.year, month.month);
  }

  async function toggleDone(t: DayTask) {
    const next = t.status === "done" ? null : "done";
    await withSave(
      () => api.setTaskStatus({ taskId: t.id, date: selectedDate, status: next }),
      next === "done" ? "Marked done ✓" : "Back to pending",
    );
    await refresh();
  }

  async function markMissed(t: DayTask) {
    await withSave(
      () => api.setTaskStatus({ taskId: t.id, date: selectedDate, status: "missed" }),
      "Marked missed",
    );
    await refresh();
  }

  async function togglePosted(t: DayTask) {
    const next = !t.posted;
    await withSave(
      () => api.setTaskPosted({ taskId: t.id, date: selectedDate, posted: next }),
      next ? "Marked posted ✓" : "Unmarked posted",
    );
    await refresh();
  }

  async function saveTask(v: {
    id?: number;
    title: string;
    kind: TaskKind;
    time: string;
    projectId: number | null;
    date: string;
    recurring: boolean;
    postLink: string;
    details: string;
    eventRole: EventRole | null;
    remind: boolean;
    kaito: boolean;
    engagement?: {
      views: number | null;
      likes: number | null;
      reposts: number | null;
      replies: number | null;
    };
  }) {
    const payload = {
      title: v.title,
      kind: v.kind,
      time: v.time || null,
      projectId: v.projectId,
      date: v.date,
      recurring: v.recurring,
      postLink: v.postLink || null,
      details: v.details || null,
      eventRole: v.eventRole,
      remind: v.remind,
      kaito: v.kaito,
    };
    if (v.id) {
      await withSave(async () => {
        await api.updateTask({ id: v.id!, ...payload });
        // Engagement belongs to this task on the day being edited.
        if (v.kind === "post" && v.engagement) {
          await api.setEngagement({ taskId: v.id!, date: selectedDate, ...v.engagement });
        }
      }, "Task updated ✓");
    } else {
      await withSave(() => api.addTask(payload), "Task added ✓");
    }
    setShowTaskForm(false);
    setEditingTask(null);
    await refresh();
  }

  async function deleteTask(t: DayTask) {
    await withSave(() => api.deleteTask({ id: t.id }), "Task deleted");
    await refresh();
  }

  async function saveProject(v: {
    id?: number;
    name: string;
    color: ProjectColor;
    link: string;
    note: string;
    logo: string;
    ended: boolean;
  }) {
    if (v.id) {
      await withSave(
        () =>
          api.updateProject({
            id: v.id!,
            name: v.name,
            color: v.color,
            link: v.link || null,
            note: v.note || null,
            logo: v.logo || null,
            ended: v.ended,
          }),
        "Project saved ✓",
      );
    } else {
      await withSave(
        () =>
          api.addProject({
            name: v.name,
            color: v.color,
            link: v.link || undefined,
            note: v.note || undefined,
            logo: v.logo || undefined,
          }),
        "Project added ✓",
      );
    }
    setShowProjectForm(false);
    setEditingProject(null);
    await refresh();
  }

  async function setEnded(p: Project, ended: boolean) {
    await withSave(
      () => api.setProjectEnded({ id: p.id, ended }),
      ended ? `${p.name} ended — history kept` : `${p.name} active again`,
    );
    await refresh();
  }

  async function deleteProject(p: Project) {
    await withSave(() => api.deleteProject({ id: p.id }), "Project deleted");
    await refresh();
  }

  async function saveUser(v: { id?: number; name: string; photo: string }) {
    if (v.id) {
      await withSave(
        () => api.updateUser({ id: v.id!, name: v.name, photo: v.photo || null }),
        "User updated ✓",
      );
    } else {
      const res = await withSave(
        () => api.addUser({ name: v.name, photo: v.photo || null }),
        "User added ✓",
      );
      setActiveUserIdState(res.id);
      setActiveUserId(res.id);
    }
    setShowUserForm(false);
    setEditingUser(null);
    await loadUsers();
    await loadDay(selectedDate);
  }

  async function deleteUser(u: User) {
    await withSave(() => api.deleteUser({ id: u.id }), "User deleted");
    if (u.id === activeUserId) {
      setActiveUserIdState(1);
      setActiveUserId(1);
    }
    await loadUsers();
    await loadDay(selectedDate);
  }

  function switchUser(id: number) {
    setActiveUserIdState(id);
    setActiveUserId(id);
    setShowUserMenu(false);
    setExpandedTaskId(null);
    setEditingTask(null);
    setShowTaskForm(false);
    setFilter("all");
    setSelectedDate(todayStr());
    showToast("Switched user");
  }

  async function setChatTarget(v: number) {
    await withSave(() => api.setChatTarget({ date: selectedDate, target: v }), "Chat target updated");
    await refresh();
  }

  async function logChat(delta: number) {
    await withSave(() => api.setChatSent({ date: selectedDate, sent: Math.max(0, chat.sent + delta) }), `Chat ${delta > 0 ? "+" : ""}${delta}`);
    await refresh();
  }

  async function logProjectChat(p: Project, delta: number) {
    await withSave(
      () => api.logProjectChat({ date: selectedDate, projectId: p.id, delta }),
      `${p.name} chat ${delta > 0 ? "+" : ""}${delta}`,
    );
    await refresh();
  }

  async function setProjectChatTarget(p: Project, target: number) {
    await withSave(() => api.setProjectTarget({ date: selectedDate, projectId: p.id, target }), `${p.name} chat target updated`);
    await refresh();
  }

  function openDayDetail(date: string) {
    setDayDetailDate(date);
  }

  function jumpToSchedule(date: string) {
    setDayDetailDate(null);
    setSelectedDate(date);
    setView("today");
  }

  // ---- calendar grid ----
  const monthDays = useMemo(() => {
    const first = new Date(month.year, month.month, 1);
    const startWeekday = first.getDay();
    const total = daysInMonth(month.year, month.month);
    const prevTotal = daysInMonth(month.year, month.month - 1);
    const cells: { date: string | null; day: number | null; muted?: boolean }[] = [];
    for (let i = 0; i < startWeekday; i++) {
      cells.push({ date: null, day: prevTotal - startWeekday + 1 + i, muted: true });
    }
    for (let d = 1; d <= total; d++) {
      cells.push({ date: `${month.year}-${String(month.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`, day: d });
    }
    // Fill the last row with muted next-month days so it never ends in
    // empty space.
    let nextDay = 1;
    while (cells.length % 7 !== 0) {
      cells.push({ date: null, day: nextDay++, muted: true });
    }
    return cells;
  }, [month]);
  const monthTotals = useMemo(() => {
    const map = new Map((monthData?.days ?? []).map((d) => [d.date, d]));
    return map;
  }, [monthData]);
  const weekDates = useMemo(() => {
    const base = new Date(selectedDate + "T12:00:00Z");
    const start = new Date(base);
    start.setUTCDate(base.getUTCDate() - 3);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
  }, [selectedDate]);

  const filterCounts: Record<Filter, number> = {
    all: tasks.length,
    pending: pendingCount,
    done: doneCount,
    missed: missedCount,
    kaito: tasks.filter((t) => t.kind === "post" && t.kaito).length,
    posted: tasks.filter((t) => t.kind === "post" && t.posted).length,
  };

  return (
    <div className="app-shell">
      {saving && (
        <div className="saving-overlay" role="status">
          <span className="spinner" /> Saving…
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-star">✦</span>
          <div>
            <strong>Daily Hub</strong>
            <span>Your Web3 day, tracked</span>
          </div>
        </div>

        <div className="profile-block">
          <button
            type="button"
            className="profile-switcher"
            onClick={() => setShowUserMenu((v) => !v)}
            aria-expanded={showUserMenu}
          >
            <Avatar src={activeUser?.photo} name={activeUser?.name ?? "Ayush"} size={44} />
            <span className="profile-name">{activeUser?.name ?? "Ayush"}</span>
            <span className="profile-caret">{showUserMenu ? "▴" : "▾"}</span>
          </button>
          {showUserMenu && (
            <div className="user-menu">
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`user-menu-item ${u.id === activeUserId ? "active" : ""}`}
                  onClick={() => switchUser(u.id)}
                >
                  <Avatar src={u.photo} name={u.name} size={28} />
                  <span>{u.name}</span>
                  {u.id === activeUserId && <span className="user-menu-check">✓</span>}
                </button>
              ))}
              <button
                type="button"
                className="user-menu-item"
                onClick={() => {
                  setEditingUser(null);
                  setShowUserForm(true);
                  setShowUserMenu(false);
                }}
              >
                <span className="user-menu-plus">＋</span> Add user
              </button>
              {activeUser && users.length > 1 && (
                <button
                  type="button"
                  className="user-menu-item danger"
                  onClick={() => {
                    setEditingUser(activeUser);
                    setShowUserForm(true);
                    setShowUserMenu(false);
                  }}
                >
                  Edit current user
                </button>
              )}
            </div>
          )}
        </div>

        <nav className="side-nav">
          <button type="button" className={view === "today" ? "active" : ""} onClick={() => setView("today")}>
            📅 Today
          </button>
          <button type="button" className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}>
            🗓 Calendar
          </button>
          <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
            🕘 History
          </button>
          <button type="button" className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
            💬 Chat
          </button>
        </nav>

        <button
          type="button"
          className="mobile-panel-toggle"
          onClick={() => setMobilePanelOpen((v) => !v)}
          aria-expanded={mobilePanelOpen}
        >
          Projects &amp; settings {mobilePanelOpen ? "▴" : "▾"}
        </button>

        <div className={`mobile-collapsible ${mobilePanelOpen ? "open" : ""}`}>
        <div className="projects-block">
          <div className="projects-head">
            <h3>Projects</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingProject(null); setShowProjectForm(true); }}>
              ＋ Add
            </button>
          </div>
          {loading && !data ? (
            <p className="empty-note">Loading projects…</p>
          ) : activeProjects.length === 0 ? (
            <p className="empty-note">No projects yet — add your first one.</p>
          ) : (
            <ul className="project-list">
              {activeProjects.map((p) => (
                <li key={p.id} className="project-item">
                  <ProjectAvatar project={p} size={30} />
                  <span className="project-name">{p.name}</span>
                  {p.link && (
                    <a href={p.link} target="_blank" rel="noreferrer" className="project-discord" title="Open Discord">
                      ↗
                    </a>
                  )}
                  <button type="button" className="project-edit" onClick={() => { setEditingProject(p); setShowProjectForm(true); }} title="Edit project">
                    ✎
                  </button>
                </li>
              ))}
            </ul>
          )}
          {endedProjects.length > 0 && (
            <div className="ended-block">
              <h4>Ended</h4>
              <ul className="project-list ended">
                {endedProjects.map((p) => (
                  <li key={p.id} className="project-item ended">
                    <ProjectAvatar project={p} size={30} />
                    <span className="project-name">{p.name}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEnded(p, false)}>
                      Resume
                    </button>
                  </li>
                ))}
              </ul>
              <p className="ended-note">Ended projects keep all their history — they just stop showing in the schedule.</p>
            </div>
          )}
        </div>

        {data && (
          <div className="side-glance">
            <div className="side-glance-head">
              <span>{dateLabel(selectedDate)}</span>
              <strong>
                {doneCount}/{tasks.length} done
              </strong>
            </div>
            <div className="progress-bar slim">
              <span style={{ width: `${progressPct}%` }} />
            </div>
            <p className="side-glance-next">
              {glanceNext
                ? `Up next: ${glanceNext.title} · ${fmtTime12(glanceNext.time)}`
                : tasks.length === 0
                  ? "Nothing scheduled."
                  : "All done for this day."}
            </p>
            <p className="side-glance-chat">
              💬 Chat {data.chat.sent}/{data.chat.target}
            </p>
          </div>
        )}

        <div className="side-foot">
          <label className="toggle-row">
            <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
            <span>Voice announcements</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={reminders} onChange={(e) => setReminders(e.target.checked)} />
            <span>{`Reminders ${reminders ? "on" : "off"}`}</span>
          </label>
          <button type="button" className="btn btn-secondary btn-sm" onClick={testVoice}>
            🔊 Test voice
          </button>
        </div>
        </div>
      </aside>

      <main className="main">
        {view === "today" && (
          <section className="panel schedule-panel">
            <div className="panel-head">
              <div>
                <h2>{dateLabel(selectedDate)}</h2>
                <p className="panel-sub">
                  {longDateLabel(selectedDate)} · {doneCount} of {tasks.length} done
                </p>
              </div>
              <div className="head-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setSelectedDate(todayStr())} disabled={isToday}>
                  Today
                </button>
                <button type="button" className="btn btn-primary" onClick={() => { setEditingTask(null); setShowTaskForm(true); }}>
                  ＋ Add task
                </button>
              </div>
            </div>

            <div className="week-strip">
              {weekDates.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`week-day ${d === selectedDate ? "active" : ""} ${d === todayStr() ? "today" : ""}`}
                  onClick={() => setSelectedDate(d)}
                >
                  <span>{new Date(d + "T12:00:00Z").toLocaleDateString("en-IN", { weekday: "short", timeZone: "Asia/Kolkata" })}</span>
                  <strong>{Number(d.slice(8, 10))}</strong>
                </button>
              ))}
            </div>

            {loading && !data ? (
              <div className="loading-block">
                <span className="spinner" /> Loading your day…
              </div>
            ) : (
              <>
                {nextTask && isToday && (
                  <button
                    type="button"
                    className="up-next"
                    onClick={() => setExpandedTaskId(nextTask.id)}
                  >
                    <span className="up-next-label">Up next</span>
                    <span className="up-next-title">{nextTask.title}</span>
                    <span className="up-next-meta">
                      {nextTask.projectName ? `${nextTask.projectName} · ` : ""}
                      {fmtTime12(nextTask.time)} · {timeLeftLabel(selectedDate, nextTask.time, now)}
                    </span>
                  </button>
                )}

                <div className="progress-block">
                  <div className="progress-text">
                    <span>
                      <strong>{doneCount}</strong>/{tasks.length} done
                    </span>
                    <span>{progressPct}%</span>
                  </div>
                  <div className="progress-bar">
                    <span style={{ width: `${progressPct}%` }} />
                  </div>
                  {missedCount > 0 && <p className="progress-note">{missedCount} missed — mark them done or move them to tomorrow.</p>}
                </div>

                <div className="filter-row" role="tablist" aria-label="Filter tasks">
                  {(["all", "pending", "done", "missed", "kaito", "posted"] as Filter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`filter-chip ${filter === f ? "active" : ""}`}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all" ? "All" : f === "kaito" ? "Kaito" : f[0]!.toUpperCase() + f.slice(1)}
                      {filterCounts[f] > 0 ? ` · ${filterCounts[f]}` : ""}
                    </button>
                  ))}
                </div>

                {filteredTasks.length === 0 ? (
                  <div className="empty-state">
                    <p className="empty-title">
                      {tasks.length === 0
                        ? `Nothing scheduled for ${dateLabel(selectedDate)} yet.`
                        : `No ${filter} tasks for this day.`}
                    </p>
                    <p className="empty-note">
                      {tasks.length === 0
                        ? "Add your first task — a post, a chat, or an event."
                        : "Try a different filter, or add a task."}
                    </p>
                    <button type="button" className="btn btn-primary" onClick={() => { setEditingTask(null); setShowTaskForm(true); }}>
                      ＋ Add task
                    </button>
                  </div>
                ) : (
                  <div className="task-list">
                    {filteredTasks.map((t, i) => (
                      <div key={t.id} className="task-anim" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                        <TaskRow
                          t={t}
                          dateStr={selectedDate}
                          now={now}
                          expanded={expandedTaskId === t.id}
                          onToggleExpand={() => setExpandedTaskId(expandedTaskId === t.id ? null : t.id)}
                          onToggleDone={() => toggleDone(t)}
                          onMarkMissed={() => markMissed(t)}
                          onTogglePosted={() => togglePosted(t)}
                          onEdit={() => {
                            setEditingTask(t);
                            setShowTaskForm(true);
                          }}
                          onDelete={() => deleteTask(t)}
                          onSaved={showToast}
                          saving={saving}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <BestTimePanel />
              </>
            )}
          </section>
        )}

        {view === "calendar" && (
          <section className="panel calendar-panel">
            <div className="panel-head">
              <div>
                <h2>Calendar</h2>
                <p className="panel-sub">Click any day to see what you did that day.</p>
              </div>
              <div className="head-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setMonth((m) => (m.month === 0 ? { year: m.year - 1, month: 11 } : { year: m.year, month: m.month - 1 }))}
                >
                  ← Prev
                </button>
                <strong className="month-title">
                  {new Date(month.year, month.month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
                </strong>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setMonth((m) => (m.month === 11 ? { year: m.year + 1, month: 0 } : { year: m.year, month: m.month + 1 }))}
                >
                  Next →
                </button>
              </div>
            </div>
            <div className="calendar-grid">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <span key={d} className="calendar-dow">
                  {d}
                </span>
              ))}
              {monthDays.map((cell, i) => {
                if (!cell.date)
                  return (
                    <span key={`blank-${i}`} className={`calendar-cell ${cell.muted ? "muted" : "blank"}`}>
                      {cell.muted ? <span className="calendar-day-num">{cell.day}</span> : null}
                    </span>
                  );
                const tot = monthTotals.get(cell.date);
                const done = tot?.done ?? 0;
                const total = tot?.total ?? 0;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    className={`calendar-cell ${cell.date === todayStr() ? "today" : ""} ${cell.date === selectedDate ? "selected" : ""}`}
                    onClick={() => openDayDetail(cell.date!)}
                  >
                    <span className="calendar-day-num">{cell.day}</span>
                    {total > 0 && (
                      <>
                        <span className="calendar-day-count">
                          {done}/{total}
                        </span>
                        <span className="calendar-day-bar">
                          <span style={{ width: `${pct}%` }} />
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="panel-sub">
              {monthData ? `${monthData.recurringCount} daily tasks repeat every day this month.` : "Loading month…"}
            </p>
          </section>
        )}

        {view === "history" && <HistoryView onDayClick={openDayDetail} />}

        {view === "chat" && (
          <section className="panel chat-panel">
            <div className="panel-head">
              <div>
                <h2>Daily Chat</h2>
                <p className="panel-sub">
                  {dateLabel(selectedDate)} · log your Discord messages per project, and the total adds up.
                </p>
              </div>
            </div>
            {loading && !data ? (
              <div className="loading-block">
                <span className="spinner" /> Loading chat…
              </div>
            ) : (
              <>
                <div className="chat-total">
                  <div className="chat-gauge">
                    <svg viewBox="0 0 120 120" className="gauge-svg">
                      <circle cx="60" cy="60" r="52" className="gauge-track" />
                      <circle
                        cx="60"
                        cy="60"
                        r="52"
                        className="gauge-fill"
                        strokeDasharray={`${(chatPct / 100) * 2 * Math.PI * 52} ${2 * Math.PI * 52}`}
                      />
                    </svg>
                    <div className="gauge-center">
                      <strong>{chat.sent}</strong>
                      <span>/ {chat.target}</span>
                    </div>
                  </div>
                  <div className="chat-total-text">
                    <h3>{chatPct}% of today&apos;s chat goal</h3>
                    <p>{chat.sent >= chat.target ? "Goal hit — nice work." : `${chat.target - chat.sent} messages to go.`}</p>
                    <div className="chat-buttons">
                      <button type="button" className="btn btn-primary" onClick={() => logChat(1)} disabled={saving}>
                        ＋1 message
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => logChat(5)} disabled={saving}>
                        ＋5 messages
                      </button>
                      {chat.sent > 0 && (
                        <button type="button" className="btn btn-ghost" onClick={() => logChat(-1)} disabled={saving}>
                          −1
                        </button>
                      )}
                    </div>
                    <label className="field chat-target-field">
                      <span>Daily target (100–1000)</span>
                      <span className="chat-target-row">
                        <input
                          type="number"
                          min={1}
                          max={1000}
                          value={chatTargetDraft}
                          onChange={(e) => setChatTargetDraft(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={saving || Number(chatTargetDraft) === chat.target}
                          onClick={() => {
                            const v = Math.max(1, Math.min(1000, Number(chatTargetDraft) || 50));
                            setChatTarget(v);
                          }}
                        >
                          Save target
                        </button>
                      </span>
                    </label>
                  </div>
                </div>

                <h3 className="chat-per-project-title">Per project</h3>
                {activeProjects.length === 0 ? (
                  <p className="empty-note">Add a project to track its chats separately.</p>
                ) : (
                  <div className="project-chat-list">
                    {activeProjects.map((p) => {
                      const pc = projectChatById.get(p.id) ?? { sent: 0, target: 0 };
                      const pct = pc.target > 0 ? Math.min(100, Math.round((pc.sent / pc.target) * 100)) : 0;
                      return (
                        <div key={p.id} className="project-chat-row">
                          <ProjectAvatar project={p} size={30} />
                          <div className="project-chat-main">
                            <div className="project-chat-head">
                              <strong>{p.name}</strong>
                              <span>
                                {pc.sent}
                                {pc.target > 0 ? ` / ${pc.target}` : " sent"}
                              </span>
                            </div>
                            <div className="progress-bar slim">
                              <span style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                          <div className="project-chat-actions">
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => logProjectChat(p, 1)} disabled={saving}>
                              ＋1
                            </button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => logProjectChat(p, 5)} disabled={saving}>
                              ＋5
                            </button>
                            {pc.target > 0 && (
                              <span className="project-chat-pct">{pct}%</span>
                            )}
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                const v = window.prompt(`Daily chat target for ${p.name} (0 = no target):`, String(pc.target));
                                if (v === null) return;
                                const n = Math.max(0, Math.min(1000, Number(v) || 0));
                                setProjectChatTarget(p, n);
                              }}
                            >
                              Set target
                            </button>
                          </div>
                          {p.link && (
                            <a href={p.link} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                              Open Discord ↗
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <a className="btn btn-secondary" href="https://discord.com/app" target="_blank" rel="noreferrer">
                  Open Discord
                </a>
              </>
            )}
          </section>
        )}
      </main>

      <nav className="bottom-nav">
        <button type="button" className={view === "today" ? "active" : ""} onClick={() => setView("today")}>
          📅<span>Today</span>
        </button>
        <button type="button" className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}>
          🗓<span>Calendar</span>
        </button>
        <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
          🕘<span>History</span>
        </button>
        <button type="button" className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
          💬<span>Chat</span>
        </button>
      </nav>

      {(showTaskForm || editingTask) && (
        <div className="modal-backdrop" onClick={() => { setShowTaskForm(false); setEditingTask(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={editingTask ? "Edit task" : "Add task"}>
            <div className="modal-head">
              <h3>{editingTask ? "Edit task" : "Add task"}</h3>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowTaskForm(false); setEditingTask(null); }}>
                Close ✕
              </button>
            </div>
            <TaskForm
              projects={data?.projects ?? []}
              initial={
                editingTask
                  ? {
                      id: editingTask.id,
                      title: editingTask.title,
                      kind: editingTask.kind,
                      time: editingTask.time ?? "09:00",
                      projectId: editingTask.projectId,
                      date: selectedDate,
                      recurring: editingTask.recurring,
                      postLink: editingTask.postLink ?? "",
                      details: editingTask.details ?? "",
                      eventRole: editingTask.eventRole,
                      remind: editingTask.remind,
                      kaito: editingTask.kaito,
                      engagement: {
                        views: editingTask.views,
                        likes: editingTask.likes,
                        reposts: editingTask.reposts,
                        replies: editingTask.replies,
                      },
                    }
                  : {
                      title: "",
                      kind: "post",
                      time: "18:00",
                      projectId: activeProjects[0]?.id ?? null,
                      date: selectedDate,
                      recurring: true,
                      postLink: "",
                      details: "",
                      eventRole: null,
                      remind: true,
                      kaito: false,
                    }
              }
              onSave={saveTask}
              onCancel={() => {
                setShowTaskForm(false);
                setEditingTask(null);
              }}
              saving={saving}
            />
          </div>
        </div>
      )}

      {(showProjectForm || editingProject) && (
        <div className="modal-backdrop" onClick={() => { setShowProjectForm(false); setEditingProject(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={editingProject ? "Edit project" : "Add project"}>
            <div className="modal-head">
              <h3>{editingProject ? "Edit project" : "Add project"}</h3>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowProjectForm(false); setEditingProject(null); }}>
                Close ✕
              </button>
            </div>
            <ProjectForm
              initial={
                editingProject
                  ? {
                      id: editingProject.id,
                      name: editingProject.name,
                      color: editingProject.color,
                      link: editingProject.link ?? "",
                      note: editingProject.note ?? "",
                      logo: editingProject.logo ?? "",
                      ended: editingProject.ended,
                    }
                  : undefined
              }
              onSave={saveProject}
              onCancel={() => {
                setShowProjectForm(false);
                setEditingProject(null);
              }}
              saving={saving}
            />
            {editingProject && (
              <div className="modal-danger">
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => {
                    if (window.confirm(`End ${editingProject.name}? Its history stays saved, it just leaves the active schedule.`)) {
                      setEnded(editingProject, true);
                      setShowProjectForm(false);
                      setEditingProject(null);
                    }
                  }}
                >
                  End this project
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => {
                    if (window.confirm(`Delete ${editingProject.name}? Its tasks become unassigned.`)) {
                      deleteProject(editingProject);
                      setShowProjectForm(false);
                      setEditingProject(null);
                    }
                  }}
                >
                  Delete project
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {(showUserForm || editingUser) && (
        <div className="modal-backdrop" onClick={() => { setShowUserForm(false); setEditingUser(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={editingUser ? "Edit user" : "Add user"}>
            <div className="modal-head">
              <h3>{editingUser ? "Edit user" : "Add user"}</h3>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowUserForm(false); setEditingUser(null); }}>
                Close ✕
              </button>
            </div>
            <UserForm
              initial={editingUser ?? undefined}
              onSave={saveUser}
              onCancel={() => {
                setShowUserForm(false);
                setEditingUser(null);
              }}
              saving={saving}
            />
            {editingUser && users.length > 1 && (
              <div className="modal-danger">
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => {
                    if (window.confirm(`Delete ${editingUser.name}? All of their projects, tasks and chat counts go with them.`)) {
                      deleteUser(editingUser);
                      setShowUserForm(false);
                      setEditingUser(null);
                    }
                  }}
                >
                  Delete user
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {dayDetailDate && (
        <DayDetail date={dayDetailDate} onClose={() => setDayDetailDate(null)} onJumpToSchedule={jumpToSchedule} />
      )}
    </div>
  );
}

export default App;
