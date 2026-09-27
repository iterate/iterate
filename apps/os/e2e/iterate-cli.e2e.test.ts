import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { newHttpBatchRpcSession } from "capnweb";
import { connectIterate } from "iterate/node";
import { test } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import { MyComputer } from "../../../packages/cli/src/use-my-computer.ts";
import { adminCredentials, freshCtx, openItx, readAll, workerUrl } from "./support/client.ts";
import { issuerCookie } from "./support/principal.ts";
import { freshDnsSafeProjectSlug, registerProject } from "./support/project-host.ts";

const bin = fileURLToPath(new URL("../../../packages/cli/bin/iterate.js", import.meta.url).href);

test(
  "published CLI: OAuth PKCE login, refresh, project listing, an itx script with durable settlement, and a personal access token it mints, uses at /api and /mcp, and revokes",
  // The package build runs inside the row (capped at a minute below): 8–14 s in all against a
  // preview, 30 runs on 2026-09-24.
  { timeout: 90_000 },
  async ({ expect }) => {
    await buildPublishedCli();
    const slug = freshDnsSafeProjectSlug("cli");
    const member = { email: `${slug}@example.com` };
    const project = await registerProject(slug, member);
    using directory = temporaryDirectory();
    const path = join(directory.path, "iterate/config.json");
    await mkdir(join(directory.path, "iterate"));
    await writeFile(
      path,
      JSON.stringify({ default: "e2e", configs: { e2e: { osBaseUrl: workerUrl("/") } } }),
    );
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: directory.path,
      ITERATE_FORCE_BUILT_PACKAGE: "1",
      ITERATE_SKIP_BROWSER_OPEN: "1",
      ITERATE_BEARER_TOKEN: "",
      APP_CONFIG_ADMIN_API_SECRET: "",
    };
    const run = (args: string[], extra: Record<string, string> = {}) =>
      promisify(execFile)(process.execPath, [bin, ...args], {
        env: { ...env, ...extra },
        timeout: 30_000,
      });
    const cookie = await issuerCookie(member.email);
    const children: ReturnType<typeof run>["child"][] = [];
    /** `args` run as a command that signs in in the browser: the person consents to the URL it
     *  prints (the issuer's consent action with their cookie, the project ticked) and its loopback
     *  gets the code. The authorize URL is handed back for its scope. */
    const consented = async (args: string[], extra: Record<string, string> = {}) => {
      const running = run(args, extra);
      children.push(running.child);
      // A rejection handler while consent is driven, so an early process failure cannot go unhandled.
      void running.catch(() => {});
      // The URL is printed once a fresh Node process has loaded the built CLI and registered its
      // client, seconds on a loaded runner. The process's own 30 s timeout bounds the wait: a command
      // that ends first, killed or not, fails at once with its stderr.
      let stderr = "";
      const printed = new Promise<string>((resolve, reject) => {
        running.child.stderr!.on("data", (chunk) => {
          stderr += chunk;
          const url = /https?:\/\/\S+\/oauth2\/auth\?\S+/.exec(stderr)?.[0];
          if (url) resolve(url);
        });
        running.child.once("close", (code, signal) =>
          reject(
            new Error(
              `\`iterate ${args.join(" ")}\` ended (${signal || `exit ${code}`}) before printing an authorize URL; its stderr:\n${stderr}`,
            ),
          ),
        );
      });
      const authorize = new URL(await printed);
      // oxlint-disable-next-line iterate/no-capnweb-http-batch -- The issuer's one consent action, with the signed-in user's cookie.
      using issuer = newHttpBatchRpcSession<IterateRpcTarget>(
        new Request(workerUrl("/api"), {
          headers: { Origin: new URL(workerUrl("/")).origin, Cookie: cookie },
        }),
      );
      const approved = await issuer
        .authenticate({ type: "from-server-cookie" })
        .consent.approve({ query: authorize.search, projects: [project] });
      if (!("redirectTo" in approved)) throw new Error(JSON.stringify(approved));
      const callback = await fetch(approved.redirectTo);
      expect(callback).toMatchObject({ status: 200 });
      await callback.body?.cancel();
      return { authorize, result: await running };
    };
    try {
      const login = await consented(["login"]);
      // `iterate` alone: the session stored on disk mints no key (the `tokens` commands step up)
      expect(login.authorize.searchParams.get("scope")).toBe("iterate");
      expect(login.authorize.searchParams.get("resource")).toBe(workerUrl("/api"));
      expect(login.authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(login.result.stdout).toContain("Logged in successfully");
      const stored = JSON.parse(await readFile(path, "utf8"));
      expect(stored.configs.e2e.session.refreshToken).toBeTruthy();
      stored.configs.e2e.session.expiresAt = new Date(0).toISOString();
      await writeFile(path, JSON.stringify(stored));
      expect((await run(["ping"])).stdout).toContain(member.email);
      expect(
        Date.parse(JSON.parse(await readFile(path, "utf8")).configs.e2e.session.expiresAt),
      ).toBeGreaterThan(Date.now());
      expect((await run(["projects", "list"])).stdout).toContain(project);
      const result = await run([
        "itx",
        "run",
        "--project",
        project,
        "--eval",
        'await itx.append({ type: "cli-proof", payload: { value: 42 } }); return { answer: 42 };',
      ]);
      expect(result.stdout).toContain("42");
      const events = await readAll(openItx(project));
      expect(events.filter((event) => event.type === "cli-proof")).toHaveLength(1);
      expect(events.some((event) => event.type.endsWith("run-settled"))).toBe(true);

      // A PERSONAL ACCESS TOKEN (the project by slug), printed once: `tokens` signs in again with
      // `account` for its one call, and ends that session before it returns
      const create = await consented(["tokens", "create", "--name", "cli-e2e", "--project", slug]);
      expect(create.authorize.searchParams.get("scope")).toBe("iterate account");
      const created = create.result.stdout;
      const token = /itk_[0-9a-f]{32}_[0-9a-f]{16}_[0-9A-Za-z]{49}/.exec(created)?.[0];
      const id = /pat_[0-9a-f]{16}/.exec(created)?.[0];
      expect({ token, id }, created).toEqual({ token: expect.any(String), id: expect.any(String) });
      const key = { ITERATE_BEARER_TOKEN: token! };
      // the key is the CLI's bearer on /api, and Claude Code's on /mcp (the preflight's tools/list);
      // the command printed for Claude Code reads it from the environment, never spells it
      expect((await run(["ping"], key)).stdout).toContain(member.email);
      const claude = await run(["mcp", "claude"], key);
      expect(claude.stderr).toContain("accepted the bearer; tools: run");
      expect(claude.stdout).toContain("$ITERATE_BEARER_TOKEN");
      expect(claude.stdout + claude.stderr).not.toContain(token);
      // the `tokens` commands sign in for themselves, whatever key the environment holds; the list
      // names the session that minted the key, which ended with its command
      const listed = (await consented(["tokens", "list"], key)).result.stdout;
      expect(listed).toContain(id);
      expect(listed).toContain("(no longer listed)");
      await consented(["tokens", "revoke", id!], key);
      await expect(run(["ping"], key)).rejects.toThrow(/Invalid or revoked bearer/);
    } finally {
      for (const child of children) child.kill();
    }
  },
);

test("computer provider is callable from another connection and released on disposal", async ({
  expect,
}) => {
  const projectId = freshCtx("cli-computer");
  using connection = await connectIterate({ baseUrl: workerUrl("/"), auth: adminCredentials() });
  using project = await connection.session.projects.get(projectId);
  const provider = await project.provide("itx.myComputer", new MyComputer());
  const caller = openItx(projectId);
  try {
    const description = await caller.invoke(["itx", "myComputer", ["__describe"]]);
    expect(description.types).toContain("runSwift");
  } finally {
    provider[Symbol.dispose]();
  }
  await expect
    .poll(async () =>
      (await caller.rewriteRules.list()).some(
        (rule: { match: string }) => rule.match === "itx.myComputer",
      ),
    )
    .toBe(false);
  await expect(caller.invoke(["itx", "myComputer", ["__describe"]])).rejects.toThrow();
});

/** Exercise the publishable artifact even on a clean checkout with no dist directory. */
async function buildPublishedCli(): Promise<void> {
  await promisify(execFile)(
    "pnpm",
    ["--dir", fileURLToPath(new URL("../../../packages/cli", import.meta.url).href), "build"],
    { timeout: 60_000 },
  );
}
