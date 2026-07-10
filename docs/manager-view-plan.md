# Manager Team-Performance View — Implementation Plan

> Implementation plan executed task-by-task, test-first. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-gated manager role to the existing FUB read-only MCP connector so Marco and Alexey can ask free-form, account-wide team-performance questions in Claude, while closers stay locked to their own data.

**Architecture:** Extend the existing Cloudflare Worker (`mcp-connector-fub/`). At Google login, an email allowlist sets an `isManager` flag in the session props. `FubMcp.init()` registers the 6 personal tools always, plus 6 team-wide read-only tools **only when `isManager` is true**. Team tools reuse the existing FUB client, period parser, and formatters; they call the same FUB endpoints without the "only me" filter.

**Tech Stack:** TypeScript, Cloudflare Workers, `agents` (McpAgent), `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk`, hono, zod v4, vitest.

## Global Constraints

- **Read-only only.** Every FUB call is a GET. Never add a POST/PUT/PATCH/DELETE. The FUB key stays a server secret.
- **Capability from verified identity, never from the prompt.** `isManager` is derived only from the Google-verified email. Tool arguments never grant access.
- **zod v4** (the `agents` package peer-requires v4 — already installed). Do not downgrade.
- **No secrets in the repo.** `MANAGER_EMAILS` holds only email addresses (not secret) and lives in `wrangler.toml [vars]`. The FUB key is already a deployed Worker secret — do not touch it.
- **No silent caps.** If a paginated sweep hits its page cap, the tool result must say the data is partial.
- **X-System header:** manager FUB reads use `"AHB Manager Reader"`; closer reads keep `"AHB Closer Reader"`.
- **Manager emails (verbatim):** `marco@acmehomebuyers.example`, `alexey@acmehomebuyers.example`.
- **Commits:** authored as Alexey. Use `git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "..."` (Windows line-ending safety).
- **Working dir:** all `npm`/`npx` commands run from `mcp-connector-fub/`. All `git` commands run from the repo root `A:/1.Automatic_Flows/6-automatic-workflows-marco-buys-homes`.
- **Test command:** `npm test` (= `vitest run`). **Typecheck:** `npx tsc --noEmit`.

---

## File structure

**New files:**
- `mcp-connector-fub/src/lib/managers.ts` — parse/lookup the manager email allowlist.
- `mcp-connector-fub/src/tools-manifest.ts` — the canonical tool-name lists + `toolManifest(isManager)` (lets us unit-test the gating decision without loading the MCP server).
- `mcp-connector-fub/src/fub/team.ts` — team aggregation: grouping helpers, `teamActivity`, `teamPipeline`, `listActiveStages`, `resolveCloser`, `EXCLUDED_PIPELINE_STAGES`.
- Tests: `test/managers.test.ts`, `test/tools-manifest.test.ts`, `test/fub-team.test.ts`, plus additions to `test/fub-people.test.ts`.
- `docs/manager-performance-view-guide.html` + `.pdf` — the cheat-sheet for Marco.

**Modified files:**
- `mcp-connector-fub/src/fub/users.ts` — add `listTeam(client)`.
- `mcp-connector-fub/src/fub/people.ts` — extract `getLeadTimeline` (no ownership check) + add `findLeadsAdmin`; keep `getLeadActivity`/`findMyLeads` behavior identical.
- `mcp-connector-fub/src/mcp.ts` — `Props.isManager`; `managerClient()`; `registerManagerTools()`; call it when `isManager`.
- `mcp-connector-fub/src/google-handler.ts` — compute `isManager`, add to props; `HandlerEnv.MANAGER_EMAILS`.
- `mcp-connector-fub/wrangler.toml` — add `MANAGER_EMAILS` to `[vars]`.

---

## Task 1: Manager email allowlist

**Files:**
- Create: `mcp-connector-fub/src/lib/managers.ts`
- Test: `mcp-connector-fub/test/managers.test.ts`

