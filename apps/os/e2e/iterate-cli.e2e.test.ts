import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  "published CLI: OAuth PKCE login, refresh, project listing and an itx script with durable settlement",
  // The package build's own minute on top of the suite's default.
  { timeout: 125_000 },
  async ({ expect }) => {
    await buildPublishedCli();
    const slug = freshDnsSafeProjectSlug("cli");
    const member = { email: `${slug}@example.com` };
    const project = await registerProject(slug, member);
    const directory = await mkdtemp(join(tmpdir(), "iterate-cli-e2e-"));
    const path = join(directory, "iterate/config.json");
    await mkdir(join(directory, "iterate"));
    await writeFile(
      path,
      JSON.stringify({ default: "e2e", configs: { e2e: { osBaseUrl: workerUrl("/") } } }),
    );
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      ITERATE_FORCE_BUILT_PACKAGE: "1",
      ITERATE_SKIP_BROWSER_OPEN: "1",
      ITERATE_BEARER_TOKEN: "",
      APP_CONFIG_ADMIN_API_SECRET: "",
    };
    const run = (args: string[]) =>
      promisify(execFile)(process.execPath, [bin, ...args], { env, timeout: 30_000 });
    const login = run(["login"]);
    // Attach a rejection handler while consent is driven so an early process failure cannot go unhandled.
    void login.catch(() => {});
    let stderr = "";
    login.child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      await expect.poll(() => stderr.match(/https?:\/\/\S+\/oauth2\/auth\?\S+/)?.[0]).toBeTruthy();
      const authorize = new URL(stderr.match(/https?:\/\/\S+\/oauth2\/auth\?\S+/)![0]);
      expect(authorize.searchParams.get("scope")).toBe("iterate");
      expect(authorize.searchParams.get("resource")).toBe(workerUrl("/api"));
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      // oxlint-disable-next-line iterate/no-capnweb-http-batch -- The issuer's one consent action, with the signed-in user's cookie.
      using issuer = newHttpBatchRpcSession<IterateRpcTarget>(
        new Request(workerUrl("/api"), {
          headers: {
            Origin: new URL(workerUrl("/")).origin,
            Cookie: await issuerCookie(member.email),
          },
        }),
      );
      const approved = await issuer
        .authenticate({ type: "from-server-cookie" })
        .consent.approve({ query: authorize.search, projects: [project] });
      if (!("redirectTo" in approved)) throw new Error(JSON.stringify(approved));
      const callback = await fetch(approved.redirectTo);
      expect(callback).toMatchObject({ status: 200 });
      await callback.body?.cancel();
      expect((await login).stdout).toContain("Logged in successfully");
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
    } finally {
      login.child.kill();
      await login.catch(() => {});
      await rm(directory, { recursive: true, force: true });
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
