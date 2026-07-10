# Design — AHB FUB read-only MCP connector for closers ("MCP Connector for FUB")

**Date:** 2026-07-07
**Status:** Approved design, pending written-spec review
**Author:** Alexey

## 1. Goal

Give each AHB closer a way to ask Claude (claude.ai, web + mobile, Claude Team plan)
about **their own** Follow Up Boss activity — primarily their call logs — and get a
real, data-backed summary. Example the closer wants to be able to ask:

> "How did I do today? / Show me my calls this week and summarize them."

Claude answers using a **remote MCP connector** that reads FUB live and returns only
that closer's data.

## 2. Requirements

**Functional**
- A closer can ask for their calls over a period (today / yesterday / this week /
  last N days / explicit range) and get: lead name, direction, duration, outcome,
  and the JustCall AI summary (score / topics / sentiment / summary) that Part C
  already writes into the FUB call note.
- A closer can get a quick numeric summary (total calls, not-answered, total talk
  time, distinct leads contacted) for a period.
- A closer can look up their own leads by name/phone and see a lead's timeline
  (calls, notes, texts) — only for leads assigned to them.

**Non-functional (hard constraints from the client)**
- **Per-closer login.** Each closer authenticates as themselves; the connector
  identifies who they are.
- **Enforced server-side scoping.** A closer can only ever retrieve their own data.
  Scoping is enforced on the server from the verified identity — never from prompt
  text or tool arguments. A closer cannot ask to see another closer's data.
- **Works immediately on connect.** After the closer connects the connector and signs
  in with Google, it just works — no pasting API keys, no per-closer configuration.
- **Read-only.** The connector performs only `GET`s against FUB. No create/update/
  delete tools exist. The FUB API key is a server secret and is never exposed to the
  closer.

## 3. Definitions ("what is *mine*")

Chosen defaults (adjustable later):
- **My calls** = calls where the closer is the agent on the call
  (`call.userId == me`). This is the literal "call logs in my name" and structurally
  guarantees a closer never sees another agent's call.
- **My leads** = people assigned to the closer in FUB (`person.assignedUserId == me`).
- **My notes** = notes the closer authored (`note.createdById == me`).
- **My texts** = text messages the closer sent/received (`text.userId == me`). FUB has
  no per-user text feed, so these are gathered per lead (see §8).
- **My lead's timeline** = for a person assigned to me, that person's calls + notes +
  texts.

**Primary real workflow (confirmed by closer Flora, 2026-07-07):** an **End-of-Day (EOD)
report** — "export my calls, texts, and the notes I left on leads," then have Claude
reproduce her report format with a summary of the most important comms/events/updates.
She assumes it is her data only; the connector enforces that by construction.

Deals / tag-based performance reporting is **out of scope for v1** — the client's tag
example was hypothetical, and the real ask is call-log-by-closer + summary. (FUB does
have a real Deals pipeline with "Closed 20XX" stages attributed via `deal.users`; a
future version could add a deals report if the client defines it — see §11.)

## 4. Architecture

A single **Cloudflare Worker** (call it `fub-connector`, internally "MCP Connector for FUB")
exposing a remote MCP server over HTTP, fronted by OAuth.

```
Closer in claude.ai
   │  (Claude Team; Owner adds the connector once; each closer clicks "Connect")
   ▼
OAuth (our Worker is the OAuth server Claude talks to)
   │  delegates identity to  ──►  "Sign in with Google"  (restricted to @acmehomebuyers.example)
   │  on success: verified email  ──►  FUB userId  (email→id map from GET /v1/users, cached)
   │  stores { fubUserId, email, name } in the session/token props
   ▼
MCP server (read-only tools)
   │  every tool reads fubUserId from the SESSION (never from tool args)
   │  and injects it into the FUB query, then re-validates results
   ▼
Follow Up Boss API  (Basic auth with the server's FUB key — a Worker secret)
   GET https://api.followupboss.com/v1/...
```

**Stack**
- Cloudflare Workers (free tier is sufficient) + `workers-oauth-provider` (Anthropic's
  reference pattern for remote-MCP OAuth) + the MCP server SDK (`@modelcontextprotocol`
  / `McpAgent`).
- **KV namespace(s):** OAuth token/grant storage + a cached `email → {fubUserId, name,
  role}` map (rebuilt from `GET /v1/users`, refreshable).
