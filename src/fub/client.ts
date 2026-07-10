// Minimal fetch shape we depend on — decouples the client (and its tests) from the
// exact global `fetch` signature (Cloudflare's workers-types widens `input` to
// URL | RequestInfo, which a plain `(url: string) => ...` test double can't satisfy).
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<any> }>;

export interface FubClientOptions {
  apiKey: string;
  xSystem?: string;
  fetchImpl?: FetchLike;
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
  private f: FetchLike;
  private base: string;

  constructor(o: FubClientOptions) {
    this.auth = "Basic " + btoa(o.apiKey + ":");
    this.xSystem = o.xSystem ?? "AHB Closer Reader";
    // call bare `fetch(...)` inside a wrapper — a detached/bound native fetch throws
    // "Illegal invocation" on Workers; a free-identifier call keeps the correct global `this`.
    this.f = o.fetchImpl ?? (((url: string, init?: unknown) => fetch(url as any, init as any)) as unknown as FetchLike);
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
