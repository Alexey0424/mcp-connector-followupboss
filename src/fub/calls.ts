import { FubClient } from "./client";
import type { FubCall } from "../types";
import { parsePeriod, type PeriodInput } from "../lib/period";
import { filterOwnedCalls } from "../lib/scope";
import { isNotAnswered } from "../lib/classify";

export interface CallSummary {
  total: number;
  notAnswered: number;
  answered: number;
  incoming: number;
  outgoing: number;
  totalTalkSeconds: number;
  distinctLeads: number;
}

export async function listMyCalls(
  client: FubClient, fubUserId: number, period: PeriodInput, now: Date, tz: string,
): Promise<FubCall[]> {
  const p = parsePeriod(period, now, tz);
  const calls = await client.getAllPages<FubCall>(
    "/calls",
    { userId: fubUserId, createdAfter: p.createdAfter, ...(p.createdBefore ? { createdBefore: p.createdBefore } : {}) },
    "calls",
  );
  return filterOwnedCalls(calls, fubUserId); // defense in depth
}

export function summarize(calls: FubCall[]): CallSummary {
  const leads = new Set<number>();
  let notAnswered = 0, incoming = 0, talk = 0;
  for (const c of calls) {
    if (c.personId) leads.add(c.personId);
    if (isNotAnswered(c)) notAnswered++;
    if (c.isIncoming) incoming++;
    talk += c.duration ?? 0;
  }
  return {
    total: calls.length,
    notAnswered,
    answered: calls.length - notAnswered,
    incoming,
    outgoing: calls.length - incoming,
    totalTalkSeconds: talk,
    distinctLeads: leads.size,
  };
}

export async function myCallSummary(
  client: FubClient, fubUserId: number, period: PeriodInput, now: Date, tz: string,
): Promise<CallSummary> {
  return summarize(await listMyCalls(client, fubUserId, period, now, tz));
}
