import { FubClient } from "./client";
import type { FubUser } from "../types";

export interface FubUserRef { id: number; name: string | null; }

export async function resolveFubUserByEmail(client: FubClient, email: string): Promise<FubUserRef | null> {
  const users = await client.getAllPages<FubUser>("/users", {}, "users");
  const lc = email.toLowerCase();
  const u = users.find((x) => (x.email ?? "").toLowerCase() === lc);
  return u ? { id: u.id, name: u.name } : null;
}

export async function listTeam(client: FubClient): Promise<FubUser[]> {
  return client.getAllPages<FubUser>("/users", { fields: "id,name,email,role" }, "users", 200);
}
