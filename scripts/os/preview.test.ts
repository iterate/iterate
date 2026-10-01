import { tmpdir } from "node:os";
import { mkdirSync, utimesSync, writeFileSync, mkdtempDisposableSync } from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { getOsEnv, osEnvs, PREVIEW_DEPLOYMENT_APPS, previewDeployment } from "../../envs.ts";
import { replaceMarkedSection } from "../ci/markdown-annotator.ts";
import { parseAppConfig } from "../../core/os/src/app-config.ts";
import { viteWranglerConfig } from "../../core/os/scripts/generate-wrangler-config.ts";
import {
  APPS,
  appSignInLink,
  assertFreshInstall,
  configTemplateFolders,
  foldPreviewSection,
  MAX_PREVIEW_PREFIX_LENGTH,
  previewDeploymentName,
  previewDeploymentUrls,
  PREVIEW_SECTION,
  previewPullRequestNumber,
  renderPullRequestSection,
  resolvePreviewPrefix,
  slugifyPreviewName,
  proxiedAppRoute,
  signInLinkOf,
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

test("a deployment is derived from its name alone: eight plain workers on the dev/preview account, core/os's resources named after its worker", () => {
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
      adminIssuer: "https://os.iterate.com",
      testEmailDomain: "preview.iterate.test",
      resourceNamePrefix: "pr3144-a1b2c3d-os",
    },
  });
  expect(previewDeploymentUrls("pr3144-a1b2c3d")).toEqual({
    os: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
    apps: {
      dash: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      agents: "https://pr3144-a1b2c3d-agents.iterate-dev-preview.workers.dev",
      notes: "https://pr3144-a1b2c3d-notes.iterate-dev-preview.workers.dev",
      docs: "https://pr3144-a1b2c3d-docs.iterate-dev-preview.workers.dev",
      admin: "https://pr3144-a1b2c3d-admin.iterate-dev-preview.workers.dev",
      voice: "https://pr3144-a1b2c3d-voice.iterate-dev-preview.workers.dev",
      kit: "https://pr3144-a1b2c3d-kit.iterate-dev-preview.workers.dev",
    },
  });
  // the envs.ts deployments, main on dev's workers and a bare prefix are none
  for (const name of ["preview", "prd", "os", "pr3144", "self-host"])
    expect(previewDeployment(name)).toBeUndefined();
});

test("the apps on top are the deployment's seven clients", () => {
  expect(APPS.map((app) => app.name).toSorted()).toEqual([...PREVIEW_DEPLOYMENT_APPS].toSorted());
});

