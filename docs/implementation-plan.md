# MCP Connector for FUB — FUB read-only MCP connector — Implementation Plan

> Implementation plan executed task-by-task, test-first. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker exposing a remote MCP server that lets each AHB closer ask Claude (Team plan) about **only their own** Follow Up Boss call logs and leads, read-only, identity enforced server-side via Google sign-in.

**Architecture:** `@cloudflare/workers-oauth-provider` fronts the Worker: it delegates login to Google (restricted to `@acmehomebuyers.example`), maps the verified email → FUB `userId`, and stores that in the session `props`. An `McpAgent` (from `agents/mcp`) exposes four read-only tools; every tool reads `this.props.fubUserId` (never a tool argument) and injects it into FUB queries, re-validating ownership before returning. One server-side FUB API key (a Worker secret) does all reads; closers never see it.

**Tech Stack:** TypeScript, Cloudflare Workers, `agents` (McpAgent), `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`, `hono` (OAuth handler routing), `zod` (tool schemas), `wrangler` (deploy), `vitest` (unit tests). Design spec: [design.md](design.md).

## Global Constraints

- **Read-only:** tools issue only `GET` requests to FUB. No tool creates/updates/deletes anything. No write endpoints are called.
- **Scope from session only:** the closer's `fubUserId` comes exclusively from `this.props` (set at OAuth time from the verified Google email). It is NEVER taken from a tool argument or prompt text.
- **Defense in depth:** after every FUB read, results are re-filtered/validated to belong to `fubUserId` before returning.
- **FUB API:** base `https://api.followupboss.com/v1`; auth = HTTP Basic, username = API key, blank password (`Authorization: Basic btoa(key + ":")`); header `X-System: AHB Closer Reader`; header `Accept: application/json`.
- **Login restriction:** Google sign-in only succeeds for a verified (`email_verified === true`) address ending in `@acmehomebuyers.example` that maps to an existing FUB user; otherwise access is denied.
- **No secrets in the repo.** Secrets go in `.dev.vars` (gitignored) for local dev and `wrangler secret put` for prod: `FUB_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`. Vars in `wrangler.toml`: `ALLOWED_EMAIL_DOMAIN=acmehomebuyers.example`, `ACCOUNT_TZ=America/New_York`.
- **Project location:** all code under `mcp-connector-fub/` at the repo root (self-contained Node/TS project; does not touch `make/`, `shared/`, etc.).
- **Not-answered is best-effort:** classify a call as not-answered when `outcome` is a no-answer value OR `duration` is 0/null (FUB often stores `outcome = null` for API-logged calls). Label it approximate in output.

---

### Task 1: Scaffold the Worker project

**Files:**
- Create: `mcp-connector-fub/package.json`
- Create: `mcp-connector-fub/tsconfig.json`
- Create: `mcp-connector-fub/wrangler.toml`
- Create: `mcp-connector-fub/vitest.config.ts`
- Create: `mcp-connector-fub/.dev.vars.example`
- Create: `mcp-connector-fub/.gitignore`
- Create: `mcp-connector-fub/src/types.ts`

**Interfaces:**
- Produces: the FUB response types every later task imports from `src/types.ts`.

- [ ] **Step 1: Create the project directory and `package.json`**

```json
{
  "name": "mcp-connector-fub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@cloudflare/workers-oauth-provider": "^0.0.5",
    "@modelcontextprotocol/sdk": "^1.13.0",
    "agents": "^0.0.100",
    "hono": "^4.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd mcp-connector-fub && npm install`
Expected: `node_modules/` created; note the ACTUAL installed versions of `agents`, `@cloudflare/workers-oauth-provider`, and `@modelcontextprotocol/sdk` — the wiring tasks (10–12) must match the installed API surface. If an import path differs from this plan, prefer the installed package's types.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Create `wrangler.toml`** (KV id filled in Task 13; DO binding + migration for McpAgent)

```toml
name = "fub-connector"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ALLOWED_EMAIL_DOMAIN = "acmehomebuyers.example"
ACCOUNT_TZ = "America/New_York"

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "PLACEHOLDER_FILLED_IN_TASK_13"

[[durable_objects.bindings]]
name = "MCP_OBJECT"
class_name = "FubMcp"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["FubMcp"]
```

- [ ] **Step 5: Create `.gitignore`, `.dev.vars.example`, and `vitest.config.ts`**

`.gitignore`:
```
node_modules/
.dev.vars
.wrangler/
dist/
```

`.dev.vars.example`:
```
FUB_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
COOKIE_ENCRYPTION_KEY=
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 6: Create `src/types.ts`**

```ts
export interface FubCall {
  id: number;
  userId: number | null;
  userName: string | null;
  personId: number | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  isIncoming: boolean;
  duration: number | null;      // talk time, seconds
  ringDuration: number | null;
  outcome: string | null;
  startedAt: string | null;     // ISO
  created: string | null;       // ISO
  recordingUrl: string | null;
  note: string | null;          // Part C AI summary lives here
}

export interface FubPerson {
  id: number;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  stage: string | null;
  assignedUserId: number | null;
  assignedTo: string | null;
  emails?: { value: string }[];
  phones?: { value: string }[];
}

export interface FubUser {
  id: number;
  name: string | null;
  email: string | null;
  role?: string | null;
}

