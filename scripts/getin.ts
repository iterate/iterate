// `pnpm getin` — one command to a browser signed in to this worktree's local platform, inside a
// project that exists. It restores #1760's `pnpm getin` (removed with the legacy platform in #2837)
// on today's one-click sign-in link (apps/os/src/test-link.ts, #2966), which local dev enables:
//
//   pnpm getin                    # signed in as test@preview.iterate.test, in project `test`
//   pnpm -s getin --print         # only the URL, on stdout — for Playwright and agents
//   pnpm getin -e ada@preview.iterate.test -p demo
//
// 1. the worktree's dev server: `pnpm dev start --detach` (apps/os/scripts/dev.ts), which returns at
//    once when it is already up, then its record, apps/os/.wrangler/dev-server.json;
// 2. the person and their project: `projects.create` as them through the local operator bearer —
//    the same idempotent call as preview.ts `previewSignIn` and e2e's `registerProject`, so a second
//    run reuses both;
// 3. a test link signed with the local `secrets.key`, for this server's origin, landing in the local
//    Dash's project page when a Dash wired to this server is up (and pre-approving it: no Allow
//    page), else on the issuer's `/login` ("Signed in as");
// 4. open it, or print it.
//
// Local dev only: the credentials are local dev's (apps/os/scripts/generate-wrangler-config.ts
// `viteWranglerConfig`); a deployment answers the link's `aud` with a 403, prd with a 404.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { newWebSocketRpcSession } from "capnweb";
import { createCli } from "trpc-cli";
import { mintTestLink, TEST_LINK_EMAIL_DOMAIN, TEST_LINK_PATH } from "../apps/os/src/test-link.ts";

/** Open a browser signed in to local OS, in a project — starting the dev server and creating the project when missing */
export default async function getin(
  options: {
    /** who to sign in as — an address under preview.iterate.test
     * @alias e
     */
    email?: string;
    /** the project to create if missing and land in (default: the email's local part — the Dash's Allow page is skipped only for that one)
     * @alias p
     */
    project?: string;
    /** print the sign-in URL on stdout instead of opening a browser */
    print?: boolean;
    /** the local Dash to land in (default http://localhost:5173, used when it is up and wired to this server) */
    dash?: string;
  } = {},
) {
  const email = options.email || `test@${TEST_LINK_EMAIL_DOMAIN}`;
  const [local, domain] = email.split("@");
  if (!local || domain !== TEST_LINK_EMAIL_DOMAIN)
    throw new Error(`--email must be an address under ${TEST_LINK_EMAIL_DOMAIN}, not ${email}`);
  const project = options.project || local;
  const os = new URL("../apps/os/", import.meta.url);

  // Everything but the URL goes to stderr, so `pnpm -s getin --print` prints the URL alone.
  const started = spawnSync("pnpm", ["dev", "start", "--detach"], {
    cwd: os,
    stdio: ["ignore", process.stderr, process.stderr],
  });
  if (started.status !== 0) throw new Error("`pnpm dev start --detach` failed (see above)");
  const server = JSON.parse(readFileSync(new URL(".wrangler/dev-server.json", os), "utf8")) as {
    port: number;
    baseUrl: string;
  };

  await createProject(server.baseUrl, { email, project });
  console.error(`project: ${project}, owned by ${email}`);

  const dash = await localDash(options.dash || "http://localhost:5173", server.baseUrl);
  const token = await mintTestLink({
    // local dev's `secrets.key` (generate-wrangler-config.ts `viteWranglerConfig`)
    key: "dev-secrets-key",
    audience: server.baseUrl,
    email,
    next: dash ? `${dash}/projects/${project}` : `${server.baseUrl}/login`,
    clients: dash ? [dash] : [],
    expiresAt: Date.now() + 24 * 3600_000,
  });
  const url = `${server.baseUrl}${TEST_LINK_PATH}?${new URLSearchParams({ t: token })}`;
  if (!dash)
    console.error(
      `no local Dash on this server — landing on ${server.baseUrl}/login. For the Dash: ITERATE_ORIGIN=${server.baseUrl} in apps/dash/.dev.vars, then \`pnpm --dir apps/dash dev\``,
    );
  if (dash && project !== local)
    console.error(
      `the Dash may ask to Allow once: a link skips that page only when project ${local} exists (apps/os/src/consent.ts)`,
    );
  if (options.print) return console.log(url);
  console.error(`opening ${dash ? `${dash}/projects/${project}` : server.baseUrl} as ${email}`);
  spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "inherit" });
}

/** `projects.create` as `email`, found or created, over the local operator bearer — idempotent. */
async function createProject(baseUrl: string, input: { email: string; project: string }) {
  const url = new URL("/api", baseUrl);
  url.protocol = "ws:";
  // The one call it makes, typed here: `iterate/next/api`'s types need the worker's lib (preview.ts
  // `previewSignIn` does the same).
  using rpc = newWebSocketRpcSession<{
    authenticate(credentials: { type: "admin-secret"; secret: string; as: { email: string } }): {
      projects: { create(input: { project: string }): Promise<unknown> };
    };
  }>(url.href);
  await rpc
    // local dev's `secrets.adminBearer` (generate-wrangler-config.ts `viteWranglerConfig`)
    .authenticate({
      type: "admin-secret",
      secret: "dev-admin-api-secret",
      as: { email: input.email },
    })
    .projects.create({ project: input.project });
}

/** `origin` when a Dash answers there as a client of `issuer` (iterate/next/app-server.ts serves
 *  every app's `/.auth/client.json` and `/.auth/session.json`), else null. */
async function localDash(origin: string, issuer: string) {
  const json = (path: string) =>
    fetch(new URL(path, origin), { signal: AbortSignal.timeout(2000) })
      .then((response) =>
        response.ok ? (response.json() as Promise<Record<string, unknown>>) : null,
      )
      .catch(() => null);
  const [client, session] = await Promise.all([
    json("/.auth/client.json"),
    json("/.auth/session.json"),
  ]);
  return client?.client_name === "iterate Dash" && session?.defaultIssuer === issuer
    ? new URL(origin).origin
    : null;
}

void createCli({ ...import.meta, name: "getin" }).run();
