import type { FubCall } from "../types";

const NOT_ANSWERED = new Set(["No Answer", "Missed", "Voicemail", "Busy", "Bad Number", "Left Message"]);

export function isNotAnswered(call: Pick<FubCall, "outcome" | "duration">): boolean {
  if (call.outcome && NOT_ANSWERED.has(call.outcome)) return true;
  return !call.duration; // 0 or null → treat as not answered (best-effort)
}
