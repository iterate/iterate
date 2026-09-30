// e2e/support/deployed-target.ts — a deployed worker under test, addressed by URL: the credentials
// come out of the deployment's own two secrets (`APP_CONFIG`, `APP_CONFIG_SECRETS__KEY` — in the
// environment under `doppler run`), its project routing and MCP origin out of the worker itself
// (`session.info()`). The vitest suite's global-setup and the root Playwright suite's
// specs/setup.ts both read it, each for its own workers.

import { newWebSocketRpcSession } from "capnweb";
import { WebSocket as UndiciWebSocket } from "undici";
import { z } from "zod";
import { parseAppConfig } from "../../src/app-config.ts";

export async function deployedTarget(workerBaseUrl: string): Promise<{
  adminBearer: string;
  loginPassword: string;
  /** JSON, as the specs and support/project-host.ts read it. */
  ingressRouting: string;
  mcpBaseUrl: string;
}> {
  // The deployment's own object (src/app-config.ts), parsed the way the worker parses it — the two
  // secrets scripts/os/deploy.ts ships, nothing else in the environment.
  if (!process.env.APP_CONFIG)
    throw new Error(
      "APP_CONFIG unset — the deployed worker's own config, which holds the admin bearer (and the sign-in password, where it sets one) the e2e sessions use (run under `doppler run --project os --config <preview|prd>`)",
    );
  const appConfig = parseAppConfig({
    APP_CONFIG: process.env.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: process.env.APP_CONFIG_SECRETS__KEY,
  });
  const adminBearer = appConfig.secrets.adminBearer.exposeSecret();
  if (!adminBearer)
    throw new Error(
      "The deployment's APP_CONFIG sets no secrets.adminBearer — every e2e session authenticates with it",
    );
  // prd sets no password (nobody signs in there without proving their email); a test that signs in
  // with it fails at that sign-in (support/client.ts `loginPassword`), the operator-only ones run
  const loginPassword = appConfig.login.password.exposeSecret();
  // How the worker routes projects and where it serves MCP, as it tells every app that starts up
  // (src/session.ts `info()`), asked as the operator. Untyped: session.ts's types pull in the
  // Workers types, which the specs' tsconfig doesn't have.
  const api = new URL("/api", workerBaseUrl);
  api.protocol = api.protocol === "https:" ? "wss:" : "ws:";
  // undici's WebSocket is the WHATWG one capnweb takes; only its declared types differ from the DOM's
  using transport: any = newWebSocketRpcSession(new UndiciWebSocket(api) as unknown as WebSocket);
  const info = DeploymentInfo.parse(
    await transport.authenticate({ type: "admin-secret", secret: adminBearer }).info(),
  );
  return {
    adminBearer,
    loginPassword,
    ingressRouting: JSON.stringify(info.ingressRouting),
    // MCP on an origin of its own (prd's mcp.iterate.com) is the deployment's; on the platform
    // origin it is `/mcp` on the worker's own.
    mcpBaseUrl: info.mcpOrigin || new URL("/mcp", workerBaseUrl).href,
  };
}

/** The two fields of `session.info()` a run needs: iterate/project-ingress `IngressRouting`, and the
 *  MCP origin when MCP has one of its own. */
const DeploymentInfo = z.looseObject({
  ingressRouting: z.union([
    z.object({ type: z.literal("subdomains"), hostname: z.string() }),
    z.object({ type: z.literal("paths") }),
    z.null(),
  ]),
  mcpOrigin: z.string().optional(),
});
