import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { myEodReport, myTextsForPeriod } from "../src/fub/eod";

const NOW = new Date("2026-07-07T18:00:00Z");
const TZ = "America/New_York";

// routes matched by longest substring; person-scoped text pages keyed by personId
function client(routes: Record<string, any>) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async (url: string) => {
      const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
      return { ok: true, status: 200, json: async () => routes[key ?? ""] ?? { _metadata: {} }, text: async () => "" } as any;
    },
  });
}

describe("myTextsForPeriod", () => {
  it("keeps only my texts inside the window", async () => {
    const c = client({ "personId=9": { textMessages: [
      { id: 1, personId: 9, userId: 79, created: "2026-07-07T14:00:00Z", message: "mine-in" },
      { id: 2, personId: 9, userId: 85, created: "2026-07-07T14:05:00Z", message: "other-agent" },
      { id: 3, personId: 9, userId: 79, created: "2026-07-01T09:00:00Z", message: "mine-too-old" },
    ], _metadata: {} } });
    const out = await myTextsForPeriod(c, 79, [9], "2026-07-07T04:00:00.000Z");
    expect(out.map((t) => t.id)).toEqual([1]);
  });
});

describe("myEodReport", () => {
  it("bundles my calls + notes + texts on touched leads", async () => {
    const c = client({
      "/calls": { calls: [{ id: 11, userId: 79, personId: 9, duration: 100, outcome: null, isIncoming: false }], _metadata: {} },
      "/notes": { notes: [{ id: 21, personId: 12, createdById: 79, created: "2026-07-07T14:00:00Z", body: "n" }], _metadata: {} },
      "personId=9": { textMessages: [{ id: 31, personId: 9, userId: 79, created: "2026-07-07T15:00:00Z", message: "x" }], _metadata: {} },
      "personId=12": { textMessages: [{ id: 32, personId: 12, userId: 79, created: "2026-07-07T16:00:00Z", message: "y" }], _metadata: {} },
    });
    const r = await myEodReport(c, 79, "today", NOW, TZ);
    expect(r.calls.map((c2) => c2.id)).toEqual([11]);
    expect(r.notes.map((n) => n.id)).toEqual([21]);
    expect(r.texts.map((t) => t.id).sort()).toEqual([31, 32]); // texts from both touched leads (9 from call, 12 from note)
    expect(r.touchedLeadCount).toBe(2);
  });
});
