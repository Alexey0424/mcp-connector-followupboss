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
