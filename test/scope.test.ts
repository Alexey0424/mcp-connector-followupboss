import { describe, it, expect } from "vitest";
import { filterOwnedCalls, ownsLead } from "../src/lib/scope";

describe("scope guards", () => {
  it("filterOwnedCalls keeps only calls whose userId === me", () => {
    const calls = [
      { userId: 86, id: 1 }, { userId: 79, id: 2 }, { userId: 86, id: 3 }, { userId: null, id: 4 },
    ] as any;
    expect(filterOwnedCalls(calls, 86).map((c: any) => c.id)).toEqual([1, 3]);
  });
  it("ownsLead is true only when assignedUserId === me", () => {
    expect(ownsLead({ assignedUserId: 86 } as any, 86)).toBe(true);
    expect(ownsLead({ assignedUserId: 79 } as any, 86)).toBe(false);
    expect(ownsLead({ assignedUserId: null } as any, 86)).toBe(false);
  });
});