test("a deployment's prefix: a PR's number reads back out of it; any other prefix has none", () => {
  expect(previewPullRequestNumber("pr123")).toBe(123);
  expect(previewPullRequestNumber("pr123-feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("pr-foo")).toBeUndefined();
});

const DASH = "https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev";
const section = renderPullRequestSection({
  deployment: "pr123-ccccccc",
  workers: [
    {
      name: "os",
      url: "https://pr123-ccccccc-os.iterate-dev-preview.workers.dev",
      signIn: `${DASH}/.auth/login?next=os`,
      dashboardUrl: "https://dash.cloudflare.com/a/os",
    },
    {
      name: "dash",
      url: DASH,
      signIn: `${DASH}/.auth/login?next=dash`,
      dashboardUrl: "https://dash.cloudflare.com/a/dash",
    },
    {
      name: "notes",
      url: "https://pr123-ccccccc-notes.iterate-dev-preview.workers.dev",
      signIn:
        "https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/projects/pr123/notes/projects/pr123",
      dashboardUrl: "https://dash.cloudflare.com/a/notes",
    },
  ],
  templates: [
    { name: "default", link: `${DASH}/.auth/login?next=default` },
    { name: "minimal", link: `${DASH}/.auth/login?next=minimal`, fromHead: "bbbbbbbbb0123456" },
  ],
  seed: { project: "pr123", seeded: true },
});

test("the PR body's managed section: the deployment, then one row per worker with its sign-in and dashboard links, then the templates; nothing that explains itself", () => {
  expect(section).toMatchInlineSnapshot(`
    "### Preview \`pr123-ccccccc\`

    | apps | | |
    | --- | --- | --- |
    | [os](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=os) | [Cloudflare dashboard](https://dash.cloudflare.com/a/os) |
    | [dash](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=dash) | [Cloudflare dashboard](https://dash.cloudflare.com/a/dash) |
    | [notes](https://pr123-ccccccc-notes.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/projects/pr123/notes/projects/pr123) | [Cloudflare dashboard](https://dash.cloudflare.com/a/notes) |

    New project from template: [default ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=default) · [minimal at this PR's \`bbbbbbbbb\` ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=minimal)"
  `);
});

test("the PR body's managed section: says so when CI's seed of the test project failed, since there is then nobody to sign in as", () => {
  expect(
    renderPullRequestSection({
      deployment: "pr123-ccccccc",
      workers: [],
      templates: [],
      seed: { project: "pr123", seeded: false },
    }),
  ).toContain(
    "Seeding `pr123` failed (the deploy log says why): there is nobody to sign in as yet.",
  );
  expect(section).not.toContain("Seeding");
});

// ── a previous commit's section, folded when the next deploy starts ──

test("a new deploy folds the previous commit's section, keeping the author's text byte for byte; the next section it writes is unfolded again", () => {
  const body = withSection("What this PR does.\n");
  const folded = foldPreviewSection(body, "Previous commit's deployment");
  expect(folded).toMatchInlineSnapshot(`
    "What this PR does.

    <!-- os-preview -->
    <details><summary>Previous commit's deployment: <code>pr123-ccccccc</code></summary>

    | apps | | |
    | --- | --- | --- |
    | [os](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=os) | [Cloudflare dashboard](https://dash.cloudflare.com/a/os) |
    | [dash](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=dash) | [Cloudflare dashboard](https://dash.cloudflare.com/a/dash) |
    | [notes](https://pr123-ccccccc-notes.iterate-dev-preview.workers.dev) | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/projects/pr123/notes/projects/pr123) | [Cloudflare dashboard](https://dash.cloudflare.com/a/notes) |

    New project from template: [default ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=default) · [minimal at this PR's \`bbbbbbbbb\` ↗](https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login?next=minimal)

    </details>
    <!-- /os-preview -->
    "
  `);
  expect(folded.startsWith("What this PR does.\n\n")).toBe(true);
  // folding twice (a retried deploy, a second push before the first deploy landed) changes nothing
  expect(foldPreviewSection(folded, "Previous commit's deployment")).toBe(folded);
  expect(withSection(folded)).toBe(body);
});

test("a new deploy leaves a body without the section alone", () => {
  expect(foldPreviewSection("What this PR does.\n", "Previous commit's deployment")).toBe(
    "What this PR does.\n",
  );
});

test("closing the PR folds its section as deleted, with nothing to replace it", () => {
  const folded = foldPreviewSection(withSection("What this PR does.\n"), "Deleted deployment");
  expect(folded).toContain(
    "<!-- os-preview -->\n<details><summary>Deleted deployment: <code>pr123-ccccccc</code></summary>",
  );
  expect(withSection(folded)).toBe(withSection("What this PR does.\n"));
});

// ── template quick-launch links: the Dash's New project sheet, one click ──

test("a `Sign in ↗` link is the app's own sign-in, landing where the link lands, suggesting the way a reviewer signs in and naming whom the consent page pre-fills", () => {
  const link = appSignInLink(`${DASH}/projects?new=1&template=minimal`, {
    provider_hint: "os.iterate.com",
    login_hint: "pr123@preview.iterate.test",
  });
  expect(link.startsWith(`${DASH}/.auth/login?`)).toBe(true);
  expect(Object.fromEntries(new URL(link).searchParams)).toEqual({
    next: "/projects?new=1&template=minimal",
    provider_hint: "os.iterate.com",
    login_hint: "pr123@preview.iterate.test",
  });
});

test("each app's `Sign in ↗` for PR 123, each suggesting os.iterate.com: the Dash's into the test person's project, a proxied app's through the platform's sign-in to its page in that project, the admin app's naming nobody", () => {
  const deployment = previewDeployment("pr123-ccccccc")!;
  const links = Object.fromEntries(
    ["dash", "agents", "notes", "docs", "admin"].map((app) => {
      const url = new URL(
        signInLinkOf({
          app: { name: app, url: `https://pr123-ccccccc-${app}.iterate-dev-preview.workers.dev` },
          platform: deployment.os.baseUrl,
          ingressRouting: deployment.os.ingressRouting!,
          project: "pr123",
          email: "pr123@preview.iterate.test",
          providerHint: "os.iterate.com",
        }),
      );
      return [
        app,
        `${url.origin}${url.pathname} ${JSON.stringify(Object.fromEntries(url.searchParams))}`,
      ];
    }),
  );
  expect(links).toEqual({
    dash: 'https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev/.auth/login {"next":"/projects/pr123","provider_hint":"os.iterate.com","login_hint":"pr123@preview.iterate.test"}',
    agents:
      'https://pr123-ccccccc-agents.iterate-dev-preview.workers.dev/.auth/login {"next":"/","provider_hint":"os.iterate.com","login_hint":"pr123@preview.iterate.test"}',
    notes:
      'https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/login {"next":"/projects/pr123/notes/projects/pr123","provider_hint":"os.iterate.com"}',
    docs: 'https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/login {"next":"/projects/pr123/docs/projects/pr123","provider_hint":"os.iterate.com"}',
    admin:
      'https://pr123-ccccccc-admin.iterate-dev-preview.workers.dev/.auth/login {"next":"/","provider_hint":"os.iterate.com"}',
  });
});

test("a proxied app's link needs paths ingress: under subdomains the app is an origin of its own, not on the platform's sign-in", () => {
  expect(() =>
    signInLinkOf({
      app: { name: "notes", url: "https://notes.iterate.com" },
      platform: "https://os.iterate.com",
      ingressRouting: { type: "subdomains", hostname: "iterate.app" },
      project: "pr123",
      email: "pr123@preview.iterate.test",
      providerHint: "os.iterate.com",
    }),
  ).toThrow(/needs paths ingress/);
});

test("the seed's route for a proxied app: the routing slug of its name, members only, to a loaded worker that fetches through to the deployment's own app Worker", () => {
  const route = proxiedAppRoute(
    "notes",
    "https://pr123-ccccccc-notes.iterate-dev-preview.workers.dev",
  );
  expect(route).toMatchObject({
    requestMatcher: { routingSlug: "notes" },
    authRequirement: { visitors: "project-members" },
    target: ["itx", "workers", ["get", { source: { "package.json": '{"main":"worker.js"}' } }]],
  });
  const [, , [, { source }]] = route.target as any;
  expect(source["worker.js"]).toMatchInlineSnapshot(`
    "export default {
      fetch(request) {
        const url = new URL(request.url);
        url.protocol = "https:";
        url.host = "pr123-ccccccc-notes.iterate-dev-preview.workers.dev";
        return fetch(new Request(url, new Request(request, { redirect: "manual" })));
      },
    };
    "
  `);
});

test("every core/configs/ and configs/ directory is a config template", () => {
  expect(configTemplateFolders(path.resolve(import.meta.dirname, "../.."))).toEqual(
    expect.arrayContaining(["core/configs/default", "core/configs/minimal", "configs/voice"]),
  );
});

test.for([
  {
    name: "a template this PR changes is the PR head's copy, an unchanged one its name, and default the preview's own",
    changedPaths: [
      "core/configs/default/AGENTS.md",
      "core/configs/minimal/worker.ts",
      "configs/other-v2/x.md",
    ],
    expected: [
      { name: "default", next: `${DASH}/projects?new=1&template=default` },
      {
        name: "minimal",
        fromHead: "bbbbbbbbb0123456",
        next: `${DASH}/projects?new=1&template=github%3Aiterate%2Fiterate%23bbbbbbbbb0123456%26path%3Acore%2Fconfigs%2Fminimal`,
      },
    ],
  },
  {
    name: "a PR that changes no template links each by name",
    changedPaths: ["core/os/src/worker.ts", "core/configs/README.md"],
    expected: [
      { name: "default", next: `${DASH}/projects?new=1&template=default` },
      { name: "minimal", next: `${DASH}/projects?new=1&template=minimal` },
    ],
  },
])("template quick-launch: $name", ({ changedPaths, expected }) => {
  expect(
    templateQuickLaunches({
      dashUrl: DASH,
      templates: ["core/configs/default", "core/configs/minimal"],
      changedPaths,
      headSha: "bbbbbbbbb0123456",
    }),
  ).toEqual(expected);
});

test("template quick-launch: the Dash reads the PR head's reference back out of the link", () => {
  const [link] = templateQuickLaunches({
    dashUrl: DASH,
    templates: ["core/configs/minimal"],
    changedPaths: ["core/configs/minimal/AGENTS.md"],
    headSha: "bbbbbbbbb0123456",
  });
  expect(Object.fromEntries(new URL(link!.next).searchParams)).toEqual({
    new: "1",
    template: "github:iterate/iterate#bbbbbbbbb0123456&path:core/configs/minimal",
  });
});

// ── a deployment's wrangler config: the one prd's goes through (core/os/scripts/generate-wrangler-config.ts) ──

// iterate's deployments' Artifacts namespace, R2 bucket and D1: each `<resourceNamePrefix>-…`
// (core/os/scripts/os-env.ts `osResourceNames`), the prefix envs.ts gives it.
test.for([
  { name: "prd", repos: "os-prd-repos", files: "os-prd-files", db: "os-prd-db" },
  { name: "preview", repos: "os-parent-repos", files: "os-parent-files", db: "os-parent-db" },
  {
    name: "pr3144-a1b2c3d",
    repos: "pr3144-a1b2c3d-os-repos",
    files: "pr3144-a1b2c3d-os-files",
    db: "pr3144-a1b2c3d-os-db",
  },
])("$name binds $repos, $files and $db", ({ name, repos, files, db }) => {
  expect(viteWranglerConfig(getOsEnv(name), { localDev: false, port: "0" })).toMatchObject({
    artifacts: [{ binding: "ARTIFACTS", namespace: repos }],
    r2_buckets: [{ binding: "FILES", bucket_name: files }],
    d1_databases: [{ binding: "DB", database_name: db }],
  });
});

test("a deployment's core/os config: its own worker, KV binding-only for wrangler to provision, the D1 by name for the deploy to create and migrate, R2 and Artifacts named after its worker, no routes", () => {
  const config = viteWranglerConfig(getOsEnv("pr3144-a1b2c3d"), { localDev: false, port: "0" });
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

test("a deployment's core/os config: vars are its own origin, its dash, projects as paths, prd's admins signing in through prd beside one test admin, and the pet shop's fakes as iterate's integrations, which test people sign in with too", () => {
  expect(
    viteWranglerConfig(getOsEnv("pr3144-a1b2c3d"), { localDev: false, port: "0" }),
  ).toMatchObject({
    vars: {
      APP_CONFIG_URLS__OS: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__DASH: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      APP_CONFIG_ADMINS: JSON.stringify([
        "jonas@nustom.com",
        "misha@nustom.com",
        "admin@preview.iterate.test",
      ]),
      APP_CONFIG_LOGIN__ADMIN_ISSUER: "https://os.iterate.com",
      APP_CONFIG_LOGIN__TEST_EMAIL_DOMAIN: "preview.iterate.test",
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
    },
  });
  // the GitHub App carries a key: scripts/os/deploy.ts ships it as a secret, never a var
  expect(
    viteWranglerConfig(getOsEnv("pr3144-a1b2c3d"), { localDev: false, port: "0" }).vars,
  ).not.toHaveProperty("APP_CONFIG_INTEGRATIONS__GITHUB");
});

test("a deployment's core/os config parses as its worker parses it, with the two secrets every deploy ships", () => {
  const { vars } = viteWranglerConfig(getOsEnv("pr3144-a1b2c3d"), { localDev: false, port: "0" });
  expect(
    parseAppConfig({
      ...vars,
      APP_CONFIG: JSON.stringify({ login: { password: "p" }, secrets: { adminBearer: "b" } }),
      APP_CONFIG_SECRETS__KEY: "k",
    }),
  ).toMatchObject({
    urls: { os: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev" },
    login: { adminIssuer: "https://os.iterate.com", testEmailDomain: "preview.iterate.test" },
    admins: ["jonas@nustom.com", "misha@nustom.com", "admin@preview.iterate.test"],
  });
});

test("an envs.ts deployment's config still names its resources by id, and turns no other issuer, test people or pet shop fakes on", () => {
  const config = viteWranglerConfig(getOsEnv("prd"), { localDev: false, port: "0" });
  const ids = osEnvs.prd!.resources!;
  expect(config).toMatchObject({
    kv_namespaces: [
      { binding: "OAUTH_KV", id: ids.oauthKvId },
      { binding: "ITX_KV", id: ids.itxKvId },
    ],
    d1_databases: [{ database_name: "os-prd-db", database_id: ids.dbId }],
  });
  expect(config.vars).not.toHaveProperty("APP_CONFIG_LOGIN__ADMIN_ISSUER");
  expect(config.vars).not.toHaveProperty("APP_CONFIG_LOGIN__TEST_EMAIL_DOMAIN");
  expect(config.vars).not.toHaveProperty("APP_CONFIG_INTEGRATIONS__SLACK");
  expect(() => getOsEnv("pr3144")).toThrow('core/os: unknown env "pr3144"');
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
  const directory = mkdtempDisposableSync(path.join(tmpdir(), "iterate-test-"));
  onTestFinished(directory[Symbol.dispose]);
  const root = directory.path;
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

function withSection(body: string) {
  return replaceMarkedSection(body, PREVIEW_SECTION, section);
}
