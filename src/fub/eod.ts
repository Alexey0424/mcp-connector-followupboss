import { FubClient } from "./client";
import { listMyCalls } from "./calls";
import { listMyNotes } from "./notes";
import type { FubText } from "../types";
import { parsePeriod, type PeriodInput } from "../lib/period";

const MAX_TOUCHED = 50;

export async function myTextsForPeriod(
  client: FubClient, fubUserId: number, personIds: number[], fromIso: string, toIso?: string,
): Promise<FubText[]> {
  const fromMs = Date.parse(fromIso);
  const toMs = toIso ? Date.parse(toIso) : Infinity;
  const out: FubText[] = [];
  for (const pid of personIds.slice(0, MAX_TOUCHED)) {
    let texts: FubText[] = [];
    try {
      texts = await client.getAllPages<FubText>("/textMessages", { personId: pid }, "textMessages", 100);
    } catch {
      texts = []; // a person with no texts / a transient error shouldn't sink the report
    }
    for (const t of texts) {
      if (t.userId !== fubUserId) continue; // only MY texts, never another agent's
      const ts = t.created ? Date.parse(t.created) : NaN;
      if (Number.isNaN(ts) || ts < fromMs || ts >= toMs) continue;
      out.push(t);
    }
  }
  return out;
}

export async function myEodReport(
  client: FubClient, fubUserId: number, period: PeriodInput, now: Date, tz: string,
) {
  const p = parsePeriod(period, now, tz);
  const calls = await listMyCalls(client, fubUserId, period, now, tz);
  const notes = await listMyNotes(client, fubUserId, period, now, tz);
  const touched = Array.from(
    new Set(
      [...calls.map((c) => c.personId), ...notes.map((n) => n.personId)].filter(
        (x): x is number => typeof x === "number",
      ),
    ),
  );
  const texts = await myTextsForPeriod(client, fubUserId, touched, p.createdAfter, p.createdBefore);
  return { calls, notes, texts, touchedLeadCount: touched.length, textsCapped: touched.length > MAX_TOUCHED };
}