**Interfaces:**
- Produces: `parseManagerEmails(csv: string): Set<string>` (lower-cased, trimmed, empties dropped); `isManagerEmail(email: string, set: Set<string>): boolean` (case-insensitive).

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-connector-fub/test/managers.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- managers`
Expected: FAIL — `Cannot find module '../src/lib/managers'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// mcp-connector-fub/src/lib/managers.ts
export function parseManagerEmails(csv: string): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function isManagerEmail(email: string, set: Set<string>): boolean {
  return set.has((email ?? "").trim().toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- managers`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: manager email allowlist helper" -- mcp-connector-fub/src/lib/managers.ts mcp-connector-fub/test/managers.test.ts
```
(Run `git add` for the two files first.)

---

## Task 2: Tool manifest (gating decision, unit-testable)

**Files:**
- Create: `mcp-connector-fub/src/tools-manifest.ts`
- Test: `mcp-connector-fub/test/tools-manifest.test.ts`

**Interfaces:**
- Produces: `PERSONAL_TOOL_NAMES: string[]`; `MANAGER_TOOL_NAMES: string[]`; `toolManifest(isManager: boolean): string[]`.
- Consumed by: `mcp.ts` (Task 7) references these names when registering tools, so the manifest stays the single source of truth for which tools exist.

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-connector-fub/test/tools-manifest.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools-manifest`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// mcp-connector-fub/src/tools-manifest.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tools-manifest`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: tool manifest (per-role tool gating)" -- mcp-connector-fub/src/tools-manifest.ts mcp-connector-fub/test/tools-manifest.test.ts
```

---

## Task 3: People refactor — unrestricted timeline + admin search

**Files:**
- Modify: `mcp-connector-fub/src/fub/people.ts`
- Test: `mcp-connector-fub/test/fub-people.test.ts` (add cases)

**Interfaces:**
- Consumes: `FubClient`, `FubPerson`, `FubCall`, `ownsLead` (existing).
- Produces: `getLeadTimeline(client, personId): Promise<{person, calls, notes, texts}>` (NO ownership check); `findLeadsAdmin(client, query): Promise<FubPerson[]>` (no owner filter). `getLeadActivity(client, fubUserId, personId)` and `findMyLeads(client, fubUserId, query)` keep identical behavior.

- [ ] **Step 1: Write the failing test (append to existing file)**

```typescript
// append to mcp-connector-fub/test/fub-people.test.ts
import { getLeadTimeline, findLeadsAdmin } from "../src/fub/people";

describe("manager (unrestricted) people access", () => {
  function client(routes: Record<string, any>) {
    return new FubClient({
      apiKey: "K",
      fetchImpl: async (url: string) => {
        const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
        return { ok: true, status: 200, json: async () => routes[key ?? ""] ?? { _metadata: {} }, text: async () => "" } as any;
      },
    });
  }

  it("getLeadTimeline returns a lead's timeline with NO ownership check", async () => {
    const c = client({
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
    const c = client({
      "/people": { people: [
        { id: 1, name: "A", assignedUserId: 10 },
        { id: 2, name: "B", assignedUserId: 20 },
      ], _metadata: {} },
    });
    const leads = await findLeadsAdmin(c, "x");
    expect(leads.map((p) => p.id).sort()).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fub-people`
Expected: FAIL — `getLeadTimeline`/`findLeadsAdmin` not exported.

- [ ] **Step 3: Rewrite `people.ts`**

```typescript
// mcp-connector-fub/src/fub/people.ts
import { FubClient } from "./client";
import type { FubPerson, FubCall } from "../types";
import { ownsLead } from "../lib/scope";

const PERSON_FIELDS = "id,name,firstName,lastName,stage,assignedUserId,assignedTo,emails,phones";

export async function findMyLeads(client: FubClient, fubUserId: number, query: string): Promise<FubPerson[]> {
  const people = await client.getAllPages<FubPerson>(
    "/people",
    { name: query, fields: PERSON_FIELDS },
    "people",
    200,
  );
  return people.filter((p) => ownsLead(p, fubUserId));
}

// Manager: search all leads, no owner filter.
export async function findLeadsAdmin(client: FubClient, query: string): Promise<FubPerson[]> {
  return client.getAllPages<FubPerson>("/people", { name: query, fields: PERSON_FIELDS }, "people", 200);
}

async function fetchTimelineParts(client: FubClient, personId: number) {
  const calls = await client.getAllPages<FubCall>("/calls", { personId }, "calls", 100);
  const notes = await client.getAllPages("/notes", { personId }, "notes", 100);
  const texts = await client.getAllPages("/textMessages", { personId }, "textMessages", 100);
  return { calls, notes, texts };
}

// Manager: full timeline for ANY lead, no ownership check.
export async function getLeadTimeline(client: FubClient, personId: number) {
  const person = await client.get<FubPerson>(`/people/${personId}`, { fields: PERSON_FIELDS });
  return { person, ...(await fetchTimelineParts(client, personId)) };
}

// Closer: timeline only if the lead is assigned to them.
export async function getLeadActivity(client: FubClient, fubUserId: number, personId: number) {
  const person = await client.get<FubPerson>(`/people/${personId}`, { fields: PERSON_FIELDS });
  if (!ownsLead(person, fubUserId)) {
    throw new Error("This lead is not assigned to you.");
  }
  return { person, ...(await fetchTimelineParts(client, personId)) };
}
```

- [ ] **Step 4: Run tests to verify all pass (new + old)**

Run: `npm test -- fub-people`
Expected: PASS (existing owner-scoped cases + 2 new manager cases).

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: unrestricted lead timeline + admin lead search" -- mcp-connector-fub/src/fub/people.ts mcp-connector-fub/test/fub-people.test.ts
```

---

## Task 4: Team roster + closer resolver

**Files:**
- Modify: `mcp-connector-fub/src/fub/users.ts` (add `listTeam`)
- Create: `mcp-connector-fub/src/fub/team.ts` (start it — add `resolveCloser` + types)
- Test: `mcp-connector-fub/test/fub-team.test.ts`

**Interfaces:**
- Produces: `listTeam(client): Promise<FubUser[]>`; `resolveCloser(users: FubUser[], arg: string | number): CloserResolution` where `CloserResolution = { status:"ok"; user:{id;name} } | { status:"ambiguous"; candidates:{id;name}[] } | { status:"unknown" }`.

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-connector-fub/test/fub-team.test.ts
import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { listTeam } from "../src/fub/users";
import { resolveCloser } from "../src/fub/team";

const USERS = [
  { id: 86, name: "Ethan Serrano", email: "ethan@acmehomebuyers.example" },
  { id: 79, name: "Flora Stevens", email: "flora@acmehomebuyers.example" },
  { id: 82, name: "Hank Cole", email: "hank@acmehomebuyers.example" },
] as any[];

describe("listTeam", () => {
  it("returns the roster", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ users: USERS, _metadata: {} }), text: async () => "" } as any),
    });
    expect((await listTeam(c)).map((u) => u.id).sort()).toEqual([79, 82, 86]);
  });
});

describe("resolveCloser", () => {
  it("resolves a numeric id", () => {
    expect(resolveCloser(USERS, 79)).toEqual({ status: "ok", user: { id: 79, name: "Flora Stevens" } });
    expect(resolveCloser(USERS, "86")).toEqual({ status: "ok", user: { id: 86, name: "Ethan Serrano" } });
  });
  it("resolves a unique name substring case-insensitively", () => {
    expect(resolveCloser(USERS, "flora")).toEqual({ status: "ok", user: { id: 79, name: "Flora Stevens" } });
  });
  it("reports ambiguity", () => {
    const r = resolveCloser(USERS, "han");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates.map((c) => c.id).sort()).toEqual([82, 86]);
  });
  it("reports unknown", () => {
    expect(resolveCloser(USERS, "nobody")).toEqual({ status: "unknown" });
    expect(resolveCloser(USERS, 12345)).toEqual({ status: "unknown" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fub-team`
Expected: FAIL — `resolveCloser`/`listTeam` not found.

- [ ] **Step 3: Implement**

Add to `mcp-connector-fub/src/fub/users.ts` (append):

```typescript
export async function listTeam(client: FubClient): Promise<FubUser[]> {
  return client.getAllPages<FubUser>("/users", { fields: "id,name,email,role" }, "users", 200);
}
```

Create `mcp-connector-fub/src/fub/team.ts`:

```typescript
import type { FubUser } from "../types";

export type CloserResolution =
  | { status: "ok"; user: { id: number; name: string | null } }
  | { status: "ambiguous"; candidates: { id: number; name: string | null }[] }
  | { status: "unknown" };

export function resolveCloser(users: FubUser[], arg: string | number): CloserResolution {
  const raw = String(arg).trim();
  if (typeof arg === "number" || /^\d+$/.test(raw)) {
    const id = Number(raw);
    const u = users.find((x) => x.id === id);
    return u ? { status: "ok", user: { id: u.id, name: u.name } } : { status: "unknown" };
  }
  const q = raw.toLowerCase();
  const matches = users.filter(
    (u) => (u.name ?? "").toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q),
  );
  if (matches.length === 1) return { status: "ok", user: { id: matches[0].id, name: matches[0].name } };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches.map((u) => ({ id: u.id, name: u.name })) };
  return { status: "unknown" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fub-team`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: team roster + closer name/id resolver" -- mcp-connector-fub/src/fub/users.ts mcp-connector-fub/src/fub/team.ts mcp-connector-fub/test/fub-team.test.ts
```

---

## Task 5: team_activity aggregation

**Files:**
- Modify: `mcp-connector-fub/src/fub/team.ts` (add grouping + `teamActivity`)
- Test: `mcp-connector-fub/test/fub-team.test.ts` (add cases)

**Interfaces:**
- Consumes: `summarize`, `CallSummary` from `./calls`; `parsePeriod`, `PeriodInput` from `../lib/period`; `FubCall`, `FubNote`, `FubUser`.
- Produces: `groupCallsByUser(calls): Map<number, FubCall[]>`; `countNotesByUser(notes): Map<number, number>`; `buildTeamActivity(users, callsByUser, notesByUser): TeamActivityResult`; `teamActivity(client, users, period, now, tz): Promise<TeamActivityResult>`. `TeamActivityResult = { closers: CloserActivity[]; noActivity: {userId;name}[] }`, `CloserActivity = { userId; name; calls: CallSummary; notes: number }`.

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to mcp-connector-fub/test/fub-team.test.ts
import { groupCallsByUser, countNotesByUser, buildTeamActivity, teamActivity } from "../src/fub/team";

const NOW = new Date("2026-07-09T18:00:00Z");
const TZ = "America/New_York";

describe("team_activity grouping", () => {
  it("groups calls/notes by user and flags no-activity closers", () => {
    const users = [
      { id: 86, name: "Ethan", email: null },
      { id: 79, name: "Flora", email: null },
      { id: 82, name: "Hank", email: null },
    ] as any[];
    const calls = [
      { id: 1, userId: 86, personId: 5, duration: 120, outcome: null, isIncoming: false },
      { id: 2, userId: 86, personId: 6, duration: 0, outcome: "No Answer", isIncoming: false },
      { id: 3, userId: 79, personId: 5, duration: 60, outcome: null, isIncoming: true },
      { id: 4, userId: null, personId: 7, duration: 30, outcome: null, isIncoming: false }, // unattributed → ignored
    ] as any[];
    const notes = [
      { id: 10, createdById: 79 }, { id: 11, createdById: 79 }, { id: 12, createdById: 999 },
    ] as any[];

    const res = buildTeamActivity(users, groupCallsByUser(calls), countNotesByUser(notes));
    // sorted by call total desc: Ethan (2), Flora (1)
    expect(res.closers.map((c) => c.userId)).toEqual([86, 79]);
    expect(res.closers[0].calls.total).toBe(2);
    expect(res.closers[0].calls.answered).toBe(1);   // one 120s, one no-answer
    expect(res.closers[1].notes).toBe(2);            // Flora authored 2
    expect(res.noActivity.map((n) => n.userId)).toEqual([82]); // Hank: nothing
  });

  it("teamActivity sweeps calls+notes for the period and aggregates", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async (url: string) => {
        const body = url.includes("/calls")
          ? { calls: [{ id: 1, userId: 86, duration: 100, outcome: null, isIncoming: false, personId: 5 }], _metadata: {} }
          : url.includes("/notes")
          ? { notes: [{ id: 9, createdById: 86 }], _metadata: {} }
          : { _metadata: {} };
        return { ok: true, status: 200, json: async () => body, text: async () => "" } as any;
      },
    });
    const users = [{ id: 86, name: "Ethan", email: null }] as any[];
    const res = await teamActivity(c, users, "today", NOW, TZ);
    expect(res.closers).toHaveLength(1);
    expect(res.closers[0].calls.total).toBe(1);
    expect(res.closers[0].notes).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fub-team`
Expected: FAIL — grouping/`teamActivity` not exported.

- [ ] **Step 3: Implement (append to `team.ts`)**

```typescript
import { FubClient } from "./client";
import type { FubCall, FubNote } from "../types";
import { summarize, type CallSummary } from "./calls";
import { parsePeriod, type PeriodInput } from "../lib/period";

export interface CloserActivity {
  userId: number;
  name: string | null;
  calls: CallSummary;
  notes: number;
}
export interface TeamActivityResult {
  closers: CloserActivity[];
  noActivity: { userId: number; name: string | null }[];
}

export function groupCallsByUser(calls: FubCall[]): Map<number, FubCall[]> {
  const m = new Map<number, FubCall[]>();
  for (const c of calls) {
    if (typeof c.userId !== "number") continue; // unattributed calls can't be credited to a closer
    const arr = m.get(c.userId);
    if (arr) arr.push(c);
    else m.set(c.userId, [c]);
  }
  return m;
}

export function countNotesByUser(notes: FubNote[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of notes) {
    if (typeof n.createdById !== "number") continue;
    m.set(n.createdById, (m.get(n.createdById) ?? 0) + 1);
  }
  return m;
}

export function buildTeamActivity(
  users: FubUser[],
  callsByUser: Map<number, FubCall[]>,
  notesByUser: Map<number, number>,
): TeamActivityResult {
  const closers: CloserActivity[] = [];
  const noActivity: { userId: number; name: string | null }[] = [];
  for (const u of users) {
    const calls = callsByUser.get(u.id) ?? [];
    const notes = notesByUser.get(u.id) ?? 0;
    if (calls.length === 0 && notes === 0) {
      noActivity.push({ userId: u.id, name: u.name });
      continue;
    }
    closers.push({ userId: u.id, name: u.name, calls: summarize(calls), notes });
  }
  closers.sort((a, b) => b.calls.total - a.calls.total);
  return { closers, noActivity };
}

export async function teamActivity(
  client: FubClient,
  users: FubUser[],
  period: PeriodInput,
  now: Date,
  tz: string,
): Promise<TeamActivityResult> {
  const p = parsePeriod(period, now, tz);
  const dateParams = { createdAfter: p.createdAfter, ...(p.createdBefore ? { createdBefore: p.createdBefore } : {}) };
  const calls = await client.getAllPages<FubCall>("/calls", dateParams, "calls", 2000);
  const notes = await client.getAllPages<FubNote>("/notes", dateParams, "notes", 2000);
  return buildTeamActivity(users, groupCallsByUser(calls), countNotesByUser(notes));
}
```

Note: `team.ts` now imports from `./calls`, `./client`, `../lib/period`, and `../types`. Keep the existing `resolveCloser`/`FubUser` import at the top; merge the `FubUser` import into one `import type { FubUser, FubCall, FubNote } from "../types";` line to avoid a duplicate import (tsc will flag duplicates).

- [ ] **Step 4: Run test + typecheck**

Run: `npm test -- fub-team` → Expected: PASS.
Run: `npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: team_activity leaderboard aggregation" -- mcp-connector-fub/src/fub/team.ts mcp-connector-fub/test/fub-team.test.ts
```

---

## Task 6: team_pipeline + active-stage discovery

**Files:**
- Modify: `mcp-connector-fub/src/fub/team.ts`
- Test: `mcp-connector-fub/test/fub-team.test.ts` (add cases)

**Interfaces:**
- Consumes: `FubPerson`, `FubUser`, `FubClient`.
- Produces: `EXCLUDED_PIPELINE_STAGES: Set<string>`; `listActiveStages(client, excluded): Promise<string[]>`; `groupPeopleByCloser(people, userNames): {userId;name;count}[]`; `teamPipeline(client, users, activeStages): Promise<TeamPipelineResult>` where `TeamPipelineResult = { stages: PipelineStage[]; partial: boolean }`, `PipelineStage = { stage: string; total: number; byCloser: {userId;name;count}[] }`.

> ⚠️ Build-time confirmation (do this step, don't skip): the exact FUB stage names and whether `GET /v1/people` filters by `stage` (vs `stageId`) must be confirmed live before this tool is correct. Run, from repo root with the key from `.env`:
> `curl -s -u "$FUB_API_KEY:" -H "X-System: AHB Manager Reader" "https://api.followupboss.com/v1/stages" | python -m json.tool`
> Then set `EXCLUDED_PIPELINE_STAGES` to the terminal/archived stage names you see (e.g. Trash, Closed, Dead). If `/people?stage=<name>` returns 0 across the board, switch the query param to `stageId` (map name→id from `/stages`) — note this in a code comment. Confirm on a single active stage that counts look sane.

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to mcp-connector-fub/test/fub-team.test.ts
import { groupPeopleByCloser, teamPipeline, listActiveStages, EXCLUDED_PIPELINE_STAGES } from "../src/fub/team";

describe("team_pipeline", () => {
  it("groupPeopleByCloser counts per assignee, unassigned bucketed", () => {
    const names = new Map<number, string | null>([[86, "Ethan"], [79, "Flora"]]);
    const people = [
      { id: 1, assignedUserId: 86 }, { id: 2, assignedUserId: 86 },
      { id: 3, assignedUserId: 79 }, { id: 4, assignedUserId: null },
    ] as any[];
    const g = groupPeopleByCloser(people, names);
    expect(g[0]).toEqual({ userId: 86, name: "Ethan", count: 2 }); // sorted desc
    expect(g.find((x) => x.userId === null)).toEqual({ userId: null, name: "Unassigned", count: 1 });
  });

  it("listActiveStages drops excluded stage names", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        stages: [{ id: 1, name: "Lead" }, { id: 2, name: "Under Contract" }, { id: 3, name: "Trash" }], _metadata: {},
      }), text: async () => "" } as any),
    });
    const active = await listActiveStages(c, new Set(["Trash"]));
    expect(active).toEqual(["Lead", "Under Contract"]);
  });

  it("teamPipeline queries each active stage and flags partial when capped", async () => {
    const c = new FubClient({
      apiKey: "K",
      fetchImpl: async (url: string) => {
        const body = url.includes("stage=Lead")
          ? { people: [{ id: 1, assignedUserId: 86 }, { id: 2, assignedUserId: 79 }], _metadata: {} }
          : url.includes("stage=Offer")
          ? { people: [{ id: 3, assignedUserId: 86 }], _metadata: {} }
          : { people: [], _metadata: {} };
        return { ok: true, status: 200, json: async () => body, text: async () => "" } as any;
      },
    });
    const users = [{ id: 86, name: "Ethan", email: null }, { id: 79, name: "Flora", email: null }] as any[];
    const res = await teamPipeline(c, users, ["Lead", "Offer"]);
    expect(res.stages.map((s) => [s.stage, s.total])).toEqual([["Lead", 2], ["Offer", 1]]);
    expect(res.partial).toBe(false);
  });

  it("EXCLUDED_PIPELINE_STAGES is a Set", () => {
    expect(EXCLUDED_PIPELINE_STAGES instanceof Set).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fub-team`
Expected: FAIL — pipeline exports missing.

- [ ] **Step 3: Implement (append to `team.ts`)**

```typescript
import type { FubPerson } from "../types"; // merge into the existing "../types" import line

export interface PipelineStage {
  stage: string;
  total: number;
  byCloser: { userId: number | null; name: string | null; count: number }[];
}
export interface TeamPipelineResult {
  stages: PipelineStage[];
  partial: boolean;
}

// Terminal/archived stages excluded from the pipeline view by default.
// CONFIRM against GET /v1/stages during build (see task note).
export const EXCLUDED_PIPELINE_STAGES = new Set<string>(["Trash", "Closed", "Dead", "Dead Lead"]);

const PIPELINE_PAGE_CAP = 1000;

export async function listActiveStages(client: FubClient, excluded: Set<string>): Promise<string[]> {
  const stages = await client.getAllPages<{ id: number; name: string }>("/stages", {}, "stages", 200);
  return stages.map((s) => s.name).filter((n): n is string => !!n && !excluded.has(n));
}

export function groupPeopleByCloser(
  people: FubPerson[],
  userNames: Map<number, string | null>,
): { userId: number | null; name: string | null; count: number }[] {
  const counts = new Map<number | null, number>();
  for (const p of people) {
    const uid = typeof p.assignedUserId === "number" ? p.assignedUserId : null;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([userId, count]) => ({
      userId,
      name: userId === null ? "Unassigned" : userNames.get(userId) ?? `User ${userId}`,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

export async function teamPipeline(
  client: FubClient,
  users: FubUser[],
  activeStages: string[],
): Promise<TeamPipelineResult> {
  const userNames = new Map(users.map((u) => [u.id, u.name] as const));
  const stages: PipelineStage[] = [];
  let partial = false;
  for (const stage of activeStages) {
    const people = await client.getAllPages<FubPerson>(
      "/people",
      { stage, fields: "id,assignedUserId,stage" },
      "people",
      PIPELINE_PAGE_CAP,
    );
    if (people.length >= PIPELINE_PAGE_CAP) partial = true; // hit the cap → counts for this stage are partial
    stages.push({ stage, total: people.length, byCloser: groupPeopleByCloser(people, userNames) });
  }
  return { stages, partial };
}
```

- [ ] **Step 4: Run tests + typecheck + confirm stages live**

Run: `npm test -- fub-team` → Expected: PASS.
Run: `npx tsc --noEmit` → Expected: no errors.
Run the `curl .../v1/stages` command from the task note; update `EXCLUDED_PIPELINE_STAGES` to the real terminal stage names; re-run `npm test`.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: team_pipeline (stage x closer) + active-stage discovery" -- mcp-connector-fub/src/fub/team.ts mcp-connector-fub/test/fub-team.test.ts
```

---

## Task 7: Wire config + role gating + manager tools

**Files:**
- Modify: `mcp-connector-fub/wrangler.toml`
- Modify: `mcp-connector-fub/src/google-handler.ts`
- Modify: `mcp-connector-fub/src/mcp.ts`

**Interfaces:**
- Consumes: `parseManagerEmails`, `isManagerEmail` (Task 1); `MANAGER_TOOL_NAMES` (Task 2); `listTeam` (Task 4); `findLeadsAdmin`, `getLeadTimeline` (Task 3); `teamActivity`, `teamPipeline`, `listActiveStages`, `resolveCloser`, `EXCLUDED_PIPELINE_STAGES` (Tasks 4–6); `myEodReport` (existing).
- Produces: manager tools registered at runtime when `props.isManager`.

- [ ] **Step 1: Add the config var**

In `mcp-connector-fub/wrangler.toml`, under `[vars]`:

```toml
[vars]
ALLOWED_EMAIL_DOMAIN = "acmehomebuyers.example"
ACCOUNT_TZ = "America/New_York"
MANAGER_EMAILS = "marco@acmehomebuyers.example,alexey@acmehomebuyers.example"
```

- [ ] **Step 2: Set `isManager` at login**

In `mcp-connector-fub/src/google-handler.ts`:

1. Add import at top:
```typescript
import { parseManagerEmails, isManagerEmail } from "./lib/managers";
```
2. Add to `HandlerEnv`:
```typescript
  MANAGER_EMAILS: string;
```
3. In `/callback`, replace the `completeAuthorization` props with:
```typescript
    const isManager = isManagerEmail(info.email, parseManagerEmails(c.env.MANAGER_EMAILS));
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: info.email,
      scope: oauthReqInfo.scope ?? [],
      metadata: { label: fubUser.name ?? info.email },
      props: { fubUserId: fubUser.id, email: info.email, name: fubUser.name, isManager },
    });
```

- [ ] **Step 3: Add `isManager` to Props + register manager tools in `mcp.ts`**

1. In `Props`:
```typescript
export interface Props {
  fubUserId: number;
  email: string;
  name: string | null;
  isManager: boolean;
  [key: string]: unknown;
}
```
2. Add imports at top:
```typescript
import { listTeam } from "./fub/users";
import { findLeadsAdmin, getLeadTimeline } from "./fub/people";
import {
  teamActivity, teamPipeline, listActiveStages, resolveCloser, EXCLUDED_PIPELINE_STAGES,
} from "./fub/team";
import { MANAGER_TOOL_NAMES } from "./tools-manifest";
```
3. Add a manager client helper next to `client()`:
```typescript
  private managerClient(): FubClient {
    return new FubClient({ apiKey: this.env.FUB_API_KEY, xSystem: "AHB Manager Reader" });
  }
```
4. At the END of `init()` (after the six personal `this.server.tool(...)` blocks), add:
```typescript
    if (this.props?.isManager) this.registerManagerTools();
```
5. Add the method (registers exactly `MANAGER_TOOL_NAMES`):
```typescript
  private registerManagerTools() {
    const tz = this.tz();

    this.server.tool(
      "list_team",
      "List all Follow Up Boss team members (id, name, email, role). Manager only.",
      {},
      async () => {
        const users = await listTeam(this.managerClient());
        const view = users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role ?? null }));
        return { content: [{ type: "text", text: JSON.stringify({ count: view.length, team: view }, null, 2) }] };
      },
    );

    this.server.tool(
      "team_activity",
      "TEAM leaderboard for a period: per-closer calls (total/answered/no-answer/talk time/distinct leads) and notes authored, plus a no-activity list. Manager only. (Texts are not counted team-wide — FUB has no account-wide by-agent text feed.)",
      { period: PERIOD },
      async ({ period }) => {
        const c = this.managerClient();
        const users = await listTeam(c);
        const res = await teamActivity(c, users, period, new Date(), tz);
        return { content: [{ type: "text", text: JSON.stringify({ period, ...res }, null, 2) }] };
      },
    );

    this.server.tool(
      "closer_activity",
      "Full activity for ONE closer for a period: their calls (with AI-summary notes), notes, and texts on touched leads. Accepts a name or a FUB user id. Manager only.",
      { closer: z.union([z.string().min(1), z.number().int().positive()]), period: PERIOD },
      async ({ closer, period }) => {
        const c = this.managerClient();
        const users = await listTeam(c);
        const r = resolveCloser(users, closer);
        if (r.status === "unknown")
          return { content: [{ type: "text", text: `No team member matches "${closer}". Try list_team.` }], isError: true };
        if (r.status === "ambiguous")
          return { content: [{ type: "text", text: `"${closer}" is ambiguous. Candidates: ${JSON.stringify(r.candidates)}. Re-ask with the id.` }], isError: true };
        const rep = await myEodReport(c, r.user.id, period, new Date(), tz);
        const payload = {
          closer: r.user,
          period,
          calls: rep.calls.map(formatCall),
          notes: rep.notes.map((n) => ({ leadId: n.personId, created: n.created, subject: n.subject, body: n.body })),
          texts: rep.texts.map((t) => ({ leadId: t.personId, created: t.created, direction: t.isIncoming ? "incoming" : "outgoing", message: t.message })),
          note: rep.textsCapped ? `Texts cover the first 50 of ${rep.touchedLeadCount} touched leads.` : undefined,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      },
    );

    this.server.tool(
      "team_pipeline",
      "Live pipeline: lead counts by stage x closer (active stages only; excludes archived/closed). Manager only. May take a few seconds on large accounts.",
      {},
      async () => {
        const c = this.managerClient();
        const users = await listTeam(c);
        const activeStages = await listActiveStages(c, EXCLUDED_PIPELINE_STAGES);
        const res = await teamPipeline(c, users, activeStages);
        const text = JSON.stringify(res, null, 2) + (res.partial ? "\n\nNOTE: some stages hit the page cap — counts are partial." : "");
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.tool(
      "find_leads",
      "Search ALL Follow Up Boss leads by name (any assignee). Returns id, name, stage, assigned closer. Manager only.",
      { query: z.string().min(1) },
      async ({ query }) => {
        const leads = await findLeadsAdmin(this.managerClient(), query);
        const view = leads.map((p) => ({ id: p.id, name: leadName(p), stage: p.stage, assignedUserId: p.assignedUserId, assignedTo: p.assignedTo ?? null }));
        return { content: [{ type: "text", text: JSON.stringify({ count: view.length, leads: view }, null, 2) }] };
      },
    );

    this.server.tool(
      "lead_activity",
      "Full timeline (calls, notes, texts) for ANY lead by id. Manager only.",
      { personId: z.number().int().positive() },
      async ({ personId }) => {
        const a = await getLeadTimeline(this.managerClient(), personId);
        return { content: [{ type: "text", text: JSON.stringify({
          lead: { id: a.person.id, name: leadName(a.person), stage: a.person.stage, assignedTo: a.person.assignedTo ?? null },
          calls: a.calls.map(formatCall),
          notes: a.notes,
          texts: a.texts,
        }, null, 2) }] };
      },
    );
    // Registered set must equal MANAGER_TOOL_NAMES (tools-manifest.ts).
    void MANAGER_TOOL_NAMES;
  }
```

- [ ] **Step 4: Typecheck + full test run**

Run: `npx tsc --noEmit` → Expected: no errors.
Run: `npm test` → Expected: ALL tests pass (existing 27 + new).

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: wire manager role gating + 6 team tools" -- mcp-connector-fub/wrangler.toml mcp-connector-fub/src/google-handler.ts mcp-connector-fub/src/mcp.ts
```

---

## Task 8: Deploy + live end-to-end verification

**Files:** none (deploy + manual verification). No test file.

- [ ] **Step 1: Deploy the Worker**

From `mcp-connector-fub/` (PowerShell), loading the Cloudflare token from `.env`:
```powershell
$env:CLOUDFLARE_API_TOKEN = (Get-Content ../.env | Select-String '^CLOUDFLARE_API_TOKEN=').ToString().Split('=',2)[1].Trim()
$env:CLOUDFLARE_ACCOUNT_ID = (Get-Content ../.env | Select-String '^CLOUDFLARE_ACCOUNT_ID=').ToString().Split('=',2)[1].Trim()
npx wrangler deploy
```
Expected: `Uploaded fub-connector`, a version id, and the bound `MANAGER_EMAILS` var listed. (No secret upload needed — `MANAGER_EMAILS` is a plain var; the FUB key secret is already set.)

- [ ] **Step 2: Confirm the deploy is healthy**

```bash
curl -s -o /dev/null -w "mcp:%{http_code}\n" https://fub-connector.your-subdomain.workers.dev/mcp
curl -s https://fub-connector.your-subdomain.workers.dev/.well-known/oauth-authorization-server -o /dev/null -w "wk:%{http_code}\n"
```
Expected: `mcp:401` and `wk:200` (unchanged endpoints).

- [ ] **Step 3: Reconnect Alexey so the session gets `isManager`**

The `isManager` prop is written at login, so the existing session predates it. In claude.ai → Connectors → **Follow Up Boss → Disconnect, then Connect** (Google sign-in). This is a human step (real Google click). Drive the browser to the Connectors page and hand off the Google login to the user, then confirm the ✓.

- [ ] **Step 4: Verify manager tools live (as Alexey)**

In a new Claude chat, run each and confirm real, sane data (drive via browser; approve tool prompts):
- "Using Follow Up Boss, show me the team activity leaderboard for today." → `team_activity`: multiple closers, counts reconcile against FUB.
- "Show me everything Ethan did today." → `closer_activity` (resolves the name).
- "Show me the pipeline by stage." → `team_pipeline`: stage × closer counts; no `partial` note on a normal account.
- "Search all leads named Smith." → `find_leads` (account-wide).

- [ ] **Step 5: Verify a closer still sees NO manager tools**

Reason from the gate: manager tools register only when `props.isManager`. Confirm the manifest test (`toolManifest(false)` has 6 names, none of the manager names) is green, and that the closer allowlist excludes everyone but Marco/Alexey. (If a spare non-manager `@acmehomebuyers.example` test login is available, connect and confirm the tool list shows only the `*_my_*`/`eod_report` tools.) Record the result in the go-live doc.

- [ ] **Step 6: No commit** (deploy only). Note the deployed version id in the session summary.

---

## Task 9: Cheat-sheet deliverable (PDF + HTML) with limitations

**Files:**
- Create: `docs/manager-performance-view-guide.html`
- Create: `docs/manager-performance-view-guide.pdf` (rendered from the HTML)

- [ ] **Step 1: Write the HTML guide**

Create `docs/manager-performance-view-guide.html` styled consistently with `docs/final-report-overview.html` (open it first to match fonts/colors/structure). Content:
- **Title:** "AHB — Manager Team-Performance View (Follow Up Boss in Claude)".
- **Who has it:** Marco and Alexey only; everyone else stays scoped to their own data.
- **How to use:** connect the Follow Up Boss connector, then just ask in plain English.
- **What you can ask** — a table with columns *Category · Example question · What it pulls*:
  - Team activity — "How did the team do today?" / "Who made the most calls this week?" → per-closer calls, answered/no-answer, talk time, notes.
  - Individual closer — "Show me everything Ethan did today." → that closer's calls (with AI summaries), notes, texts.
  - Pipeline — "What's the pipeline by stage?" / "Who has the most leads in Under Contract?" → lead counts by stage × closer.
  - Leads — "Find all leads named Smith." / "Show the full history for lead 266367." → account-wide lead search and single-lead timeline.
- **Limitations** (dedicated section):
  - No team-wide **texts-sent count** (FUB has no account-wide by-agent text feed); texts appear per-lead in individual/lead views.
  - **Deals / revenue / conversion** are a coming-soon fast-follow — not available yet.
  - Pipeline shows **active stages only** by default (excludes archived/closed); it is a live snapshot and may take a few seconds on a large account; if a stage is very large the tool will say counts are partial.
  - Answered-vs-not-answered is **best-effort** for calls logged by our own automations.
  - Everything is **read-only** — Claude can report, never change FUB.

- [ ] **Step 2: Render the PDF**

Prefer Chrome headless (matches how the other docs were produced):
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu --print-to-pdf="A:\1.Automatic_Flows\6-automatic-workflows-marco-buys-homes\docs\manager-performance-view-guide.pdf" "file:///A:/1.Automatic_Flows/6-automatic-workflows-marco-buys-homes/docs/manager-performance-view-guide.html"
```
If Chrome isn't at that path, find it (`(Get-Command chrome).Source` or check `Program Files (x86)`). Verify the PDF exists and is non-empty.

- [ ] **Step 3: Commit**

```bash
git -c core.autocrlf=input commit --author="Alexey <alexey@acmehomebuyers.example>" -m "MCP Connector for FUB phase 2: manager performance-view cheat-sheet (HTML + PDF)" -- docs/manager-performance-view-guide.html docs/manager-performance-view-guide.pdf
```

---

## Self-review (completed by planner)

- **Spec coverage:** role gating → Tasks 1,7; `list_team` → 4,7; `team_activity` (A) → 5,7; `closer_activity` (D) → 3,4,7; `team_pipeline` (B) → 6,7; `find_leads`/`lead_activity` → 3,7; performance handling → 6 (per-stage query + cap + `partial`); error handling → 7 (ambiguous/unknown closer, isError); testing → 1–7; deploy/reconnect → 8; cheat-sheet + limitations → 9; deals deferred → not built (documented in 9). No gaps.
- **Placeholder scan:** none — all steps carry real code/commands. The one build-time confirmation (FUB stage names / `stage` vs `stageId`) is an explicit, actionable step in Task 6, not a placeholder.
- **Type consistency:** `TeamActivityResult`, `CloserActivity`, `CallSummary` (reused from `calls.ts`), `TeamPipelineResult`, `PipelineStage`, `CloserResolution`, `Props.isManager`, and tool names (`MANAGER_TOOL_NAMES`) are consistent across Tasks 2–7. `getLeadTimeline`/`findLeadsAdmin`/`listTeam`/`resolveCloser`/`teamActivity`/`teamPipeline`/`listActiveStages` signatures match between producer and consumer tasks.
