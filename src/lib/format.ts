import type { FubCall } from "../types";
import type { CallSummary } from "../fub/calls";

export function fmtDuration(sec: number | null): string {
  const s = sec ?? 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function leadName(c: Pick<FubCall, "name" | "firstName" | "lastName">): string {
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown";
}

export function formatCall(c: FubCall) {
  return {
    lead: leadName(c),
    direction: c.isIncoming ? "incoming" : "outgoing",
    duration: fmtDuration(c.duration),
    outcome: c.outcome ?? "—",
    startedAt: c.startedAt,
    summary: c.note ?? null,          // Part C AI summary (score / topics / sentiment / text)
    recordingUrl: c.recordingUrl ?? null,
  };
}

export function formatSummary(s: CallSummary): string {
  const mins = Math.round(s.totalTalkSeconds / 60);
  return [
    `Total calls: ${s.total}`,
    `Answered: ${s.answered}  •  Not answered (approx): ${s.notAnswered}`,
    `Outgoing: ${s.outgoing}  •  Incoming: ${s.incoming}`,
    `Talk time: ${mins} min  •  Distinct leads: ${s.distinctLeads}`,
  ].join("\n");
}
