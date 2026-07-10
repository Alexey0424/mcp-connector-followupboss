import { describe, it, expect } from "vitest";
import { parsePeriod } from "../src/lib/period";

const TZ = "America/New_York"; // -04:00 in July (DST)

describe("parsePeriod", () => {
  it("'today' = local-midnight in tz, as UTC Z", () => {
    // 2026-07-07T01:30:00Z is 2026-07-06 21:30 ET → local day is the 6th
    const p = parsePeriod("today", new Date("2026-07-07T01:30:00Z"), TZ);
    expect(p.createdAfter).toBe("2026-07-06T04:00:00.000Z");
    expect(p.createdBefore).toBeUndefined();
  });

  it("'yesterday' spans the prior local day", () => {
    const p = parsePeriod("yesterday", new Date("2026-07-07T15:00:00Z"), TZ);
    expect(p.createdAfter).toBe("2026-07-06T04:00:00.000Z");
    expect(p.createdBefore).toBe("2026-07-07T04:00:00.000Z");
  });

  it("'last_7_days' is a rolling window from now", () => {
    const p = parsePeriod("last_7_days", new Date("2026-07-07T12:00:00Z"), TZ);
    expect(p.createdAfter).toBe("2026-06-30T12:00:00.000Z");
  });

  it("custom range passes through as UTC", () => {
    const p = parsePeriod({ from: "2026-07-01T00:00:00-04:00", to: "2026-07-02T00:00:00-04:00" }, new Date("2026-07-07T12:00:00Z"), TZ);
    expect(p.createdAfter).toBe("2026-07-01T04:00:00.000Z");
    expect(p.createdBefore).toBe("2026-07-02T04:00:00.000Z");
  });
});
