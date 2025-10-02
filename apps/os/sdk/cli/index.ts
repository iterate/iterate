import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createCli } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { proxify } from "trpc-cli/dist/proxify";
import { createTRPCClient, httpLink } from "@trpc/client";
import { testingRouter } from "../../backend/trpc/routers/testing.ts";
import { appRouter } from "../../backend/trpc/root.ts";
import { authClient } from "../../app/lib/auth-client.ts";
import { testAdminUser } from "../../backend/auth/test-admin.ts";
import { t } from "./config.ts";
import { estate } from "./commands/checkout-estate.ts";
import { gh } from "./commands/gh-commands.ts";
import { db } from "./cli-db.ts";

const router = t.router({
  estate,
  gh,
  testing: testingRouter,
  trpc: proxify(appRouter, async () => {
    const baseURL = process.env.VITE_PUBLIC_URL!;
    // for now, you can only sign in as the test admin user - somewhat limited in usefulness
    // todo: use impersonation
    // todo: maybe add an `auth` thing to trpc-cli - pass it a better-auth client and it could do a full CLI-based auth flow
    // how it would work:
    // - start a (trpc-based) server
    // - do some redirect magic
    // - send the creds to the CLI from the browser window?
    let cookie = "";
    await authClient.signIn.email(
      { email: testAdminUser.email!, password: testAdminUser.password! },
      { onResponse: ({ response: r }) => void (cookie = r.headers.getSetCookie().join("; ")) },
    );
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
