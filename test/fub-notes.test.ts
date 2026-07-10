import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { listMyNotes } from "../src/fub/notes";

const NOW = new Date("2026-07-07T18:00:00Z");
const TZ = "America/New_York";

function clientReturning(notes: any[], capture?: (u: string) => void) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async (url: string) => { capture?.(url); return { ok: true, status: 200, json: async () => ({ notes, _metadata: {} }), text: async () => "" } as any; },
  });
}

describe("listMyNotes", () => {
  it("queries createdById + createdAfter and re-filters to my notes", async () => {
    let url = "";
    const notes = [
      { id: 1, personId: 9, createdById: 79, created: "2026-07-07T14:00:00Z", body: "mine" },
      { id: 2, personId: 8, createdById: 85, created: "2026-07-07T15:00:00Z", body: "theirs" },
    ];
    const out = await listMyNotes(clientReturning(notes, (u) => (url = u)), 79, "today", NOW, TZ);
    expect(url).toContain("createdById=79");
    expect(url).toContain("createdAfter=");
    expect(out.map((n) => n.id)).toEqual([1]);
  });
});
