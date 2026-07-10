import { describe, it, expect } from "vitest";
import { isNotAnswered } from "../src/lib/classify";

describe("isNotAnswered", () => {
  it("outcome 'No Answer' → true", () => {
    expect(isNotAnswered({ outcome: "No Answer", duration: 0 })).toBe(true);
  });
  it("null outcome + 0 duration → true (best-effort)", () => {
    expect(isNotAnswered({ outcome: null, duration: 0 })).toBe(true);
  });
  it("null outcome + real duration → false (answered)", () => {
    expect(isNotAnswered({ outcome: null, duration: 142 })).toBe(false);
  });
  it("outcome 'Interested' + duration → false", () => {
    expect(isNotAnswered({ outcome: "Interested", duration: 90 })).toBe(false);
  });
});
