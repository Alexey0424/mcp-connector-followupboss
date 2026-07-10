import { Hono } from "hono";
import { FubClient } from "./fub/client";
import { resolveFubUserByEmail } from "./fub/users";
import { parseManagerEmails, isManagerEmail } from "./lib/managers";

interface HandlerEnv {
  OAUTH_PROVIDER: any; // injected by @cloudflare/workers-oauth-provider
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  FUB_API_KEY: string;
  ALLOWED_EMAIL_DOMAIN: string;
  MANAGER_EMAILS: string;
}

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

const app = new Hono<{ Bindings: HandlerEnv }>();

// Step A: Claude hits /authorize → stash the MCP auth request and redirect to Google.
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const state = crypto.randomUUID();
  await c.env.OAUTH_KV.put(`login:${state}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });

  const redirectUri = new URL("/callback", c.req.url).toString();
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("hd", c.env.ALLOWED_EMAIL_DOMAIN); // hint: restrict to the workspace
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

// Step B: Google redirects back → exchange code, verify identity, map to FUB user, complete.
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code/state", 400);

  const stored = await c.env.OAUTH_KV.get(`login:${state}`);
  if (!stored) return c.text("Login session expired, please reconnect.", 400);
  const oauthReqInfo = JSON.parse(stored);
  await c.env.OAUTH_KV.delete(`login:${state}`);

  const redirectUri = new URL("/callback", c.req.url).toString();
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("google token exchange failed", tokenRes.status, await tokenRes.text());
    return c.text("Sign-in failed at Google token exchange. Please try again.", 401);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const infoRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!infoRes.ok) {
    console.error("google userinfo failed", infoRes.status, await infoRes.text());
    return c.text("Could not read your Google profile. Please try again.", 401);
  }
  const info = (await infoRes.json()) as { email: string; email_verified: boolean; name?: string };

  const domain = "@" + c.env.ALLOWED_EMAIL_DOMAIN.toLowerCase();
  if (!info.email_verified || !info.email.toLowerCase().endsWith(domain)) {
    return c.text(`Access is limited to ${c.env.ALLOWED_EMAIL_DOMAIN} accounts.`, 403);
  }

  try {
    const client = new FubClient({ apiKey: c.env.FUB_API_KEY, xSystem: "AHB Closer Reader" });
    const fubUser = await resolveFubUserByEmail(client, info.email);
    if (!fubUser) {
      return c.text(`${info.email} is not a Follow Up Boss user. Ask your admin to add you.`, 403);
    }

    const isManager = isManagerEmail(info.email, parseManagerEmails(c.env.MANAGER_EMAILS));
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: info.email,
      scope: oauthReqInfo.scope ?? [],
      metadata: { label: fubUser.name ?? info.email },
      props: { fubUserId: fubUser.id, email: info.email, name: fubUser.name, isManager },
    });
    return c.redirect(redirectTo);
  } catch (err: any) {
    console.error("callback post-auth error", err?.stack || err?.message);
    return c.text("Sign-in failed while connecting to Follow Up Boss. Please try again.", 500);
  }
});

export default app;
