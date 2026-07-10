import { describe, it, expect } from "vitest";
import { formatCall, fmtDuration, leadName } from "../src/lib/format";

describe("format", () => {
  it("fmtDuration renders m:ss", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(142)).toBe("2:22");
    expect(fmtDuration(null)).toBe("0:00");
  });
  it("leadName falls back through name → first+last → Unknown", () => {
    expect(leadName({ name: "Jane Doe", firstName: null, lastName: null })).toBe("Jane Doe");
    expect(leadName({ name: null, firstName: "Jane", lastName: "Doe" })).toBe("Jane Doe");
    expect(leadName({ name: null, firstName: null, lastName: null })).toBe("Unknown");
  });
  it("formatCall exposes the AI summary note and direction", () => {
    const out = formatCall({
      id: 1, userId: 86, userName: "Ethan", personId: 9, name: "Jane Doe",
      firstName: null, lastName: null, isIncoming: false, duration: 142, ringDuration: 5,
      outcome: null, startedAt: "2026-07-07T14:00:00Z", created: "2026-07-07T14:02:00Z",
      recordingUrl: null, note: "Call Score: 8\nCustomer Sentiments: Positive\n...summary...",
    });
    expect(out.direction).toBe("outgoing");
    expect(out.duration).toBe("2:22");
    expect(out.summary).toContain("Call Score: 8");
    expect(out.outcome).toBe("—");
  });
});
