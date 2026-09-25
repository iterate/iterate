import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { osEnvs, PREVIEW_DEPLOYMENT_APPS, previewDeployment } from "../../../envs.ts";
import { parseAppConfig } from "../src/app-config.ts";
import { viteWranglerConfig } from "./generate-wrangler-config.ts";
import {
  APPS,
  assertFreshInstall,
  configTemplateNames,
  foldPreviousPreviewSection,
  MAX_PREVIEW_PREFIX_LENGTH,
  previewDeploymentName,
  previewDeploymentUrls,
  previewPullRequestNumber,
  renderPullRequestSection,
  resolvePreviewPrefix,
  slugifyPreviewName,
  splicePullRequestBody,
  templateQuickLaunches,
} from "./preview-config.ts";

test.each([
  ["feature/foo", "123", "pr123"],
  [undefined, "123", "pr123"],
  ["feature/foo", "", "feature-foo"],
  ["Feature_Foo", undefined, "feature-foo"],
  ["main", undefined, "main"],
  ["real-model", undefined, "real-model"],
])("a deployment's prefix: %s with PR %s → %s", (name, prNumber, expected) => {
  expect(resolvePreviewPrefix({ name, prNumber })).toBe(expected);
});

test("a deployment's prefix: a long one is truncated with a stable hash, inside the limit", () => {
  const prefix = resolvePreviewPrefix({
    name: "jonas/os-worker-previews-with-a-very-long-descriptive-branch-name",
  });
  expect(prefix.length).toBeLessThanOrEqual(MAX_PREVIEW_PREFIX_LENGTH);
  expect(prefix).toMatch(/^jonas-os-worker-[a-z0-9-]+-[0-9a-f]{6}$/);
  expect(slugifyPreviewName("a".repeat(40))).not.toBe(slugifyPreviewName("a".repeat(41)));
  expect(() => resolvePreviewPrefix({})).toThrow("a deployment needs a PR number (--pr) or a name");
});

test("a deployment's name is its prefix and the tested commit's first 7 digits: a new commit, a new set of workers", () => {
  const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  expect(previewDeploymentName("pr3144", commit)).toBe("pr3144-a1b2c3d");
  expect(previewDeploymentName("real-model", commit)).toBe("real-model-a1b2c3d");
  // the longest prefix still names every worker and resource under Cloudflare's 63 characters
  const longest = previewDeploymentName("a".repeat(MAX_PREVIEW_PREFIX_LENGTH), commit);
  expect(`${longest}-os-oauth-kv`.length).toBeLessThanOrEqual(63);
  expect(() => previewDeploymentName("pr3144", "not-a-commit")).toThrow(
    "pr3144-not-a-c is not a deployment name",
  );
});

test("a deployment is derived from its name alone: seven plain workers on the dev/preview account, apps/os's resources named after its worker", () => {
  expect(previewDeployment("pr3144-a1b2c3d")).toMatchObject({
    prefix: "pr3144",
    sha: "a1b2c3d",
    os: {
      workerName: "pr3144-a1b2c3d-os",
      baseUrl: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
      mcpBaseUrl: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev/mcp",
      dashBaseUrl: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      dopplerConfig: "preview",
      ingressRouting: { type: "paths" },
      testLinks: { admins: { issuer: "https://os.iterate.com", emails: ["*@nustom.com"] } },
      artifactsNamespace: "pr3144-a1b2c3d-os-repos",
      resourceNamePrefix: "pr3144-a1b2c3d-os",
    },
  });
  expect(previewDeploymentUrls("pr3144-a1b2c3d")).toEqual({
    os: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
    apps: {
      dash: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      agents: "https://pr3144-a1b2c3d-agents.iterate-dev-preview.workers.dev",
      notes: "https://pr3144-a1b2c3d-notes.iterate-dev-preview.workers.dev",
      admin: "https://pr3144-a1b2c3d-admin.iterate-dev-preview.workers.dev",
      voice: "https://pr3144-a1b2c3d-voice.iterate-dev-preview.workers.dev",
      kit: "https://pr3144-a1b2c3d-kit.iterate-dev-preview.workers.dev",
    },
  });
  // the envs.ts deployments, main on dev's workers and a bare prefix are none
  for (const name of ["preview", "prd", "os", "pr3144", "self-host"])
    expect(previewDeployment(name)).toBeUndefined();
});

test("the apps on top are the deployment's six clients", () => {
  expect(APPS.map((app) => app.name).toSorted()).toEqual([...PREVIEW_DEPLOYMENT_APPS].toSorted());
});