export interface Period {
  createdAfter: string;             // ISO Z
  createdBefore?: string;           // ISO Z
}
```

- [ ] **Step 7: Verify the project builds and tests run (empty)**

Run: `cd mcp-connector-fub && npx tsc --noEmit && npx vitest run`
Expected: `tsc` passes; vitest reports "no test files found" (exit 0 or a no-tests message). This confirms scaffolding is sound.

- [ ] **Step 8: Commit**

```bash
git add mcp-connector-fub/package.json mcp-connector-fub/tsconfig.json mcp-connector-fub/wrangler.toml mcp-connector-fub/vitest.config.ts mcp-connector-fub/.gitignore mcp-connector-fub/.dev.vars.example mcp-connector-fub/src/types.ts
git commit -m "MCP Connector for FUB: scaffold FUB read-only MCP connector (Cloudflare Worker)"
```

---

### Task 2: Period parser (`lib/period.ts`)

**Files:**
- Create: `mcp-connector-fub/src/lib/period.ts`
- Test: `mcp-connector-fub/test/period.test.ts`

**Interfaces:**
- Consumes: `Period` from `src/types.ts`.
- Produces: `parsePeriod(input: PeriodInput, now: Date, tz: string): Period` and the `PeriodInput` type — used by `fub/calls.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/period.test.ts
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
    const p = parsePeriod({ from: "2026-07-01T00:00:00-04:00", to: "2026-07-02T00:00:00-04:00" }, new Date(), TZ);
    expect(p.createdAfter).toBe("2026-07-01T04:00:00.000Z");
    expect(p.createdBefore).toBe("2026-07-02T04:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/period.test.ts`
Expected: FAIL — cannot find module `../src/lib/period`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/period.ts
import type { Period } from "../types";

export type PeriodInput =
  | "today" | "yesterday" | "this_week" | "last_7_days" | "last_30_days"
  | { from: string; to?: string };

const DAY = 86_400_000;

function localParts(now: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(parts.timeZoneName ?? "GMT+00:00");
  const sign = m && m[1] === "-" ? -1 : 1;
  const offsetMinutes = m ? sign * (+m[2] * 60 + +m[3]) : 0;
  return { y: +parts.year, m: +parts.month, d: +parts.day, offsetMinutes };
}

// UTC ms for local midnight of (y,m,d) at the given offset.
function localMidnightUtc(y: number, m: number, d: number, offsetMinutes: number): number {
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60_000;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function parsePeriod(input: PeriodInput, now: Date, tz: string): Period {
  if (typeof input === "object") {
    return {
      createdAfter: new Date(input.from).toISOString(),
      createdBefore: input.to ? new Date(input.to).toISOString() : undefined,
    };
  }
  const { y, m, d, offsetMinutes } = localParts(now, tz);
  const startOfToday = localMidnightUtc(y, m, d, offsetMinutes);
  switch (input) {
    case "today":
      return { createdAfter: iso(startOfToday) };
    case "yesterday":
      return { createdAfter: iso(startOfToday - DAY), createdBefore: iso(startOfToday) };
    case "this_week": {
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
      const sinceMon = (dow + 6) % 7;
      return { createdAfter: iso(startOfToday - sinceMon * DAY) };
    }
    case "last_7_days":
      return { createdAfter: iso(now.getTime() - 7 * DAY) };
    case "last_30_days":
      return { createdAfter: iso(now.getTime() - 30 * DAY) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/period.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/lib/period.ts mcp-connector-fub/test/period.test.ts
git commit -m "MCP Connector for FUB: period parser (tz-aware, UTC boundaries)"
```

---

### Task 3: Not-answered classifier (`lib/classify.ts`)

**Files:**
- Create: `mcp-connector-fub/src/lib/classify.ts`
- Test: `mcp-connector-fub/test/classify.test.ts`

**Interfaces:**
- Produces: `isNotAnswered(call: Pick<FubCall,"outcome"|"duration">): boolean` — used by `fub/calls.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/classify.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/classify.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/classify.ts
import type { FubCall } from "../types";

const NOT_ANSWERED = new Set(["No Answer", "Missed", "Voicemail", "Busy", "Bad Number", "Left Message"]);

export function isNotAnswered(call: Pick<FubCall, "outcome" | "duration">): boolean {
  if (call.outcome && NOT_ANSWERED.has(call.outcome)) return true;
  return !call.duration; // 0 or null → treat as not answered (best-effort)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/classify.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/lib/classify.ts mcp-connector-fub/test/classify.test.ts
git commit -m "MCP Connector for FUB: not-answered classifier (best-effort)"
```

---

### Task 4: Ownership guards (`lib/scope.ts`)

**Files:**
- Create: `mcp-connector-fub/src/lib/scope.ts`
- Test: `mcp-connector-fub/test/scope.test.ts`

**Interfaces:**
- Produces: `filterOwnedCalls(calls, fubUserId)`, `ownsLead(person, fubUserId)` — the security core, used by `fub/calls.ts` and `fub/people.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/scope.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/scope.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/scope.ts
import type { FubCall, FubPerson } from "../types";

export function filterOwnedCalls(calls: FubCall[], fubUserId: number): FubCall[] {
  return calls.filter((c) => c.userId === fubUserId);
}

export function ownsLead(person: Pick<FubPerson, "assignedUserId">, fubUserId: number): boolean {
  return person.assignedUserId === fubUserId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/scope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/lib/scope.ts mcp-connector-fub/test/scope.test.ts
git commit -m "MCP Connector for FUB: ownership guards (calls + leads scoped to fubUserId)"
```

---

### Task 5: Output formatting (`lib/format.ts`)

**Files:**
- Create: `mcp-connector-fub/src/lib/format.ts`
- Test: `mcp-connector-fub/test/format.test.ts`

**Interfaces:**
- Produces: `formatCall(c: FubCall)`, `fmtDuration(sec)`, `leadName(c)`, `formatSummary(agg: CallSummary)` — used by `mcp.ts`. (`CallSummary` is defined in Task 8; `formatSummary` is added in Task 8's file edit — see note.)

- [ ] **Step 1: Write the failing test**

```ts
// test/format.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/format.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/format.ts
import type { FubCall } from "../types";

export function fmtDuration(sec: number | null): string {
  const s = sec ?? 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function leadName(c: Pick<FubCall, "name" | "firstName" | "lastName">): string {
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown";
}

export function formatCall(c: FubCall) {
  return {
    lead: leadName(c),
    direction: c.isIncoming ? "incoming" : "outgoing",
    duration: fmtDuration(c.duration),
    outcome: c.outcome ?? "—",
    startedAt: c.startedAt,
    summary: c.note ?? null,          // Part C AI summary (score / topics / sentiment / text)
    recordingUrl: c.recordingUrl ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/lib/format.ts mcp-connector-fub/test/format.test.ts
git commit -m "MCP Connector for FUB: output formatting (call view + duration + lead name)"
```

---

### Task 6: FUB HTTP client (`fub/client.ts`)

**Files:**
- Create: `mcp-connector-fub/src/fub/client.ts`
- Test: `mcp-connector-fub/test/fub-client.test.ts`

**Interfaces:**
- Produces: `class FubClient` with `get<T>(path, params)` and `getAllPages<T>(path, params, collection, cap)`; `class FubError`. Consumes an injectable `fetchImpl` for testability. Used by all `fub/*` modules.

- [ ] **Step 1: Write the failing test**

```ts
// test/fub-client.test.ts
import { describe, it, expect } from "vitest";
import { FubClient, FubError } from "../src/fub/client";

function fakeFetch(pages: any[]) {
  let i = 0;
  return async (_url: string) => ({
    ok: true, status: 200,
    json: async () => pages[i++],
    text: async () => "",
  }) as any;
}

describe("FubClient", () => {
  it("sends Basic auth + X-System and returns json", async () => {
    let seen: any;
    const client = new FubClient({
      apiKey: "K", fetchImpl: async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: 1 }), text: async () => "" } as any; },
    });
    const out = await client.get("/calls", { userId: 86, skip: undefined });
    expect(out).toEqual({ ok: 1 });
    expect(seen.url).toContain("https://api.followupboss.com/v1/calls?userId=86");
    expect(seen.url).not.toContain("skip"); // undefined params dropped
    expect(seen.init.headers.Authorization).toBe("Basic " + btoa("K:"));
    expect(seen.init.headers["X-System"]).toBe("AHB Closer Reader");
  });

  it("getAllPages follows the _metadata.next cursor", async () => {
    const client = new FubClient({
      apiKey: "K",
      fetchImpl: fakeFetch([
        { calls: [{ id: 1 }, { id: 2 }], _metadata: { next: "CUR" } },
        { calls: [{ id: 3 }], _metadata: {} },
      ]),
    });
    const all = await client.getAllPages<any>("/calls", { userId: 86 }, "calls");
    expect(all.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("throws FubError on non-2xx", async () => {
    const client = new FubClient({ apiKey: "K", fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "nope" } as any) });
    await expect(client.get("/calls")).rejects.toBeInstanceOf(FubError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/fub-client.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/fub/client.ts
export interface FubClientOptions {
  apiKey: string;
  xSystem?: string;
  fetchImpl?: typeof fetch;
  base?: string;
}

export class FubError extends Error {
  constructor(public status: number, public body: string) {
    super(`FUB API ${status}`);
  }
}

export class FubClient {
  private auth: string;
  private xSystem: string;
  private f: typeof fetch;
  private base: string;

  constructor(o: FubClientOptions) {
    this.auth = "Basic " + btoa(o.apiKey + ":");
    this.xSystem = o.xSystem ?? "AHB Closer Reader";
    this.f = o.fetchImpl ?? fetch;
    this.base = o.base ?? "https://api.followupboss.com/v1";
  }

  async get<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await this.f(url.toString(), {
      headers: { Authorization: this.auth, "X-System": this.xSystem, Accept: "application/json" },
    });
    if (!res.ok) throw new FubError(res.status, await res.text());
    return (await res.json()) as T;
  }

  async getAllPages<T = any>(
    path: string,
    params: Record<string, string | number | undefined>,
    collection: string,
    cap = 500,
  ): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined;
    do {
      const page: any = await this.get(path, { ...params, limit: 100, ...(next ? { next } : {}) });
      out.push(...((page?.[collection] ?? []) as T[]));
      next = page?._metadata?.next;
    } while (next && out.length < cap);
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/fub-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/fub/client.ts mcp-connector-fub/test/fub-client.test.ts
git commit -m "MCP Connector for FUB: FUB HTTP client (Basic auth, cursor pagination)"
```

---

### Task 7: Email → FUB user resolver (`fub/users.ts`)

**Files:**
- Create: `mcp-connector-fub/src/fub/users.ts`
- Test: `mcp-connector-fub/test/fub-users.test.ts`

**Interfaces:**
- Consumes: `FubClient`, `FubUser`.
- Produces: `resolveFubUserByEmail(client, email): Promise<{id:number,name:string|null}|null>` — used by the Google OAuth handler (Task 11).

- [ ] **Step 1: Write the failing test**

```ts
// test/fub-users.test.ts
import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { resolveFubUserByEmail } from "../src/fub/users";

function clientReturning(users: any[]) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ users, _metadata: {} }), text: async () => "" } as any),
  });
}

describe("resolveFubUserByEmail", () => {
  const users = [
    { id: 86, name: "Ethan Serrano", email: "ethan@acmehomebuyers.example" },
    { id: 79, name: "Flora Stevens", email: "flora@acmehomebuyers.example" },
  ];
  it("matches case-insensitively", async () => {
    const u = await resolveFubUserByEmail(clientReturning(users), "Ethan@AcmeHomeBuyers.example");
    expect(u).toEqual({ id: 86, name: "Ethan Serrano" });
  });
  it("returns null for an unknown email", async () => {
    const u = await resolveFubUserByEmail(clientReturning(users), "stranger@acmehomebuyers.example");
    expect(u).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/fub-users.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/fub/users.ts
import { FubClient } from "./client";
import type { FubUser } from "../types";

export interface FubUserRef { id: number; name: string | null; }

export async function resolveFubUserByEmail(client: FubClient, email: string): Promise<FubUserRef | null> {
  const users = await client.getAllPages<FubUser>("/users", {}, "users");
  const lc = email.toLowerCase();
  const u = users.find((x) => (x.email ?? "").toLowerCase() === lc);
  return u ? { id: u.id, name: u.name } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/fub-users.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/fub/users.ts mcp-connector-fub/test/fub-users.test.ts
git commit -m "MCP Connector for FUB: email -> FUB userId resolver"
```

---

### Task 8: Scoped calls + summary (`fub/calls.ts`, adds `formatSummary` to `lib/format.ts`)

**Files:**
- Create: `mcp-connector-fub/src/fub/calls.ts`
- Modify: `mcp-connector-fub/src/lib/format.ts` (append `formatSummary`)
- Test: `mcp-connector-fub/test/fub-calls.test.ts`

**Interfaces:**
- Consumes: `FubClient`, `parsePeriod`/`PeriodInput`, `filterOwnedCalls`, `isNotAnswered`, `FubCall`.
- Produces: `listMyCalls(client, fubUserId, period, now, tz): Promise<FubCall[]>`, `summarize(calls): CallSummary`, `myCallSummary(client, fubUserId, period, now, tz): Promise<CallSummary>`, and the `CallSummary` interface. `formatSummary(agg: CallSummary): string` added to `format.ts`. Used by `mcp.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/fub-calls.test.ts
import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { listMyCalls, summarize, myCallSummary } from "../src/fub/calls";

function clientReturning(calls: any[], capture?: (url: string) => void) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async (url: string) => { capture?.(url); return { ok: true, status: 200, json: async () => ({ calls, _metadata: {} }), text: async () => "" } as any; },
  });
}

const NOW = new Date("2026-07-07T18:00:00Z");
const TZ = "America/New_York";

describe("listMyCalls", () => {
  it("queries with userId + createdAfter and re-filters to my calls", async () => {
    let seenUrl = "";
    const calls = [
      { id: 1, userId: 86, personId: 9, duration: 100, outcome: null, isIncoming: false, name: "A" },
      { id: 2, userId: 79, personId: 8, duration: 50, outcome: null, isIncoming: true, name: "B" }, // not mine
    ];
    const out = await listMyCalls(clientReturning(calls, (u) => (seenUrl = u)), 86, "today", NOW, TZ);
    expect(seenUrl).toContain("userId=86");
    expect(seenUrl).toContain("createdAfter=");
    expect(out.map((c) => c.id)).toEqual([1]); // #2 filtered out defensively
  });
});

describe("summarize", () => {
  it("counts totals, not-answered, talk time, distinct leads", () => {
    const s = summarize([
      { id: 1, userId: 86, personId: 9, duration: 100, outcome: null, isIncoming: false },
      { id: 2, userId: 86, personId: 9, duration: 0, outcome: "No Answer", isIncoming: false },
      { id: 3, userId: 86, personId: 7, duration: 60, outcome: null, isIncoming: true },
    ] as any);
    expect(s).toEqual({ total: 3, notAnswered: 1, answered: 2, incoming: 1, outgoing: 2, totalTalkSeconds: 160, distinctLeads: 2 });
  });
});

describe("myCallSummary", () => {
  it("summarizes only my calls", async () => {
    const calls = [
      { id: 1, userId: 86, personId: 9, duration: 100, outcome: null, isIncoming: false },
      { id: 2, userId: 79, personId: 8, duration: 50, outcome: null, isIncoming: true },
    ];
    const s = await myCallSummary(clientReturning(calls), 86, "today", NOW, TZ);
    expect(s.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/fub-calls.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `fub/calls.ts`**

```ts
// src/fub/calls.ts
import { FubClient } from "./client";
import type { FubCall } from "../types";
import { parsePeriod, type PeriodInput } from "../lib/period";
import { filterOwnedCalls } from "../lib/scope";
import { isNotAnswered } from "../lib/classify";

export interface CallSummary {
  total: number;
  notAnswered: number;
  answered: number;
  incoming: number;
  outgoing: number;
  totalTalkSeconds: number;
  distinctLeads: number;
}

export async function listMyCalls(
  client: FubClient, fubUserId: number, period: PeriodInput, now: Date, tz: string,
): Promise<FubCall[]> {
  const p = parsePeriod(period, now, tz);
  const calls = await client.getAllPages<FubCall>(
    "/calls",
    { userId: fubUserId, createdAfter: p.createdAfter, ...(p.createdBefore ? { createdBefore: p.createdBefore } : {}) },
    "calls",
  );
  return filterOwnedCalls(calls, fubUserId); // defense in depth
}

export function summarize(calls: FubCall[]): CallSummary {
  const leads = new Set<number>();
  let notAnswered = 0, incoming = 0, talk = 0;
  for (const c of calls) {
    if (c.personId) leads.add(c.personId);
    if (isNotAnswered(c)) notAnswered++;
    if (c.isIncoming) incoming++;
    talk += c.duration ?? 0;
  }
  return {
    total: calls.length,
    notAnswered,
    answered: calls.length - notAnswered,
    incoming,
    outgoing: calls.length - incoming,
    totalTalkSeconds: talk,
    distinctLeads: leads.size,
  };
}

export async function myCallSummary(
  client: FubClient, fubUserId: number, period: PeriodInput, now: Date, tz: string,
): Promise<CallSummary> {
  return summarize(await listMyCalls(client, fubUserId, period, now, tz));
}
```

- [ ] **Step 4: Append `formatSummary` to `src/lib/format.ts`**

```ts
// append to src/lib/format.ts
import type { CallSummary } from "../fub/calls";

export function formatSummary(s: CallSummary): string {
  const mins = Math.round(s.totalTalkSeconds / 60);
  return [
    `Total calls: ${s.total}`,
    `Answered: ${s.answered}  •  Not answered (approx): ${s.notAnswered}`,
    `Outgoing: ${s.outgoing}  •  Incoming: ${s.incoming}`,
    `Talk time: ${mins} min  •  Distinct leads: ${s.distinctLeads}`,
  ].join("\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mcp-connector-fub && npx vitest run test/fub-calls.test.ts`
Expected: PASS (3 tests). Also run the full suite: `npx vitest run` → all green.

- [ ] **Step 6: Commit**

```bash
git add mcp-connector-fub/src/fub/calls.ts mcp-connector-fub/src/lib/format.ts mcp-connector-fub/test/fub-calls.test.ts
git commit -m "MCP Connector for FUB: scoped calls list + summary aggregation"
```

---

### Task 9: Scoped leads + lead activity (`fub/people.ts`)

**Files:**
- Create: `mcp-connector-fub/src/fub/people.ts`
- Test: `mcp-connector-fub/test/fub-people.test.ts`

**Interfaces:**
- Consumes: `FubClient`, `ownsLead`, `FubPerson`, `FubCall`.
- Produces: `findMyLeads(client, fubUserId, query): Promise<FubPerson[]>`, `getLeadActivity(client, fubUserId, personId): Promise<{person, calls, notes, texts}>`. Used by `mcp.ts`.

- [ ] **Step 1: Verify FUB people-search params (quick live probe)**

Run (from repo root, key from `.env`):
```bash
python -c "import os,base64,json,urllib.request,pathlib;env=pathlib.Path('.env').read_text();k=[l.split('=',1)[1].strip() for l in env.splitlines() if l.startswith('FUB_API_KEY=')][0];a=base64.b64encode((k+':').encode()).decode();import urllib.request as u;req=u.Request('https://api.followupboss.com/v1/people?name=a&limit=1&fields=id,name,assignedUserId',headers={'Authorization':'Basic '+a,'X-System':'probe','Accept':'application/json'});print(u.urlopen(req).read()[:300])"
```
Expected: a 200 with a `people` array. Confirms `?name=<substring>` search + `assignedUserId` field. If `name` is rejected, use `?q=` instead; adjust the `params` key in Step 3 accordingly. Record which param worked.

- [ ] **Step 2: Write the failing test**

```ts
// test/fub-people.test.ts
import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { findMyLeads, getLeadActivity } from "../src/fub/people";

function client(routes: Record<string, any>) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async (url: string) => {
      const key = Object.keys(routes).find((k) => url.includes(k))!;
      return { ok: true, status: 200, json: async () => routes[key], text: async () => "" } as any;
    },
  });
}

describe("findMyLeads", () => {
  it("returns only leads assigned to me", async () => {
    const c = client({ "/people": { people: [
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
```

Note: the fake `fetchImpl` matches `/people/1` before `/people` because `getLeadActivity` calls `GET /people/1` (a longer path). Ensure route keys are distinct (`/people/1`, `/people/2`) so `findMyLeads`'s `/people` list call is only used in its own test.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/fub-people.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write the implementation** (use the search param confirmed in Step 1; `name` shown here)

```ts
// src/fub/people.ts
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

export async function getLeadActivity(client: FubClient, fubUserId: number, personId: number) {
  const person = await client.get<FubPerson>(`/people/${personId}`, { fields: PERSON_FIELDS });
  if (!ownsLead(person, fubUserId)) {
    throw new Error("This lead is not assigned to you.");
  }
  const calls = await client.getAllPages<FubCall>("/calls", { personId }, "calls", 100);
  const notes = await client.getAllPages("/notes", { personId }, "notes", 100);
  const texts = await client.getAllPages("/textMessages", { personId }, "textMessages", 100);
  return { person, calls, notes, texts };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/fub-people.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add mcp-connector-fub/src/fub/people.ts mcp-connector-fub/test/fub-people.test.ts
git commit -m "MCP Connector for FUB: scoped lead search + lead activity timeline"
```

---

### Task 10: MCP agent with the four read-only tools (`mcp.ts`)

**Files:**
- Create: `mcp-connector-fub/src/mcp.ts`

**Interfaces:**
- Consumes: `McpAgent` (`agents/mcp`), `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js`), `zod`, all `fub/*` + `lib/*` modules, and `this.props` (shape `{ fubUserId: number; email: string; name: string | null }`) set by the OAuth handler.
- Produces: `export class FubMcp extends McpAgent` (referenced by `wrangler.toml` DO binding and by `index.ts`).

- [ ] **Step 1: Write the agent** (verify method names against the installed `agents` version from Task 1; the shape below matches `agents/mcp` McpAgent + `this.server.tool(name, description, zodShape, handler)` and `this.props`)

```ts
// src/mcp.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FubClient } from "./fub/client";
import { listMyCalls, myCallSummary } from "./fub/calls";
import { findMyLeads, getLeadActivity } from "./fub/people";
import { formatCall, formatSummary, leadName } from "./lib/format";

export interface Props {
  fubUserId: number;
  email: string;
  name: string | null;
}

export interface Env {
  FUB_API_KEY: string;
  ACCOUNT_TZ: string;
}

const PERIOD = z
  .enum(["today", "yesterday", "this_week", "last_7_days", "last_30_days"])
  .default("today");

export class FubMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "AHB Follow Up Boss (my activity)", version: "1.0.0" });

  private client(): FubClient {
    return new FubClient({ apiKey: this.env.FUB_API_KEY, xSystem: "AHB Closer Reader" });
  }
  private me(): number {
    return this.props.fubUserId; // identity ONLY from the verified session
  }

  async init() {
    const tz = this.env.ACCOUNT_TZ || "America/New_York";

    this.server.tool(
      "list_my_calls",
      "List YOUR Follow Up Boss calls for a period, with the AI summary note (score/topics/sentiment) for each. Only your own calls are ever returned.",
      { period: PERIOD },
      async ({ period }) => {
        const calls = await listMyCalls(this.client(), this.me(), period, new Date(), tz);
        const view = calls.map(formatCall);
        return { content: [{ type: "text", text: JSON.stringify({ period, count: view.length, calls: view }, null, 2) }] };
      },
    );

    this.server.tool(
      "my_call_summary",
      "Exact numeric summary of YOUR calls for a period: total, answered, not-answered (approx), talk time, distinct leads.",
      { period: PERIOD },
      async ({ period }) => {
        const s = await myCallSummary(this.client(), this.me(), period, new Date(), tz);
        return { content: [{ type: "text", text: formatSummary(s) }] };
      },
    );

    this.server.tool(
      "find_my_leads",
      "Search YOUR assigned Follow Up Boss leads by name. Only leads assigned to you are returned.",
      { query: z.string().min(1) },
      async ({ query }) => {
        const leads = await findMyLeads(this.client(), this.me(), query);
        const view = leads.map((p) => ({ id: p.id, name: leadName(p), stage: p.stage }));
        return { content: [{ type: "text", text: JSON.stringify({ count: view.length, leads: view }, null, 2) }] };
      },
    );

    this.server.tool(
      "get_lead_activity",
      "Get the full timeline (calls, notes, texts) for one of YOUR leads. Refused if the lead is not assigned to you.",
      { personId: z.number().int().positive() },
      async ({ personId }) => {
        try {
          const a = await getLeadActivity(this.client(), this.me(), personId);
          return { content: [{ type: "text", text: JSON.stringify({
            lead: { id: a.person.id, name: leadName(a.person), stage: a.person.stage },
            calls: a.calls.map(formatCall),
            notes: a.notes,
            texts: a.texts,
          }, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e?.message ?? "Not allowed." }], isError: true };
        }
      },
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd mcp-connector-fub && npx tsc --noEmit`
Expected: passes. If `McpAgent`'s generic signature differs in the installed version, adjust `extends McpAgent<Env, unknown, Props>` to match its actual type parameters (the goal: `this.env` typed as `Env`, `this.props` typed as `Props`).

- [ ] **Step 3: Commit**

```bash
git add mcp-connector-fub/src/mcp.ts
git commit -m "MCP Connector for FUB: McpAgent with 4 read-only tools scoped by session fubUserId"
```

---

### Task 11: Google OAuth handler (`google-handler.ts`)

**Files:**
- Create: `mcp-connector-fub/src/google-handler.ts`

**Interfaces:**
- Consumes: `hono`, `@cloudflare/workers-oauth-provider` provider methods on `env.OAUTH_PROVIDER` (`parseAuthRequest`, `completeAuthorization`), `resolveFubUserByEmail`, `FubClient`, env secrets/vars.
- Produces: `export default app` (a Hono fetch handler) used as `defaultHandler` in `index.ts`. Sets `props: Props` via `completeAuthorization`.

- [ ] **Step 1: Write the handler** (standard Google OAuth 2.0 web flow; domain-restricted)

```ts
// src/google-handler.ts
import { Hono } from "hono";
import { FubClient } from "./fub/client";
import { resolveFubUserByEmail } from "./fub/users";

interface HandlerEnv {
  OAUTH_PROVIDER: any; // provided by @cloudflare/workers-oauth-provider
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  FUB_API_KEY: string;
  ALLOWED_EMAIL_DOMAIN: string;
}

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

const app = new Hono<{ Bindings: HandlerEnv }>();

// Step A: Claude hits /authorize → we stash the MCP auth request and redirect to Google.
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const state = crypto.randomUUID();
  await c.env.OAUTH_KV.put(`login:${state}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });

  const redirectUri = new URL("/callback", c.req.url).toString();
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("hd", c.env.ALLOWED_EMAIL_DOMAIN); // hint: restrict to the workspace
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

// Step B: Google redirects back → exchange code, verify identity, map to FUB user, complete.
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code/state", 400);

  const stored = await c.env.OAUTH_KV.get(`login:${state}`);
  if (!stored) return c.text("Login session expired, please reconnect.", 400);
  const oauthReqInfo = JSON.parse(stored);
  await c.env.OAUTH_KV.delete(`login:${state}`);

  const redirectUri = new URL("/callback", c.req.url).toString();
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.text("Google token exchange failed.", 401);
  const { access_token } = await tokenRes.json<{ access_token: string }>();

  const infoRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!infoRes.ok) return c.text("Could not read Google profile.", 401);
  const info = await infoRes.json<{ email: string; email_verified: boolean; name?: string }>();

  const domain = "@" + c.env.ALLOWED_EMAIL_DOMAIN.toLowerCase();
  if (!info.email_verified || !info.email.toLowerCase().endsWith(domain)) {
    return c.text(`Access limited to ${c.env.ALLOWED_EMAIL_DOMAIN} accounts.`, 403);
  }

  const client = new FubClient({ apiKey: c.env.FUB_API_KEY, xSystem: "AHB Closer Reader" });
  const fubUser = await resolveFubUserByEmail(client, info.email);
  if (!fubUser) {
    return c.text(`${info.email} is not a Follow Up Boss user. Ask your admin to add you.`, 403);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: info.email,
    scope: oauthReqInfo.scope,
    metadata: { label: fubUser.name ?? info.email },
    props: { fubUserId: fubUser.id, email: info.email, name: fubUser.name },
  });
  return c.redirect(redirectTo);
});

export default app;
```

- [ ] **Step 2: Typecheck**

Run: `cd mcp-connector-fub && npx tsc --noEmit`
Expected: passes. If `completeAuthorization` / `parseAuthRequest` are exposed differently by the installed provider version (e.g. imported helpers vs. `env.OAUTH_PROVIDER` methods), adapt to the installed API — the required behavior is unchanged: stash request → Google → verify domain + FUB user → complete with `props`.

- [ ] **Step 3: Commit**

```bash
git add mcp-connector-fub/src/google-handler.ts
git commit -m "MCP Connector for FUB: Google OAuth handler (domain-restricted, email->FUB user)"
```

---

### Task 12: Wire the OAuth provider (`index.ts`)

**Files:**
- Create: `mcp-connector-fub/src/index.ts`

**Interfaces:**
- Consumes: `OAuthProvider` (`@cloudflare/workers-oauth-provider`), `FubMcp` (Task 10), `googleHandler` (Task 11).
- Produces: the Worker default export; also re-exports `FubMcp` as a Durable Object class.

- [ ] **Step 1: Write the entry**

```ts
// src/index.ts
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { FubMcp } from "./mcp";
import googleHandler from "./google-handler";

export { FubMcp }; // Durable Object class (bound as MCP_OBJECT in wrangler.toml)

export default new OAuthProvider({
  apiRoute: ["/mcp", "/sse"],
  apiHandler: {
    "/mcp": FubMcp.serve("/mcp"),
    "/sse": FubMcp.serveSSE("/sse"),
  } as any,
  defaultHandler: googleHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
```

- [ ] **Step 2: Typecheck + dry-run build**

Run: `cd mcp-connector-fub && npx tsc --noEmit && npx wrangler deploy --dry-run --outdir dist`
Expected: `tsc` passes; wrangler bundles without error (it may warn about the placeholder KV id — that is fixed in Task 13). If `apiHandler` expects a single handler rather than a route map in the installed version, use `apiHandler: FubMcp.serve("/mcp")` and set `apiRoute: "/mcp"` only (drop `/sse`). Confirm against the installed provider's types.

- [ ] **Step 3: Commit**

```bash
git add mcp-connector-fub/src/index.ts
git commit -m "MCP Connector for FUB: wire OAuthProvider (Google default handler + MCP api handler)"
```

---

### Task 13: Provision Cloudflare resources + secrets

**Files:**
- Modify: `mcp-connector-fub/wrangler.toml` (real KV id)

**Interfaces:** none (infrastructure). Uses `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` already in the repo `.env`.

- [ ] **Step 1: Export Cloudflare credentials for wrangler**

Run (from `mcp-connector-fub/`, values from repo `.env`):
```bash
export CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
export CLOUDFLARE_API_TOKEN=<CLOUDFLARE_API_TOKEN from .env>
```

- [ ] **Step 2: Create the OAuth KV namespace**

Run: `npx wrangler kv namespace create OAUTH_KV`
Expected: prints an `id`. Copy it into `wrangler.toml` `[[kv_namespaces]] id = "..."`, replacing the placeholder.

- [ ] **Step 3: Set the secrets** (FUB read key already exists in repo `.env`; generate a random cookie key)

Run:
```bash
echo "<FUB_API_KEY from .env>" | npx wrangler secret put FUB_API_KEY
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
```
(Defer `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to Task 14 once the OAuth client exists.)

- [ ] **Step 4: Commit the wrangler.toml KV id**

```bash
git add mcp-connector-fub/wrangler.toml
git commit -m "MCP Connector for FUB: bind OAuth KV namespace"
```

---

### Task 14: Deploy, wire Google, and end-to-end verify (needs Marco / Google Workspace)

**Files:** none (deploy + external config).

**Interfaces:** none. This is the gated final step (needs the Google OAuth client and the Claude Team Owner).

- [ ] **Step 1: First deploy (to get the Worker URL)**

Run: `cd mcp-connector-fub && npx wrangler deploy`
Expected: prints the deployed URL, e.g. `https://fub-connector.<subdomain>.workers.dev`. Record it.

- [ ] **Step 2: Create the Google OAuth client** (Alexey or Marco / Workspace admin)

In https://console.cloud.google.com → APIs & Services:
- OAuth consent screen → **User type: Internal** → app name "AHB Follow Up Boss".
- Credentials → Create Credentials → **OAuth client ID** → **Web application**.
- Authorized redirect URI: `https://fub-connector.<subdomain>.workers.dev/callback` (from Step 1).
- Copy the Client ID + Client Secret.

- [ ] **Step 3: Set the Google secrets and redeploy**

Run:
```bash
echo "<CLIENT_ID>" | npx wrangler secret put GOOGLE_CLIENT_ID
echo "<CLIENT_SECRET>" | npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

- [ ] **Step 4: Local MCP inspector smoke test**

Run: `npx @modelcontextprotocol/inspector`
Point it at `https://fub-connector.<subdomain>.workers.dev/mcp`, complete the Google login as `alexey@acmehomebuyers.example`, and call `my_call_summary` (period `today`).
Expected: an OAuth flow that only accepts the company Google account; the tool returns Alexey's real numbers. Calling `get_lead_activity` with a `personId` NOT assigned to Alexey returns "not assigned to you".

- [ ] **Step 5: Add the connector to Claude Team (Owner = Marco)**

Marco: claude.ai → Settings → Organization → Connectors → Add custom connector → URL `https://fub-connector.<subdomain>.workers.dev/mcp`.
Then each closer: Settings → Connectors → Connect → sign in with their Google.

- [ ] **Step 6: Two-closer isolation check**

Have two different closers connect and each ask "list my calls today". Confirm each sees only their own calls, and neither can retrieve the other's (e.g., ask for a lead you know belongs to the other closer → refused). Confirm it works on mobile.

- [ ] **Step 7: Final commit / docs**

```bash
git add -A mcp-connector-fub
git commit -m "MCP Connector for FUB: deployed FUB read-only connector; live-verified per-closer scoping"
```
Update `docs/go-live.md` and the project memory with the live Worker URL and go-live status.

---

## Addendum A (2026-07-07): EOD report — notes + texts

Flora's real workflow is an **End-of-Day report** covering her **calls + notes + texts**.
These tasks add scoped notes, a per-lead text gatherer, and an `eod_report` tool. They
slot in after Task 9 and extend Task 10's agent. Two tools are added → **6 tools total**.

### Task A1: FUB note & text types

**Files:**
- Modify: `mcp-connector-fub/src/types.ts` (append two interfaces)

**Interfaces:**
- Produces: `FubNote`, `FubText` — used by `fub/notes.ts` and `fub/eod.ts`.

- [ ] **Step 1: Append to `src/types.ts`**

```ts
export interface FubNote {
  id: number;
  personId: number | null;
  createdById: number | null;
  createdBy: string | null;
  created: string | null;   // ISO
  subject: string | null;
  body: string | null;
  type: string | null;
}

export interface FubText {
  id: number;
  personId: number | null;
  userId: number | null;     // the agent — used to attribute the text to a closer
  userName: string | null;
  created: string | null;    // ISO, e.g. "2026-07-06T18:19:11Z"
  isIncoming: boolean;
  message: string | null;
  fromNumber: string | null;
  toNumber: string | null;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd mcp-connector-fub && npx tsc --noEmit`
```bash
git add mcp-connector-fub/src/types.ts
git commit -m "MCP Connector for FUB: add FubNote + FubText types"
```

---

### Task A2: Scoped notes (`fub/notes.ts`)

**Files:**
- Create: `mcp-connector-fub/src/fub/notes.ts`
- Test: `mcp-connector-fub/test/fub-notes.test.ts`

**Interfaces:**
- Consumes: `FubClient`, `parsePeriod`/`PeriodInput`, `FubNote`.
- Produces: `listMyNotes(client, fubUserId, period, now, tz): Promise<FubNote[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/fub-notes.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/fub-notes.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/fub/notes.ts
import { FubClient } from "./client";
import type { FubNote } from "../types";
import { parsePeriod, type PeriodInput } from "../lib/period";

export async function listMyNotes(
  client: FubClient, fubUserId: number, period: PeriodInput, now: Date, tz: string,
): Promise<FubNote[]> {
  const p = parsePeriod(period, now, tz);
  const notes = await client.getAllPages<FubNote>(
    "/notes",
    { createdById: fubUserId, createdAfter: p.createdAfter, ...(p.createdBefore ? { createdBefore: p.createdBefore } : {}) },
    "notes",
  );
  return notes.filter((n) => n.createdById === fubUserId); // defense in depth
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/fub-notes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/fub/notes.ts mcp-connector-fub/test/fub-notes.test.ts
git commit -m "MCP Connector for FUB: scoped notes (by author + date)"
```

---

### Task A3: EOD aggregation (`fub/eod.ts`)

**Files:**
- Create: `mcp-connector-fub/src/fub/eod.ts`
- Test: `mcp-connector-fub/test/fub-eod.test.ts`

**Interfaces:**
- Consumes: `FubClient`, `listMyCalls`, `listMyNotes`, `parsePeriod`, `FubText`.
- Produces: `myTextsForPeriod(client, fubUserId, personIds, fromIso, toIso?): Promise<FubText[]>`, `myEodReport(client, fubUserId, period, now, tz): Promise<{calls, notes, texts, touchedLeadCount, textsCapped}>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/fub-eod.test.ts
import { describe, it, expect } from "vitest";
import { FubClient } from "../src/fub/client";
import { myEodReport, myTextsForPeriod } from "../src/fub/eod";

const NOW = new Date("2026-07-07T18:00:00Z");
const TZ = "America/New_York";

// routes matched by substring; person-scoped text pages keyed by personId
function client(routes: Record<string, any>) {
  return new FubClient({
    apiKey: "K",
    fetchImpl: async (url: string) => {
      const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
      return { ok: true, status: 200, json: async () => routes[key ?? ""] ?? { _metadata: {} }, text: async () => "" } as any;
    },
  });
}

describe("myTextsForPeriod", () => {
  it("keeps only my texts inside the window", async () => {
    const c = client({ "personId=9": { textMessages: [
      { id: 1, personId: 9, userId: 79, created: "2026-07-07T14:00:00Z", message: "mine-in" },
      { id: 2, personId: 9, userId: 85, created: "2026-07-07T14:05:00Z", message: "other-agent" },
      { id: 3, personId: 9, userId: 79, created: "2026-07-01T09:00:00Z", message: "mine-too-old" },
    ], _metadata: {} } });
    const out = await myTextsForPeriod(c, 79, [9], "2026-07-07T04:00:00.000Z");
    expect(out.map((t) => t.id)).toEqual([1]);
  });
});

describe("myEodReport", () => {
  it("bundles my calls + notes + texts on touched leads", async () => {
    const c = client({
      "/calls": { calls: [{ id: 11, userId: 79, personId: 9, duration: 100, outcome: null, isIncoming: false }], _metadata: {} },
      "/notes": { notes: [{ id: 21, personId: 12, createdById: 79, created: "2026-07-07T14:00:00Z", body: "n" }], _metadata: {} },
      "personId=9": { textMessages: [{ id: 31, personId: 9, userId: 79, created: "2026-07-07T15:00:00Z", message: "x" }], _metadata: {} },
      "personId=12": { textMessages: [{ id: 32, personId: 12, userId: 79, created: "2026-07-07T16:00:00Z", message: "y" }], _metadata: {} },
    });
    const r = await myEodReport(c, 79, "today", NOW, TZ);
    expect(r.calls.map((c2) => c2.id)).toEqual([11]);
    expect(r.notes.map((n) => n.id)).toEqual([21]);
    expect(r.texts.map((t) => t.id).sort()).toEqual([31, 32]); // texts from both touched leads (9 from call, 12 from note)
    expect(r.touchedLeadCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-connector-fub && npx vitest run test/fub-eod.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/fub/eod.ts
import { FubClient } from "./client";
import { listMyCalls } from "./calls";
import { listMyNotes } from "./notes";
import type { FubText } from "../types";
import { parsePeriod, type PeriodInput } from "../lib/period";

const MAX_TOUCHED = 50;

export async function myTextsForPeriod(
  client: FubClient, fubUserId: number, personIds: number[], fromIso: string, toIso?: string,
): Promise<FubText[]> {
  const fromMs = Date.parse(fromIso);
  const toMs = toIso ? Date.parse(toIso) : Infinity;
  const out: FubText[] = [];
  for (const pid of personIds.slice(0, MAX_TOUCHED)) {
    let texts: FubText[] = [];
    try {
      texts = await client.getAllPages<FubText>("/textMessages", { personId: pid }, "textMessages", 100);
    } catch {
      texts = []; // a person with no texts / a transient error shouldn't sink the report
    }
    for (const t of texts) {
      if (t.userId !== fubUserId) continue; // only MY texts, never another agent's
      const ts = t.created ? Date.parse(t.created) : NaN;
      if (Number.isNaN(ts) || ts < fromMs || ts >= toMs) continue;
      out.push(t);
    }
  }
  return out;
}

export async function myEodReport(
  client: FubClient, fubUserId: number, period: PeriodInput, now: Date, tz: string,
) {
  const p = parsePeriod(period, now, tz);
  const calls = await listMyCalls(client, fubUserId, period, now, tz);
  const notes = await listMyNotes(client, fubUserId, period, now, tz);
  const touched = Array.from(
    new Set([
      ...calls.map((c) => c.personId),
      ...notes.map((n) => n.personId),
    ].filter((x): x is number => typeof x === "number")),
  );
  const texts = await myTextsForPeriod(client, fubUserId, touched, p.createdAfter, p.createdBefore);
  return { calls, notes, texts, touchedLeadCount: touched.length, textsCapped: touched.length > MAX_TOUCHED };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-connector-fub && npx vitest run test/fub-eod.test.ts`
Expected: PASS (2 tests). Then run the whole suite: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add mcp-connector-fub/src/fub/eod.ts mcp-connector-fub/test/fub-eod.test.ts
git commit -m "MCP Connector for FUB: EOD aggregation (my calls + notes + texts on touched leads)"
```

---

### Task A4: Add `list_my_notes` + `eod_report` tools to the agent

**Files:**
- Modify: `mcp-connector-fub/src/mcp.ts`

**Interfaces:**
- Consumes: `listMyNotes` (Task A2), `myEodReport` (Task A3), `formatCall`, `leadName`.

- [ ] **Step 1: Add imports** to `src/mcp.ts`

```ts
import { listMyNotes } from "./fub/notes";
import { myEodReport } from "./fub/eod";
```

- [ ] **Step 2: Register the two tools inside `init()`** (after the existing four)

```ts
    this.server.tool(
      "list_my_notes",
      "List the notes YOU authored on leads for a period. Only your own notes are returned.",
      { period: PERIOD },
      async ({ period }) => {
        const notes = await listMyNotes(this.client(), this.me(), period, new Date(), tz);
        const view = notes.map((n) => ({ leadId: n.personId, created: n.created, subject: n.subject, body: n.body }));
        return { content: [{ type: "text", text: JSON.stringify({ period, count: view.length, notes: view }, null, 2) }] };
      },
    );

    this.server.tool(
      "eod_report",
      "Your End-of-Day bundle for a period: YOUR calls (with AI summaries), the notes YOU wrote, and YOUR texts on the leads you contacted. All scoped to you. Paste your report template and Claude summarizes the key comms/updates from this data.",
      { period: PERIOD },
      async ({ period }) => {
        const r = await myEodReport(this.client(), this.me(), period, new Date(), tz);
        const payload = {
          period,
          calls: r.calls.map(formatCall),
          notes: r.notes.map((n) => ({ leadId: n.personId, created: n.created, subject: n.subject, body: n.body })),
          texts: r.texts.map((t) => ({ leadId: t.personId, created: t.created, direction: t.isIncoming ? "incoming" : "outgoing", message: t.message })),
          note: r.textsCapped ? `Texts cover the first 50 of ${r.touchedLeadCount} leads you touched.` : undefined,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      },
    );
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd mcp-connector-fub && npx tsc --noEmit`
```bash
git add mcp-connector-fub/src/mcp.ts
git commit -m "MCP Connector for FUB: add list_my_notes + eod_report tools"
```

---

## Notes for the implementer

- **Security invariant to never break:** `fubUserId` is read only from `this.props`. If you ever find yourself adding a `userId` (or `closerId`, `email`, etc.) parameter to a tool's input schema, stop — that reintroduces the ability for a closer to query someone else.
- **Version drift:** Tasks 10–12 depend on the exact APIs of `agents`, `@modelcontextprotocol/sdk`, and `@cloudflare/workers-oauth-provider`. Task 1 Step 2 says to note installed versions; if a signature differs from this plan, match the installed package (the behavior each task must produce is spelled out in its Interfaces block).
- **Texts limitation (from the spec):** there is intentionally no "all my texts" tool — texts appear only inside `get_lead_activity` for an owned lead.
- **Out of scope (v1):** deals/tag reporting, any write capability.
