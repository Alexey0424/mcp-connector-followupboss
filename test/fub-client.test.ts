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
      apiKey: "K",
      fetchImpl: async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: 1 }), text: async () => "" } as any; },
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
