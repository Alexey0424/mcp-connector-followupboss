import type { FubCall, FubPerson } from "../types";

export function filterOwnedCalls(calls: FubCall[], fubUserId: number): FubCall[] {
  return calls.filter((c) => c.userId === fubUserId);
}

export function ownsLead(person: Pick<FubPerson, "assignedUserId">, fubUserId: number): boolean {
  return person.assignedUserId === fubUserId;
}