- **Secrets (wrangler):** `FUB_API_KEY` (server read key), `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, OAuth cookie/signing secret.

## 5. Identity & auth flow

1. Owner of the Claude Team adds the connector URL once (org-level custom connector).
2. A closer clicks **Connect** → Claude runs OAuth against our Worker.
3. Our Worker redirects to **Google Sign-In**, restricted to the `acmehomebuyers.example`
   workspace (`hd` param + server-side verification of the verified email domain;
   ideally the Google OAuth consent screen is **Internal** so only Workspace users can
   even authenticate).
4. Google returns the closer's verified email. Worker looks up the email in the FUB
   user map (`GET /v1/users`). If not found → **deny** with a clear message ("your
   email isn't a Follow Up Boss user; ask the admin").
5. Worker issues its own MCP access token whose props carry `fubUserId` (+ name/email).
   From then on, every tool call for that session is bound to that `fubUserId`.

**No API keys are ever handled by the closer.** The single server-side FUB key
(already available: `FUB_API_KEY` reads full-account data, which we then filter down
per closer) lives only as a Worker secret.

## 6. Tools (all read-only, all auto-scoped to the session's `fubUserId`)

### `list_my_calls`
- **Input:** `period` (`today` | `yesterday` | `this_week` | `last_7_days` |
  `last_30_days` | custom `{from,to}` ISO), optional `limit`.
- **Behavior:** `GET /v1/calls?userId={me}&createdAfter={period.from}` (paginate via
  the `next`/`sinceId` cursor until the period is covered). Re-validate every returned
  call has `userId == me` before returning (defense in depth).
- **Output per call:** lead name (`name`/`firstName`/`lastName`), direction
  (`isIncoming`), `duration`, `outcome`, `startedAt`, and the **`note`** field
  (contains Part C's AI summary: Call Score / Topics / Customer Sentiment /
  transcription link / summary). `recordingUrl` is included but note FUB privacy-masks
  it on API read for the JustCall integration (playback works only in the FUB UI).

### `my_call_summary`
- **Input:** `period` (as above).
- **Behavior:** page through the same scoped call set and aggregate **server-side**
  (so numbers are exact, not model-counted): total calls, **not-answered**
  (best-effort: `outcome == "No Answer"` OR `duration == 0`), total talk time (sum of
  `duration`), distinct leads contacted (`personId`), incoming vs outgoing split.
- **Output:** the numeric summary object; Claude turns it into the narrative report.

### `find_my_leads`
- **Input:** `query` (name / phone / email).
- **Behavior:** search `GET /v1/people`, then filter to `assignedUserId == me`.
- **Output:** id, name, stage, primary contact — only leads assigned to the closer.

### `list_my_notes`
- **Input:** `period` (as above).
- **Behavior:** `GET /v1/notes?createdById={me}&createdAfter={period.from}` (paginate).
  Re-validate `createdById == me`.
- **Output per note:** lead name, `created`, `subject`, `body` — only notes the closer
  authored. (Verified: `createdById` genuinely filters — 60,952 total notes vs. 28 for
  `createdById=79`.)

### `get_lead_activity`
- **Input:** `personId`.
- **Behavior:** verify the person's `assignedUserId == me` (else refuse); then return
  that person's calls, notes (`GET /v1/notes?personId=`), and texts
  (`GET /v1/textMessages?personId=`, filtered to `userId == me`).
- **Output:** the lead's timeline.

### `eod_report`  ← Flora's primary workflow
- **Input:** `period` (defaults to `today`).
- **Behavior:** the End-of-Day bundle, all scoped to the closer:
  1. **My calls** — `list_my_calls` for the period (with AI-summary notes).
  2. **My notes** — `list_my_notes` for the period.
  3. **My texts** — gather the set of `personId`s the closer *touched* this period
     (union of the personIds from steps 1 and 2), then `GET /v1/textMessages?personId=`
     for each and keep only messages with `userId == me` in the period. Cap at the first
     ~50 touched leads; if capped, say so.
- **Output:** a structured bundle `{ calls, notes, texts }` (all hers). Claude then
  reproduces the closer's own report format with a summary of the key comms/updates.
- **Documented edge case:** a lead the closer *only texted* this period (no call, no
  note) is not in the touched-set, so those texts are missed by the bundle. The closer
  can still retrieve them via `get_lead_activity` for that specific lead. (FUB has no
  per-user text feed — see §8.)

## 7. Data mapping (verified live against FUB, 2026-07-07)

- Base: `https://api.followupboss.com/v1`; auth = HTTP Basic, username = API key,
  blank password (same as `shared/fub-scripts/inspect_fub.py`). Set an `X-System`
  header, e.g. `AHB Closer Reader`.
- `/v1/calls` returns: `userId`, `userName`, `personId`, `name`/`firstName`/
  `lastName`, `isIncoming`, `duration`, `ringDuration`, `outcome`, `startedAt`,
  `recordingUrl`, `note`, … — **verified**.
- `/v1/calls` accepts `?userId=` and `?createdAfter=<ISO>` (also `createdBefore`);
  pagination is cursor-based (`_metadata.next` / `nextLink`) — **verified**.
- `/v1/people` returns `assignedUserId` (present on 100% of sampled people),
  `assignedTo`, `stage`, `tags` — **verified**.
