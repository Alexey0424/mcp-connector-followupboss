import { describe, it, expect } from "vitest";
import { PERSONAL_TOOL_NAMES, MANAGER_TOOL_NAMES, toolManifest } from "../src/tools-manifest";

describe("toolManifest", () => {
  it("a closer sees only the 6 personal tools", () => {
    expect(toolManifest(false)).toEqual(PERSONAL_TOOL_NAMES);
    expect(toolManifest(false)).toHaveLength(6);
    for (const n of MANAGER_TOOL_NAMES) expect(toolManifest(false)).not.toContain(n);
  });
  it("a manager sees personal + manager tools", () => {
    const m = toolManifest(true);
    for (const n of PERSONAL_TOOL_NAMES) expect(m).toContain(n);
    for (const n of MANAGER_TOOL_NAMES) expect(m).toContain(n);
    expect(m).toHaveLength(PERSONAL_TOOL_NAMES.length + MANAGER_TOOL_NAMES.length);
  });
  it("manager tool names are exactly the agreed set", () => {
    expect([...MANAGER_TOOL_NAMES].sort()).toEqual(
      ["closer_activity", "find_leads", "lead_activity", "list_team", "team_activity", "team_pipeline"],
    );
  });
});