test("a deployment's prefix: a PR's number reads back out of it; any other prefix has none", () => {
  expect(previewPullRequestNumber("pr123")).toBe(123);
  expect(previewPullRequestNumber("pr123-feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("pr-foo")).toBeUndefined();
});

const OS = "https://pr123-ccccccc-os.iterate-dev-preview.workers.dev";
const DASH = "https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev";
const section = renderPullRequestSection({
  deployment: "pr123-ccccccc",
  workers: [
    {
      name: "os",
      url: OS,
      signIn: `${OS}/.auth/test-link?t=os`,
      dashboardUrl: "https://dash.cloudflare.com/a/os",
    },
    {
      name: "dash",
      url: DASH,
      signIn: `${OS}/.auth/test-link?t=dash`,
      dashboardUrl: "https://dash.cloudflare.com/a/dash",
    },
  ],
  templates: [
    { name: "default", link: `${OS}/.auth/test-link?t=default`, fromHead: "bbbbbbbbb0123456" },
    { name: "with-agents", link: `${OS}/.auth/test-link?t=with-agents` },
  ],
  seed: { project: "pr123", seeded: true },
});

test("the PR body's managed section: the deployment, then one row per worker with its sign-in and dashboard links, then the templates; nothing that explains itself", () => {
  expect(section).toMatchInlineSnapshot(`
    "### Preview \`pr123-ccccccc\`

    | apps | | |
    | --- | --- | --- |
    | [os](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=os) | [Cloudflare dashboard](https://dash.cloudflare.com/a/os) |
    | [dash](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=dash) | [Cloudflare dashboard](https://dash.cloudflare.com/a/dash) |

    New project from template: [default at this PR's \`bbbbbbbbb\` ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=default) · [with-agents ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=with-agents)"
  `);
});

test("the PR body's managed section: says so when CI's seed of the test project failed, since the links then ask for consent", () => {
  expect(
    renderPullRequestSection({
      deployment: "pr123-ccccccc",
      workers: [],
      templates: [],
      seed: { project: "pr123", seeded: false },
    }),
  ).toContain("Seeding `pr123` failed (the deploy log says why): the links ask for consent.");
  expect(section).not.toContain("Seeding");
});

test("the PR body's managed section: appends to a body without one, keeping the author's text", () => {
  const body = splicePullRequestBody("What this PR does.\n", section);
  expect(body.startsWith("What this PR does.\n\n<!-- os-preview:begin -->\n")).toBe(true);
  expect(body.endsWith("\n<!-- os-preview:end -->\n")).toBe(true);
});

test("the PR body's managed section: replaces an existing section in place, and only that", () => {
  const before = `Intro.\n\n<!-- os-preview:begin -->\nold\n<!-- os-preview:end -->\n\nOutro.\n`;
  const after = splicePullRequestBody(before, "new");
  expect(after).toBe(
    `Intro.\n\n<!-- os-preview:begin -->\nnew\n<!-- os-preview:end -->\n\nOutro.\n`,
  );
  expect(splicePullRequestBody(after, "newer")).not.toContain("new\n<!--");
});

test("the PR body's managed section: an empty body becomes just the section", () => {
  expect(splicePullRequestBody("", "s")).toBe(
    "<!-- os-preview:begin -->\ns\n<!-- os-preview:end -->\n",
  );
});

// ── a previous commit's section, folded when the next deploy starts ──

test("a new deploy folds the previous commit's section, keeping the author's text byte for byte; the next section it writes is unfolded again", () => {
  const body = splicePullRequestBody("What this PR does.\n", section);
  const folded = foldPreviousPreviewSection(body);
  expect(folded).toMatchInlineSnapshot(`
    "What this PR does.

    <!-- os-preview:begin -->
    <details><summary>Previous commit's deployment: <code>pr123-ccccccc</code></summary>

    | apps | | |
    | --- | --- | --- |
    | [os](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=os) | [Cloudflare dashboard](https://dash.cloudflare.com/a/os) |
    | [dash](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=dash) | [Cloudflare dashboard](https://dash.cloudflare.com/a/dash) |

    New project from template: [default at this PR's \`bbbbbbbbb\` ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=default) · [with-agents ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=with-agents)

    </details>
    <!-- os-preview:end -->
    "
  `);
  expect(folded.startsWith("What this PR does.\n\n")).toBe(true);
  // folding twice (a retried deploy, a second push before the first deploy landed) changes nothing
  expect(foldPreviousPreviewSection(folded)).toBe(folded);
  expect(splicePullRequestBody(folded, section)).toBe(body);
});

test("a new deploy folds a section written before per-commit deployments too, and leaves a body without one alone", () => {
  const legacy = splicePullRequestBody("", "### OS preview: `pr123`\n\nold links");
  expect(foldPreviousPreviewSection(legacy)).toContain(
    "<details><summary>Previous commit's deployment: <code>pr123</code></summary>\n\nold links\n\n</details>",
  );
  expect(foldPreviousPreviewSection("What this PR does.\n")).toBe("What this PR does.\n");
});

// ── template quick-launch links: the Dash's New project sheet, one click ──

test("every configs/ directory is a config template", () => {
  expect(configTemplateNames(path.resolve(import.meta.dirname, "../../.."))).toEqual(
    expect.arrayContaining(["default", "with-agents"]),
  );
});

test.for([
  {
    name: "a template this PR changes is the PR head's copy, an unchanged one its name",
    changedPaths: ["configs/default/AGENTS.md", "configs/with-agents-v2/x.md"],
    expected: [
      {
        name: "default",
        fromHead: "bbbbbbbbb0123456",
        next: `${DASH}/projects?new=1&template=github%3Aiterate%2Fiterate%23bbbbbbbbb0123456%26path%3Aconfigs%2Fdefault`,
      },
      { name: "with-agents", next: `${DASH}/projects?new=1&template=with-agents` },
    ],
  },
  {
    name: "a PR that changes no template links each by name",
    changedPaths: ["apps/os/src/worker.ts", "configs/README.md"],
    expected: [
      { name: "default", next: `${DASH}/projects?new=1&template=default` },
      { name: "with-agents", next: `${DASH}/projects?new=1&template=with-agents` },
    ],
  },
])("template quick-launch: $name", ({ changedPaths, expected }) => {
  expect(
    templateQuickLaunches({
      dashUrl: DASH,
      templates: ["default", "with-agents"],
      changedPaths,
      headSha: "bbbbbbbbb0123456",
    }),
  ).toEqual(expected);
});

test("template quick-launch: the Dash reads the PR head's reference back out of the link", () => {
  const [link] = templateQuickLaunches({
    dashUrl: DASH,
    templates: ["default"],
    changedPaths: ["configs/default/AGENTS.md"],
    headSha: "bbbbbbbbb0123456",
  });
  expect(Object.fromEntries(new URL(link!.next).searchParams)).toEqual({
    new: "1",
    template: "github:iterate/iterate#bbbbbbbbb0123456&path:configs/default",
  });
});

// ── a deployment's wrangler config: the one prd's goes through (generate-wrangler-config.ts) ──

test("a deployment's apps/os config: its own worker, KV binding-only for wrangler to provision, the D1 by name for the deploy to create and migrate, R2 and Artifacts named after its worker, no routes", () => {
  const config = viteWranglerConfig("pr3144-a1b2c3d", { localDev: false, port: "0" });
  expect(config).toMatchObject({
    name: "pr3144-a1b2c3d-os",
    account_id: osEnvs.preview!.cloudflareAccountId,
    workers_dev: true,
    routes: [],
    r2_buckets: [{ binding: "FILES", bucket_name: "pr3144-a1b2c3d-os-files" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "pr3144-a1b2c3d-os-repos" }],
  });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- binding-only is the point: a copied id must fail
  expect(config.kv_namespaces).toEqual([{ binding: "OAUTH_KV" }, { binding: "ITX_KV" }]);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- no id: wrangler finds the D1 by name
  expect(config.d1_databases).toEqual([
    {
      binding: "DB",
      database_name: "pr3144-a1b2c3d-os-db",
      migrations_dir: "src/control-plane/db/migrations",
    },
  ]);
});

test("a deployment's apps/os config: vars are its own origin, its dash, projects as paths, the one-click sign-in links on behind prd's *@nustom.com check, one test admin, and the pet shop's fakes as iterate's integrations, which people sign in with too", () => {
  expect(viteWranglerConfig("pr3144-a1b2c3d", { localDev: false, port: "0" })).toMatchObject({
    vars: {
      APP_CONFIG_URLS__OS: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__DASH: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: "preview.iterate.test",
      APP_CONFIG_LOGIN__TEST_LINK__ADMINS__ISSUER: "https://os.iterate.com",
      APP_CONFIG_LOGIN__TEST_LINK__ADMINS__EMAILS: "*@nustom.com",
      APP_CONFIG_INTEGRATIONS__SLACK: JSON.stringify({
        oauthClientId: "petshop-default",
        oauthClientSecret: "petshop-default-secret",
        webhookSigningSecret: "preview-slack-signing-secret",
        slackOrigin: "https://dummy-petshop.iterate.workers.dev",
      }),
      APP_CONFIG_INTEGRATIONS__GOOGLE: JSON.stringify({
        oauthClientId: "petshop-default",
        oauthClientSecret: "petshop-default-secret",
        googleOrigin: "https://dummy-petshop.iterate.workers.dev",
      }),
      APP_CONFIG_INTEGRATIONS__CLOUDFLARE: JSON.stringify({
        oauthClientId: "petshop-default",
        oauthClientSecret: "petshop-default-secret",
        cloudflareOrigin: "https://dummy-petshop.iterate.workers.dev",
      }),
      APP_CONFIG_LOGIN__GOOGLE: "{}",
      APP_CONFIG_LOGIN__GITHUB: "{}",
      APP_CONFIG_ADMINS: JSON.stringify(["admin@preview.iterate.test"]),
    },
  });
  // the GitHub App carries a key: scripts/deploy.ts ships it as a secret, never a var
  expect(
    viteWranglerConfig("pr3144-a1b2c3d", { localDev: false, port: "0" }).vars,
  ).not.toHaveProperty("APP_CONFIG_INTEGRATIONS__GITHUB");
});

test("a deployment's apps/os config parses as its worker parses it, with the two secrets every deploy ships", () => {
  const { vars } = viteWranglerConfig("pr3144-a1b2c3d", { localDev: false, port: "0" });
  expect(
    parseAppConfig({
      ...vars,
      APP_CONFIG: JSON.stringify({ login: { password: "p" }, secrets: { adminBearer: "b" } }),
      APP_CONFIG_SECRETS__KEY: "k",
    }),
  ).toMatchObject({
    urls: { os: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev" },
    login: {
      testLink: { admins: { issuer: "https://os.iterate.com", emails: ["*@nustom.com"] } },
    },
  });
});

test("an envs.ts deployment's config still names its resources by id, and turns no test links or pet shop fakes on", () => {
  const config = viteWranglerConfig("prd", { localDev: false, port: "0" });
  const ids = osEnvs.prd!.resources!;
  expect(config).toMatchObject({
    kv_namespaces: [
      { binding: "OAUTH_KV", id: ids.oauthKvId },
      { binding: "ITX_KV", id: ids.itxKvId },
    ],
    d1_databases: [{ database_name: "os-prd-db", database_id: ids.dbId }],
  });
  expect(config.vars).not.toHaveProperty("APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN");
  expect(config.vars).not.toHaveProperty("APP_CONFIG_INTEGRATIONS__SLACK");
  expect(() => viteWranglerConfig("pr3144", { localDev: false, port: "0" })).toThrow(
    'apps/os: unknown env "pr3144"',
  );
});

// Preview OS deploys of #2934, #2939 and #2943 (2026-09-24): the PR head's older lockfile, then
// the merge commit's, rewrote pnpm-lock.yaml over node_modules baked from that same content.
test("the fresh-install check: a lockfile rewritten after the install, byte-identical to the one installed, passes", () => {
  expect(
    freshInstallCheck({ lockfile: ["main", later], installed: ["main", earlier] }),
  ).not.toThrow();
});

test("the fresh-install check: a lockfile changed since the install fails", () => {
  expect(freshInstallCheck({ lockfile: ["main", later], installed: ["pr", earlier] })).toThrow(
    "pnpm-lock.yaml is newer than node_modules and differs from node_modules/.pnpm/lock.yaml",
  );
});

test("the fresh-install check: no install fails", () => {
  expect(freshInstallCheck({ lockfile: ["main", earlier] })).toThrow("has no copy in");
});

// pnpm's installed lockfile can differ benignly (a filtered install): the mtime rule decides.
test("the fresh-install check: an install newer than a differing lockfile passes, as it always has on a laptop", () => {
  expect(
    freshInstallCheck({
      lockfile: ["main", earlier],
      installed: ["filtered", later],
    }),
  ).not.toThrow();
});

const earlier = new Date("2026-09-24T00:00:00Z");
const later = new Date("2026-09-24T00:42:00Z");
/** A checkout: its lockfile, and node_modules as pnpm leaves it (`.modules.yaml`, and the
 *  lockfile it installed from as `.pnpm/lock.yaml`), each file with its mtime. */
function freshInstallCheck(input: { lockfile: [string, Date]; installed?: [string, Date] }) {
  const root = mkdtempSync(path.join(tmpdir(), "preview-fresh-install-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), input.lockfile[0]);
  utimesSync(path.join(root, "pnpm-lock.yaml"), input.lockfile[1], input.lockfile[1]);
  if (input.installed) {
    mkdirSync(path.join(root, "node_modules", ".pnpm"), { recursive: true });
    for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]) {
      writeFileSync(path.join(root, file), input.installed[0]);
      utimesSync(path.join(root, file), input.installed[1], input.installed[1]);
    }
  }
  return () => assertFreshInstall(root);
}
