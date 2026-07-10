import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { FubMcp } from "./mcp";
import googleHandler from "./google-handler";

export { FubMcp }; // Durable Object class (bound as MCP_OBJECT in wrangler.toml)

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: FubMcp.serve("/mcp") as any,
  defaultHandler: googleHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
