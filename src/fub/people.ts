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
