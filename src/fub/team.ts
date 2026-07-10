import { FubClient } from "./client";
import type { FubUser, FubCall, FubNote, FubPerson } from "../types";
import { summarize, type CallSummary } from "./calls";
import { parsePeriod, type PeriodInput } from "../lib/period";

export type CloserResolution =
  | { status: "ok"; user: { id: number; name: string | null } }
  | { status: "ambiguous"; candidates: { id: number; name: string | null }[] }
  | { status: "unknown" };

export function resolveCloser(users: FubUser[], arg: string | number): CloserResolution {
  const raw = String(arg).trim();
  if (typeof arg === "number" || /^\d+$/.test(raw)) {
    const id = Number(raw);
    const u = users.find((x) => x.id === id);
    return u ? { status: "ok", user: { id: u.id, name: u.name } } : { status: "unknown" };
  }
  const q = raw.toLowerCase();
  const matches = users.filter(
    (u) => (u.name ?? "").toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q),
  );
  if (matches.length === 1) return { status: "ok", user: { id: matches[0].id, name: matches[0].name } };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches.map((u) => ({ id: u.id, name: u.name })) };
  return { status: "unknown" };
}

export interface CloserActivity {
  userId: number;
  name: string | null;
  calls: CallSummary;
  notes: number;
}
export interface TeamActivityResult {
  closers: CloserActivity[];
  noActivity: { userId: number; name: string | null }[];
}

export function groupCallsByUser(calls: FubCall[]): Map<number, FubCall[]> {
  const m = new Map<number, FubCall[]>();
  for (const c of calls) {
    if (typeof c.userId !== "number") continue; // unattributed calls can't be credited to a closer
    const arr = m.get(c.userId);
    if (arr) arr.push(c);
    else m.set(c.userId, [c]);
  }
  return m;
}

export function countNotesByUser(notes: FubNote[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of notes) {
    if (typeof n.createdById !== "number") continue;
    m.set(n.createdById, (m.get(n.createdById) ?? 0) + 1);
  }
  return m;
}

export function buildTeamActivity(
  users: FubUser[],
  callsByUser: Map<number, FubCall[]>,
  notesByUser: Map<number, number>,
): TeamActivityResult {
  const closers: CloserActivity[] = [];
  const noActivity: { userId: number; name: string | null }[] = [];
  for (const u of users) {
    const calls = callsByUser.get(u.id) ?? [];
    const notes = notesByUser.get(u.id) ?? 0;
    if (calls.length === 0 && notes === 0) {
      noActivity.push({ userId: u.id, name: u.name });
      continue;
    }
    closers.push({ userId: u.id, name: u.name, calls: summarize(calls), notes });
  }
  closers.sort((a, b) => b.calls.total - a.calls.total);
  return { closers, noActivity };
}

export async function teamActivity(
  client: FubClient,
  users: FubUser[],
  period: PeriodInput,
  now: Date,
  tz: string,
): Promise<TeamActivityResult> {
  const p = parsePeriod(period, now, tz);
  const dateParams = { createdAfter: p.createdAfter, ...(p.createdBefore ? { createdBefore: p.createdBefore } : {}) };
  const calls = await client.getAllPages<FubCall>("/calls", dateParams, "calls", 2000);
  const notes = await client.getAllPages<FubNote>("/notes", dateParams, "notes", 2000);
  return buildTeamActivity(users, groupCallsByUser(calls), countNotesByUser(notes));
}

export interface PipelineStage {
  stage: string;
  total: number;
  byCloser: { userId: number | null; name: string | null; count: number }[];
}
export interface TeamPipelineResult {
  stages: PipelineStage[];
  partial: boolean;
}

// Stages excluded from the "pipeline" view by default. CONFIRMED against live
// GET /v1/stages on 2026-07-09. The pipeline is the active SELLER deal funnel;
// we drop (a) terminal/dead/archived stages, (b) non-lead contact buckets, (c) the
// buyer stage, and (d) the huge early-nurture + list buckets (tens of thousands of
// records each) that aren't "deals in progress" and would dominate/slow the sweep.
// What remains active: Lead, Pending Closer Contact, Needs Underwriting, Closer Needs
// To Make Offer, Offer Submitted - Waiting to Hear Back, Offer Rejected - Future Follow
// Up, Hot Leads, Needs Contract (Automatically Requested To TC), Contract Sent, Under Contract.
export const EXCLUDED_PIPELINE_STAGES = new Set<string>([
  "No Contact Made",
  "Cold - Follow Up",
  "Closed",
  "Dead (Previous Deal)",
  "Dead/Already Sold",
  "Other Contacts",
  "Title Companies",
  "Lawyers",
  "New Buyer Lead",
  "Entire Buyers List",
  "Entire Realtor's List (To Find Buyers)",
  "Trash",
]);

const PIPELINE_PAGE_CAP = 2000; // covers the largest active stage (Lead ~1.5k) with headroom

export async function listActiveStages(client: FubClient, excluded: Set<string>): Promise<string[]> {
  const stages = await client.getAllPages<{ id: number; name: string }>("/stages", {}, "stages", 200);
  return stages.map((s) => s.name).filter((n): n is string => !!n && !excluded.has(n));
}

export function groupPeopleByCloser(
  people: FubPerson[],
  userNames: Map<number, string | null>,
): { userId: number | null; name: string | null; count: number }[] {
  const counts = new Map<number | null, number>();
  for (const p of people) {
    const uid = typeof p.assignedUserId === "number" ? p.assignedUserId : null;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([userId, count]) => ({
      userId,
      name: userId === null ? "Unassigned" : userNames.get(userId) ?? `User ${userId}`,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

export async function teamPipeline(
  client: FubClient,
  users: FubUser[],
  activeStages: string[],
): Promise<TeamPipelineResult> {
  const userNames = new Map(users.map((u) => [u.id, u.name] as const));
  const stages: PipelineStage[] = [];
  let partial = false;
  for (const stage of activeStages) {
    const people = await client.getAllPages<FubPerson>(
      "/people",
      { stage, fields: "id,assignedUserId,stage" },
      "people",
      PIPELINE_PAGE_CAP,
    );
    if (people.length >= PIPELINE_PAGE_CAP) partial = true; // hit the cap → counts for this stage are partial
    stages.push({ stage, total: people.length, byCloser: groupPeopleByCloser(people, userNames) });
  }
  return { stages, partial };
}
