import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createCli } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { proxify } from "trpc-cli/dist/proxify";
import { createTRPCClient, httpLink } from "@trpc/client";
import { fetch } from "../../backend/fetch.ts";
import { testingRouter } from "../../backend/trpc/routers/testing.ts";
import { appRouter } from "../../backend/trpc/root.ts";
import { t } from "./config.ts";
import { estate } from "./commands/checkout-estate.ts";
import { gh } from "./commands/gh-commands.ts";
import { dev } from "./commands/dev.ts";
import { db } from "./cli-db.ts";
import { adminRouter } from "./commands/admin.ts";

// Normalize forwarded args when invoked via pnpm recursion.
// pnpm adds a standalone "--" before forwarded args, which stops option parsing.
// Remove it so flags like "-c" are recognized by the CLI.
const dashdashIndex = process.argv.indexOf("--");
if (dashdashIndex !== -1) {
  process.argv.splice(dashdashIndex, 1);
}

const router = t.router({
  estate,
  gh,
  dev,
  admin: adminRouter,
  testing: testingRouter,
  trpc: proxify(appRouter, async () => {
    const baseURL = process.env.VITE_PUBLIC_URL!;
    const res = await fetch(`${baseURL}/api/auth/service-auth/create-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceAuthToken: process.env.SERVICE_AUTH_TOKEN }),
    });
    const cookie = res.headers.get("set-cookie");
    if (!res.ok || !cookie) throw new Error(`service auth ${res.status}: ${await res.text()}`);

    // for now, you can only sign in as the superadmin user - somewhat limited in usefulness
    // todo: use impersonation
    // todo: maybe add an `auth` thing to trpc-cli - pass it a better-auth client and it could do a full CLI-based auth flow
    // how it would work:
    // - start a (trpc-based) server
    // - do some redirect magic
    // - send the creds to the CLI from the browser window?
    return createTRPCClient<typeof appRouter>({
      links: [httpLink({ url: `${baseURL}/api/trpc`, headers: { cookie } })],
    });
  }),
});

if (process.argv.length === 2) {
  console.error("No command provided, assuming you want to run `iterate` sdk cli");
  // Run the cli.js script from packages/sdk
  const cliPath = resolve(import.meta.dirname, "../../../../packages/sdk/cli.js");
  const result = spawnSync("node", [cliPath], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  process.exit(result.status ?? 0);
}

const cli = createCli({ router, context: { db } });
cli.run({ prompts });
