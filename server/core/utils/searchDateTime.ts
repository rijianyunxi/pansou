const API_TIME_ZONE = "Asia/Shanghai";

function formatDateParts(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: API_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}/${values.month}/${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

/** Formats source timestamps as YYYY/MM/DD HH:mm:ss in China time. */
export function formatSearchDateTime(value?: string | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  if (dateOnly) {
    return `${dateOnly[1]}/${dateOnly[2]!.padStart(2, "0")}/${dateOnly[3]!.padStart(2, "0")} 00:00:00`;
  }
  const naive = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  const timestamp = naive
    ? Date.parse(`${naive[1]}-${naive[2]!.padStart(2, "0")}-${naive[3]!.padStart(2, "0")}T${naive[4]!.padStart(2, "0")}:${naive[5]}:${(naive[6] || "00").padStart(2, "0")}+08:00`)
    : Date.parse(raw);
  return Number.isFinite(timestamp) ? formatDateParts(new Date(timestamp)) : null;
}
