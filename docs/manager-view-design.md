# Design — Manager team-performance view (MCP Connector for FUB, phase 2)

**Date:** 2026-07-09
**Status:** Approved (brainstorming) — ready for implementation plan
**Builds on:** `mcp-connector-fub/` (the read-only closer MCP connector, live since 2026-07-09)
**Prior design:** [design.md](design.md)

## 1. Problem / goal

The MCP Connector for FUB connector currently gives each **closer** a read-only, self-scoped view of
their own FUB activity (their calls, notes, leads). Marco now wants a **team-manager
view**: the ability to ask **free-form, natural questions about the whole team** and get
answers pulled live from the entire Follow Up Boss account — read-only.

Two people get this manager capability, with **identical privileges**:
- **Marco** — `marco@acmehomebuyers.example`
- **Alexey** — `alexey@acmehomebuyers.example`

Everyone else (closers) is completely unchanged: they still see only their own data.

The manager experience is **free-form** (Marco just asks questions in Claude); Claude
composes a small set of team-wide read tools to answer. A **PDF + HTML cheat-sheet**
documents what he can ask *and the limitations*.

## 2. Scope

**v1 (this build):**
- **A** — team activity leaderboard (per-closer calls / answered / talk time / notes)
- **B** — pipeline by stage × closer
- **D** — drill into any one closer (their full activity)
- Account-wide lead search + single-lead timeline (supports free-form questions)
- Manager role gating (Marco + Alexey only)
- PDF + HTML cheat-sheet including a Limitations section

**Fast-follow (NOT this build):**
- **C** — deals / revenue / conversion rates. Deferred because it runs on FUB's separate
  **Deals** pipeline (`/deals`, attributed via `deal.users`), which we have inspected but
  never built against, and "revenue"/"conversion" need Marco to define exactly which stages
  count as closed, which dollar field, and over what period. Building it before those
  definitions are pinned down would be guesswork.

**Explicitly out of scope:** any write to FUB; changing anything for closers; a second
connector/URL; changes to the Google OAuth app.

## 3. Chosen approach

**Approach 1 — extend the existing connector with a role-gated manager toolset.**
One Cloudflare Worker, one connector URL, one Google login. Rejected alternatives: a
separate manager Worker/URL (double infra + maintenance for two users), and exposing team
tools to everyone with a runtime role filter (weaker isolation than the current model).

The manager capability is determined **server-side from the Google-verified email**, never
from a prompt or tool argument — the same rule the connector already uses for closer
identity. Manager tools are **only registered when `isManager` is true**, so in a closer's
session those tools *do not exist* and cannot be invoked even via prompt injection.

## 4. Architecture / changes

### 4.1 Role gating (auth)
- **New config:** `MANAGER_EMAILS` in `wrangler.toml [vars]` — comma-separated, lower-cased:
  `"marco@acmehomebuyers.example,alexey@acmehomebuyers.example"`. (Emails are not secret; a `[vars]`
  entry is fine and is editable by redeploy.)
- **`src/lib/managers.ts`** (new): parse `MANAGER_EMAILS` → set; `isManagerEmail(email)`
  does a case-insensitive membership check.
- **`src/google-handler.ts`** (edit): after `resolveFubUserByEmail`, compute
  `isManager = isManagerEmail(info.email)` and include it in `completeAuthorization` props:
  `props: { fubUserId, email, name, isManager }`.
- **`src/mcp.ts`** (edit): add `isManager: boolean` to `Props` and `MANAGER_EMAILS` to `Env`.
  In `init()`, register the 6 existing personal tools **always**; then
  `if (this.props.isManager) this.registerManagerTools()`.
- Managers therefore keep the personal "how did *I* do" tools **and** get the team tools.

### 4.2 Manager tools (all read-only)
Registered only for managers. All reuse the existing FUB client / period parser / formatters.

| Tool | Input | Returns | FUB source |
|---|---|---|---|
| `list_team` | — | Roster: `{id, name, email, role}` | `GET /users` |
| `team_activity` | `period` | Per-closer: calls (total/answered/no-answer/talk time/distinct leads) + notes authored; sorted; plus a no-activity list | `GET /calls?createdAfter…` + `GET /notes?createdAfter…`, grouped in code by `userId`/`createdById` |
| `closer_activity` | `closer` (name or id), `period` | One closer's full activity (calls w/ AI notes, notes, texts on touched leads) — `eod_report` for a chosen user | reuse `eod.ts`/`calls.ts`/`notes.ts` with a resolved `userId` |
| `team_pipeline` | — | Leads by **stage × closer** counts + unassigned bucket; **active stages only** by default | `GET /people?fields=id,stage,assignedUserId` (bounded sweep), grouped in code |
| `find_leads` | `query` | Account-wide search: `{id, name, stage, assignedUserId, assignedName}` | `GET /people` search, no owner filter |
| `lead_activity` | `personId` | Any lead's full timeline (calls, notes, texts) | reuse `people.ts` `getLeadActivity` without the ownership check |

