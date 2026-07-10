import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { findMyLeads, getLeadActivity, getLeadTimeline, findLeadsAdmin } from "../src/fub/people";

function client(routes: Record<string, any>) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async (url: string) => {
      const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k))!;
      return { ok: true, status: 200, json: async () => routes[key], text: async () => "" } as any;
    },
  });
}

describe("findMyLeads", () => {
  it("returns only leads assigned to me", async () => {
    const c = client({ "/people?": { people: [
      { id: 1, name: "Mine", assignedUserId: 86 },
      { id: 2, name: "Theirs", assignedUserId: 79 },
    ], _metadata: {} } });
    const out = await findMyLeads(c, 86, "smith");
    expect(out.map((p) => p.id)).toEqual([1]);
  });
});

describe("getLeadActivity", () => {
  it("refuses a lead not assigned to me", async () => {
    const c = client({ "/people/2": { id: 2, assignedUserId: 79 } });
    await expect(getLeadActivity(c, 86, 2)).rejects.toThrow(/not assigned to you/i);
  });
  it("returns timeline for my lead", async () => {
    const c = client({
      "/people/1": { id: 1, name: "Mine", assignedUserId: 86 },
      "/calls": { calls: [{ id: 5 }], _metadata: {} },
      "/notes": { notes: [{ id: 7 }], _metadata: {} },
      "/textMessages": { textMessages: [{ id: 9 }], _metadata: {} },
    });
    const out = await getLeadActivity(c, 86, 1);
    expect(out.person.id).toBe(1);
    expect(out.calls.length).toBe(1);
    expect(out.notes.length).toBe(1);
    expect(out.texts.length).toBe(1);
  });
});

describe("manager (unrestricted) people access", () => {
  function mkClient(routes: Record<string, any>) {
    return new FubClient({
      apiKey: "K",
      fetchImpl: async (url: string) => {
        const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
        return { ok: true, status: 200, json: async () => routes[key ?? ""] ?? { _metadata: {} }, text: async () => "" } as any;
      },
    });
  }

  it("getLeadTimeline returns a lead's timeline with NO ownership check", async () => {
    const c = mkClient({
      "/people/500": { id: 500, name: "Someone Else", stage: "Lead", assignedUserId: 999 },
      "/calls": { calls: [{ id: 1, personId: 500, userId: 999 }], _metadata: {} },
      "/notes": { notes: [{ id: 2, personId: 500 }], _metadata: {} },
      "/textMessages": { textMessages: [{ id: 3, personId: 500 }], _metadata: {} },
    });
    const t = await getLeadTimeline(c, 500);
    expect(t.person.id).toBe(500);
    expect(t.calls.map((x: any) => x.id)).toEqual([1]);
    expect(t.notes.map((x: any) => x.id)).toEqual([2]);
    expect(t.texts.map((x: any) => x.id)).toEqual([3]);
  });

  it("findLeadsAdmin returns leads regardless of assignment", async () => {
    const c = mkClient({
      "/people": { people: [
        { id: 1, name: "A", assignedUserId: 10 },
        { id: 2, name: "B", assignedUserId: 20 },
      ], _metadata: {} },
    });
    const leads = await findLeadsAdmin(c, "x");
    expect(leads.map((p) => p.id).sort()).toEqual([1, 2]);
  });
});