- `/v1/notes` returns `createdById`, `createdBy`, `created`, `personId`, `subject`,
  `body`, `type`; accepts `?createdById=` (genuinely filters) + `?createdAfter=` —
  **verified**.
- `/v1/textMessages` returns `userId`, `userName`, `createdById`, `created`, `personId`,
  `isIncoming`, `message`, `fromNumber`, `toNumber`, `deliveryStatus` — so a text **is
  attributable to a specific agent** via `userId`. **But** the collection GET requires a
  `personId`/`threadId`/`phone`/… scope (verified error) — there is **no** `?userId=`
  global text feed.
- Email → userId map (from `/v1/users`, verified): e.g. alexey=78, ethan=86,
  flora=79, art=80, hank=82, ada=77, eli=81, pam=83, marco=1.

## 8. Texts — capability & limitation

Texts **carry the agent** (`userId`/`userName`), so we can always show *only the
closer's own* texts and never another agent's. The limitation is purely about
enumeration: `GET /v1/textMessages` requires a per-person/thread/phone scope, so there
is no way to ask FUB for "all of a closer's texts." We therefore reconstruct the
closer's texts **per lead**:
- `get_lead_activity` — texts on one owned lead, filtered to `userId == me`.
- `eod_report` — texts on the leads the closer *touched* this period (personIds derived
  from their own calls + notes), filtered to `userId == me`.

Edge case (documented, accepted for v1): a lead the closer *only texted* — with no call
and no note that period — is not in the touched-set and its texts won't appear in the
EOD bundle; they remain reachable via `get_lead_activity` for that lead.

## 9. Error handling

- Email not a FUB user → deny at connect with a clear message.
- Non-`acmehomebuyers.example` email → deny.
- FUB API error / rate limit → return a friendly tool error; never leak the key or
  another user's data.
- Empty results → "no calls found for you in that period."
- `recordingUrl` masked → surface it but note playback is UI-only.
- **Not-answered is best-effort** — Part-C-logged calls often have `outcome == null`;
  the count uses `outcome == "No Answer"` OR `duration == 0` and is labeled approximate.

## 10. Testing

- **Unit:** tool args cannot override `fubUserId` (scoping comes only from session);
  a call whose `userId != me` is filtered out even if FUB returns it; `get_lead_activity`
  refuses a `personId` not assigned to me.
- **Integration (against FUB with a test key):** as alexey (78), `list_my_calls`
  returns only alexey's calls; fetching a call belonging to another agent by id is
  refused; `find_my_leads` returns only assigned leads.
- **Manual E2E:** connect in claude.ai as two different closers; confirm each sees only
  their own calls; confirm mobile works; confirm a non-FUB Google user is denied.

## 11. Out of scope for v1 / future

- **Deals / performance-by-deal reporting.** FUB has a real Deals pipeline (pipeline
  "Deals (Active)", stages incl. "Closed 2026/2025/2024", 737 deals, attributed via
  `deal.users`). A future `my_deals_summary` could count deals where the closer is in
  `deal.users` and the stage is a "Closed" stage within a period — **once the client
  defines "deal done"**.
- Global text listing per agent (FUB API limitation, §8).
- Any write capability (creating notes/tasks) — deliberately excluded.

## 12. Alternatives considered (and why rejected)

- **Shared FUB key, no login** — simplest, but every closer would see everyone's data.
  Rejected: violates the enforced per-closer requirement.
- **FollowUpAce hosted MCP** (~$55/user/mo) — works, but expensive for read-only call
  lookups, and a third party holds the FUB key. Rejected on cost/control.
- **Local MCP server (Claude Desktop + Node per machine)** — free, but per-machine
  install and no mobile. Rejected: closers need it on their phones, zero install.
- **Per-closer connector URL with an embedded token** (no OAuth) — lighter to build,
  but doesn't fit the Team "Owner adds one org connector" model cleanly, and a leaked
  URL = impersonation. Rejected in favor of Google OAuth with domain restriction.

## 13. Setup / handoff (who provides what)

**Client (Alexey/Marco) provides — needed to deploy & test end-to-end:**
1. **Cloudflare account** (free) + an API token (Workers edit) + Account ID → so the
   Worker can be deployed via wrangler.
2. **Google Cloud OAuth client** (Web application) for "Sign in with Google": Client ID
   + Client Secret; consent screen set to **Internal** (Workspace) so only
   `@acmehomebuyers.example` can sign in. Redirect URI is filled in once the Worker URL
   exists.
3. Confirmation of **who is the Claude Team Owner** (adds the connector URL at the end)
   and that the Team plan allows custom connectors.

**Already available (no action needed):**
- FUB server read key (`FUB_API_KEY` in `.env` — reads full account, filtered per
  closer by the connector).
- FUB user email→id map (derivable from `GET /v1/users`).

**The build can start now** with the FUB key on hand; Cloudflare + Google
credentials are needed only at the deploy/test step.
