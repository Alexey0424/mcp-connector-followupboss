// Single source of truth for which tools exist per role. mcp.ts registers exactly these.
export const PERSONAL_TOOL_NAMES = [
  "list_my_calls",
  "my_call_summary",
  "list_my_notes",
  "find_my_leads",
  "get_lead_activity",
  "eod_report",
];

export const MANAGER_TOOL_NAMES = [
  "list_team",
  "team_activity",
  "closer_activity",
  "team_pipeline",
  "find_leads",
  "lead_activity",
];

export function toolManifest(isManager: boolean): string[] {
  return isManager ? [...PERSONAL_TOOL_NAMES, ...MANAGER_TOOL_NAMES] : [...PERSONAL_TOOL_NAMES];
}
