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
