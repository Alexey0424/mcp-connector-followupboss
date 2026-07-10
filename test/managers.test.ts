import { describe, it, expect } from "vitest";
import { parseManagerEmails, isManagerEmail } from "../src/lib/managers";

describe("manager allowlist", () => {
  const set = parseManagerEmails(" marco@acmehomebuyers.example , Alexey@AcmeHomeBuyers.example ,, ");

  it("parses, trims, l-cases, drops empties", () => {
    expect([...set].sort()).toEqual(["alexey@acmehomebuyers.example", "marco@acmehomebuyers.example"]);
  });
  it("matches case-insensitively", () => {
    expect(isManagerEmail("MARCO@acmehomebuyers.example", set)).toBe(true);
    expect(isManagerEmail("alexey@acmehomebuyers.example", set)).toBe(true);
  });
  it("rejects non-managers and empty input", () => {
    expect(isManagerEmail("ethan@acmehomebuyers.example", set)).toBe(false);
    expect(isManagerEmail("", set)).toBe(false);
    expect(isManagerEmail("marco@acmehomebuyers.example", parseManagerEmails(""))).toBe(false);
  });
});
