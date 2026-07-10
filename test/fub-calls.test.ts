import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { listMyCalls, summarize, myCallSummary } from "../src/fub/calls";

function clientReturning(calls: any[], capture?: (url: string) => void) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async (url: string) => { capture?.(url); return { ok: true, status: 200, json: async () => ({ calls, _metadata: {} }), text: async () => "" } as any; },
  });
}

const NOW = new Date("2026-07-07T18:00:00Z");
const TZ = "America/New_York";

describe("listMyCalls", () => {
  it("queries with userId + createdAfter and re-filters to my calls", async () => {
    let seenUrl = "";
    const calls = [
      { id: 1, userId: 86, personId: 9, duration: 100, outcome: null, isIncoming: false, name: "A" },
      { id: 2, userId: 79, personId: 8, duration: 50, outcome: null, isIncoming: true, name: "B" }, // not mine
    ];
    const out = await listMyCalls(clientReturning(calls, (u) => (seenUrl = u)), 86, "today", NOW, TZ);
    expect(seenUrl).toContain("userId=86");
    expect(seenUrl).toContain("createdAfter=");
    expect(out.map((c) => c.id)).toEqual([1]); // #2 filtered out defensively
  });
});

describe("summarize", () => {
  it("counts totals, not-answered, talk time, distinct leads", () => {
    const s = summarize([
      { id: 1, userId: 86, personId: 9, duration: 100, outcome: null, isIncoming: false },
      { id: 2, userId: 86, personId: 9, duration: 0, outcome: "No Answer", isIncoming: false },
      { id: 3, userId: 86, personId: 7, duration: 60, outcome: null, isIncoming: true },
    ] as any);
    expect(s).toEqual({ total: 3, notAnswered: 1, answered: 2, incoming: 1, outgoing: 2, totalTalkSeconds: 160, distinctLeads: 2 });
  });
});

describe("myCallSummary", () => {
  it("summarizes only my calls", async () => {
    const calls = [
      { id: 1, userId: 86, personId: 9, duration: 100, outcome: null, isIncoming: false },
      { id: 2, userId: 79, personId: 8, duration: 50, outcome: null, isIncoming: true },
    ];
    const s = await myCallSummary(clientReturning(calls), 86, "today", NOW, TZ);
    expect(s.total).toBe(1);
  });
});
