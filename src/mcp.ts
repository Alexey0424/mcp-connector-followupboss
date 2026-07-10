import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FubClient } from "./fub/client";
import { listMyCalls, myCallSummary } from "./fub/calls";
import { listMyNotes } from "./fub/notes";
import { myEodReport } from "./fub/eod";
import { findMyLeads, getLeadActivity, findLeadsAdmin, getLeadTimeline } from "./fub/people";
import { formatCall, formatSummary, leadName } from "./lib/format";
import { listTeam } from "./fub/users";
import {
  teamActivity, teamPipeline, listActiveStages, resolveCloser, EXCLUDED_PIPELINE_STAGES,
} from "./fub/team";
import { MANAGER_TOOL_NAMES } from "./tools-manifest";

export interface Props {
  fubUserId: number;
  email: string;
  name: string | null;
  isManager: boolean;
  [key: string]: unknown;
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
  private managerClient(): FubClient {
    return new FubClient({ apiKey: this.env.FUB_API_KEY, xSystem: "AHB Manager Reader" });
  }
  private me(): number {
    // identity ONLY from the verified session — never a tool arg, never a default
    const id = this.props?.fubUserId;
    if (typeof id !== "number") throw new Error("Not authenticated — reconnect the connector.");
    return id;
  }
  private tz(): string {
    return this.env.ACCOUNT_TZ || "America/New_York";
  }

  async init() {
    this.server.tool(
      "list_my_calls",
      "List YOUR Follow Up Boss calls for a period, each with the AI-summary note (score/topics/sentiment). Only your own calls are ever returned.",
      { period: PERIOD },
      async ({ period }) => {
        const calls = await listMyCalls(this.client(), this.me(), period, new Date(), this.tz());
        const view = calls.map(formatCall);
        return { content: [{ type: "text", text: JSON.stringify({ period, count: view.length, calls: view }, null, 2) }] };
      },
    );

    this.server.tool(
      "my_call_summary",
      "Exact numeric summary of YOUR calls for a period: total, answered, not-answered (approx), talk time, distinct leads.",
      { period: PERIOD },
      async ({ period }) => {
        const s = await myCallSummary(this.client(), this.me(), period, new Date(), this.tz());
        return { content: [{ type: "text", text: formatSummary(s) }] };
      },
    );

    this.server.tool(
      "list_my_notes",
      "List the notes YOU authored on leads for a period. Only your own notes are returned.",
      { period: PERIOD },
      async ({ period }) => {
        const notes = await listMyNotes(this.client(), this.me(), period, new Date(), this.tz());
        const view = notes.map((n) => ({ leadId: n.personId, created: n.created, subject: n.subject, body: n.body }));
        return { content: [{ type: "text", text: JSON.stringify({ period, count: view.length, notes: view }, null, 2) }] };
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

    this.server.tool(
      "eod_report",
      "Your End-of-Day bundle for a period: YOUR calls (with AI summaries), the notes YOU wrote, and YOUR texts on the leads you contacted. All scoped to you. Paste your report template and Claude summarizes the key comms/updates from this data.",
      { period: PERIOD },
      async ({ period }) => {
        const r = await myEodReport(this.client(), this.me(), period, new Date(), this.tz());
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

    if (this.props?.isManager) this.registerManagerTools();
  }

  // Team-wide read-only tools. Registered ONLY for managers (props.isManager), so a
  // closer's session never exposes them. Registered set === MANAGER_TOOL_NAMES.
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
      "Live pipeline: lead counts by stage x closer (active seller-deal stages only; excludes archived/closed/list/nurture buckets). Manager only. May take a few seconds.",
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
}
