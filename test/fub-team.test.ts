import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { listTeam } from "../src/fub/users";
import {
  resolveCloser,
  groupCallsByUser,
  countNotesByUser,
  buildTeamActivity,
  teamActivity,
  groupPeopleByCloser,
  teamPipeline,
  listActiveStages,
  EXCLUDED_PIPELINE_STAGES,
} from "../src/fub/team";

const NOW = new Date("2026-07-09T18:00:00Z");
const TZ = "America/New_York";

const USERS = [
  { id: 86, name: "Ethan Serrano", email: "ethan@acmehomebuyers.example" },
  { id: 79, name: "Flora Stevens", email: "flora@acmehomebuyers.example" },
  { id: 82, name: "Hank Cole", email: "hank@acmehomebuyers.example" },
] as any[];

describe("listTeam", () => {
  it("returns the roster", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ users: USERS, _metadata: {} }), text: async () => "" } as any),
    });
    expect((await listTeam(c)).map((u) => u.id).sort()).toEqual([79, 82, 86]);
  });
});

describe("resolveCloser", () => {
  it("resolves a numeric id", () => {
    expect(resolveCloser(USERS, 79)).toEqual({ status: "ok", user: { id: 79, name: "Flora Stevens" } });
    expect(resolveCloser(USERS, "86")).toEqual({ status: "ok", user: { id: 86, name: "Ethan Serrano" } });
  });
  it("resolves a unique name substring case-insensitively", () => {
    expect(resolveCloser(USERS, "flora")).toEqual({ status: "ok", user: { id: 79, name: "Flora Stevens" } });
  });
  it("reports ambiguity", () => {
    const r = resolveCloser(USERS, "han");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates.map((c) => c.id).sort()).toEqual([82, 86]);
  });
  it("reports unknown", () => {
    expect(resolveCloser(USERS, "nobody")).toEqual({ status: "unknown" });
    expect(resolveCloser(USERS, 12345)).toEqual({ status: "unknown" });
  });
});

describe("team_activity grouping", () => {
  it("groups calls/notes by user and flags no-activity closers", () => {
    const users = [
      { id: 86, name: "Ethan", email: null },
      { id: 79, name: "Flora", email: null },
      { id: 82, name: "Hank", email: null },
    ] as any[];
    const calls = [
      { id: 1, userId: 86, personId: 5, duration: 120, outcome: null, isIncoming: false },
      { id: 2, userId: 86, personId: 6, duration: 0, outcome: "No Answer", isIncoming: false },
      { id: 3, userId: 79, personId: 5, duration: 60, outcome: null, isIncoming: true },
      { id: 4, userId: null, personId: 7, duration: 30, outcome: null, isIncoming: false }, // unattributed → ignored
    ] as any[];
    const notes = [
      { id: 10, createdById: 79 }, { id: 11, createdById: 79 }, { id: 12, createdById: 999 },
    ] as any[];

    const res = buildTeamActivity(users, groupCallsByUser(calls), countNotesByUser(notes));
    // sorted by call total desc: Ethan (2), Flora (1)
    expect(res.closers.map((c) => c.userId)).toEqual([86, 79]);
    expect(res.closers[0].calls.total).toBe(2);
    expect(res.closers[0].calls.answered).toBe(1);   // one 120s, one no-answer
    expect(res.closers[1].notes).toBe(2);            // Flora authored 2
    expect(res.noActivity.map((n) => n.userId)).toEqual([82]); // Hank: nothing
  });

  it("teamActivity sweeps calls+notes for the period and aggregates", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async (url: string) => {
        const body = url.includes("/calls")
          ? { calls: [{ id: 1, userId: 86, duration: 100, outcome: null, isIncoming: false, personId: 5 }], _metadata: {} }
          : url.includes("/notes")
          ? { notes: [{ id: 9, createdById: 86 }], _metadata: {} }
          : { _metadata: {} };
        return { ok: true, status: 200, json: async () => body, text: async () => "" } as any;
      },
    });
    const users = [{ id: 86, name: "Ethan", email: null }] as any[];
    const res = await teamActivity(c, users, "today", NOW, TZ);
    expect(res.closers).toHaveLength(1);
    expect(res.closers[0].calls.total).toBe(1);
    expect(res.closers[0].notes).toBe(1);
  });
});

describe("team_pipeline", () => {
  it("groupPeopleByCloser counts per assignee, unassigned bucketed", () => {
    const names = new Map<number, string | null>([[86, "Ethan"], [79, "Flora"]]);
    const people = [
      { id: 1, assignedUserId: 86 }, { id: 2, assignedUserId: 86 },
      { id: 3, assignedUserId: 79 }, { id: 4, assignedUserId: null },
    ] as any[];
    const g = groupPeopleByCloser(people, names);
    expect(g[0]).toEqual({ userId: 86, name: "Ethan", count: 2 }); // sorted desc
    expect(g.find((x) => x.userId === null)).toEqual({ userId: null, name: "Unassigned", count: 1 });
  });

  it("listActiveStages drops excluded stage names", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        stages: [{ id: 1, name: "Lead" }, { id: 2, name: "Under Contract" }, { id: 3, name: "Trash" }], _metadata: {},
      }), text: async () => "" } as any),
    });
    const active = await listActiveStages(c, new Set(["Trash"]));
    expect(active).toEqual(["Lead", "Under Contract"]);
  });

  it("teamPipeline queries each active stage and flags partial when capped", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async (url: string) => {
        const body = url.includes("stage=Lead")
          ? { people: [{ id: 1, assignedUserId: 86 }, { id: 2, assignedUserId: 79 }], _metadata: {} }
          : url.includes("stage=Offer")
          ? { people: [{ id: 3, assignedUserId: 86 }], _metadata: {} }
          : { people: [], _metadata: {} };
        return { ok: true, status: 200, json: async () => body, text: async () => "" } as any;
      },
    });
    const users = [{ id: 86, name: "Ethan", email: null }, { id: 79, name: "Flora", email: null }] as any[];
    const res = await teamPipeline(c, users, ["Lead", "Offer"]);
    expect(res.stages.map((s) => [s.stage, s.total])).toEqual([["Lead", 2], ["Offer", 1]]);
    expect(res.partial).toBe(false);
  });

  it("EXCLUDED_PIPELINE_STAGES is a Set", () => {
    expect(EXCLUDED_PIPELINE_STAGES instanceof Set).toBe(true);
  });
});