- **`src/fub/team.ts`** (new): `teamActivity(period)` and `teamPipeline()` aggregation.
- **`src/fub/people.ts`** / **`eod.ts`** (edit): factor the ownership check so managers can
  call the same logic for an arbitrary `userId` / without the "owns lead" gate. Keep the
  closer-facing functions behaving exactly as today (defense-in-depth filter stays for them).
- Manager FUB reads set X-System header **`AHB Manager Reader`** (distinct from the closer
  reads' `AHB Closer Reader`) so they're identifiable in FUB's logs.

### 4.3 Data flow
Claude (Marco/Alexey session) → MCP tool call → Worker (Durable Object holds `props`,
`isManager=true`) → FUB REST GET(s) with the server key → group/format in code → text/JSON
back to Claude, which composes the natural-language answer.

## 5. Performance / large-account handling

FUB has no aggregate-count endpoint, so team tools read records and group them in code.
- **`team_activity`** is date-bounded (one paginated `/calls` pass + one `/notes` pass for
  the period), so it stays small for today/this-week; last-30-days is the heaviest but
  bounded.
- **`team_pipeline`** is the heavy one (paging `/people`). Mitigations:
  1. **Active stages only** by default (exclude Trash/Closed/archived) — what a manager
     actually wants, and far fewer records.
  2. **Short in-session cache** (~5 min) so repeated asks don't re-sweep.
  3. **Minimal fields** (`id, stage, assignedUserId`).
  4. **Safety page cap**; if hit, the tool **states that counts are partial** rather than
     silently truncating (repo "no silent caps" rule).
- The actual account people-count will be confirmed against FUB during the build to tune the
  cap/strategy.

## 6. Error handling & security

- Manager tools are **absent** from non-manager sessions (uninvokable); each also re-checks
  `isManager` defensively and throws if somehow reached.
- `closer_activity` with an ambiguous name returns the **candidate list and asks** — never
  guesses whose data to show. Unknown closer / bad `personId` → clear error, no crash.
- FUB/API failures surface as a tool error with the reason (existing pattern).
- **Strictly read-only**: GET only; FUB key stays a server secret; allowlist is server config.
- The isolation guarantee for closers is unchanged and re-verified in tests.

## 7. Testing

- **Unit (vitest, alongside existing 27):** allowlist membership (in/out, case-insensitive);
  tool-gating (manager tools present iff `isManager`); `team_activity` grouping;
  `team_pipeline` grouping + active-stage filter; closer-name resolution
  (exact/fuzzy/ambiguous/unknown).
- **Live E2E:** connect as Alexey (manager) → "team activity today", "everything Ethan did
  today", "pipeline by stage"; reconcile numbers against FUB; confirm a non-manager session
  exposes **no** manager tools.

## 8. Deliverable — cheat-sheet (PDF + HTML)

For Marco, styled like `docs/final-report-*`. A table of **Category → example question →
what it pulls**, across Team activity, Individual closer, Pipeline, and Leads — plus a
**Limitations** section documenting:
- No team-wide **texts-sent count** (FUB has no account-wide by-agent text feed; texts appear
  per-lead in `closer_activity`/`lead_activity`).
- **Deals / revenue / conversion** are a coming-soon fast-follow, not yet available.
- `team_pipeline` shows **active stages only** by default.
- Pipeline queries on a large account may take a few seconds; counts are a live snapshot.
- Call `outcome` is best-effort for FUB records logged by our own automations (answered vs
  not-answered is approximate).
- Everything is **read-only** — the connector can report, never change FUB.

## 9. Deployment

- **No Google changes** (same OAuth client, same `openid email profile` scopes).
- Cloudflare: add `MANAGER_EMAILS` to `[vars]` and redeploy the Worker (existing tooling).
- After deploy: Marco & Alexey already have the connector added/connected; a **reconnect may
  be needed once** so the new `isManager` prop is written into their session, and so Claude
  picks up the new manager tools.

## 10. Open items to confirm during build
- FUB account people-count (tunes the pipeline sweep cap/strategy).
- Exact list of "active" stages to include in `team_pipeline` (from `GET /stages`).
- Whether reconnect is required to refresh the tool list / props (verify live).
