import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { widgetId, widgetSize } from "./spaceTarget";

function keyOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function fmtTime(t: string | null): string {
  if (!t) return "Anytime";
  const [h = 0, m = 0] = t.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function Widget() {
  const today = keyOf(new Date());
  const day = useQuery({
    queryKey: ["day", today],
    queryFn: () => api.getDay({ date: today }),
  });

  const tasks = day.data?.tasks ?? [];
  const done = tasks.filter((t) => t.done).length;
  const next = tasks.find((t) => !t.done);
  const chat = day.data?.chat;
  const size = widgetSize ?? "small";
  const large = size === "large";

  return (
    <div
      className="flex h-screen w-screen flex-col justify-center gap-1.5 p-4 text-[#f4f2ff]"
      style={{
        background:
          "radial-gradient(300px 200px at 90% -10%, rgba(88,101,242,0.5), transparent 60%), radial-gradient(260px 200px at -10% 90%, rgba(45,212,191,0.3), transparent 55%), linear-gradient(160deg, #171138, #0d0a24)",
        fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif",
      }}
      data-widget={widgetId ?? "default"}
      data-widget-size={size}
    >
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#a49fd0]">
        Daily Hub · Today
      </p>
      {day.isPending ? (
        <p className="text-sm text-[#a49fd0]">Loading…</p>
      ) : day.isError ? (
        <p className="text-sm text-red-200">Could not load today.</p>
      ) : (
        <>
          <p className="text-3xl font-extrabold leading-none" style={{ fontFamily: "Sora, sans-serif" }}>
            {done}/{tasks.length}
            <span className="ml-2 text-sm font-semibold text-[#a49fd0]">tasks done</span>
          </p>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/12">
            <div
              className="h-full rounded-full bg-gradient-to-r from-teal-300 to-sky-400"
              style={{ width: tasks.length ? `${Math.round((done / tasks.length) * 100)}%` : "0%" }}
            />
          </div>
          {next ? (
            <p className="truncate text-sm font-semibold">
              Next: {next.title}
              <span className="ml-1.5 text-xs font-bold text-teal-300">{fmtTime(next.time)}</span>
            </p>
          ) : tasks.length > 0 ? (
            <p className="text-sm font-semibold text-teal-300">All done for today ✓</p>
          ) : (
            <p className="text-sm text-[#a49fd0]">Nothing scheduled yet today.</p>
          )}
          {chat && (
            <p className="text-sm font-semibold">
              Discord chat: {chat.sent}/{chat.target}
              <span className="ml-1.5 text-xs font-bold text-[#a49fd0]">
                {chat.target > 0 ? Math.round(Math.min(1, chat.sent / chat.target) * 100) : 0}%
              </span>
            </p>
          )}
          {large && tasks.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {tasks.slice(0, 5).map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm">
                  <span aria-hidden="true">{t.done ? "✓" : "○"}</span>
                  <span className={`truncate ${t.done ? "text-[#a49fd0] line-through" : ""}`}>{t.title}</span>
                  <span className="ml-auto shrink-0 text-xs font-bold text-[#a49fd0]">{fmtTime(t.time)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
