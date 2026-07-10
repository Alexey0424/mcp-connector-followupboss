import type { Period } from "../types";

export type PeriodInput =
  | "today" | "yesterday" | "this_week" | "last_7_days" | "last_30_days"
  | { from: string; to?: string };

const DAY = 86_400_000;

function localParts(now: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(parts.timeZoneName ?? "GMT+00:00");
  const sign = m && m[1] === "-" ? -1 : 1;
  const offsetMinutes = m ? sign * (+m[2] * 60 + +m[3]) : 0;
  return { y: +parts.year, m: +parts.month, d: +parts.day, offsetMinutes };
}

// UTC ms for local midnight of (y,m,d) at the given offset.
function localMidnightUtc(y: number, m: number, d: number, offsetMinutes: number): number {
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60_000;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function parsePeriod(input: PeriodInput, now: Date, tz: string): Period {
  if (typeof input === "object") {
    return {
      createdAfter: new Date(input.from).toISOString(),
      createdBefore: input.to ? new Date(input.to).toISOString() : undefined,
    };
  }
  const { y, m, d, offsetMinutes } = localParts(now, tz);
  const startOfToday = localMidnightUtc(y, m, d, offsetMinutes);
  switch (input) {
    case "today":
      return { createdAfter: iso(startOfToday) };
    case "yesterday":
      return { createdAfter: iso(startOfToday - DAY), createdBefore: iso(startOfToday) };
    case "this_week": {
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
      const sinceMon = (dow + 6) % 7;
      return { createdAfter: iso(startOfToday - sinceMon * DAY) };
    }
    case "last_7_days":
      return { createdAfter: iso(now.getTime() - 7 * DAY) };
    case "last_30_days":
      return { createdAfter: iso(now.getTime() - 30 * DAY) };
  }
}
