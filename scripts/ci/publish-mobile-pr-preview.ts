// Per-PR mobile previews: publishes the PR's JS bundle to an EAS Update
// channel named after its branch, then maintains a managed PR-body section
// with two tappable QR codes — an OTA deep link into the installed app and a
// full-install link — expanding whichever the runtime-fingerprint heuristic
// says Misha needs. Runs on PRs touching apps/mobile
// (.depot/workflows/mobile-pr-preview.yml); EXPO_TOKEN via Doppler like the
// merge-to-main publish (scripts/ci/publish-mobile-update.ts).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getOctokit, getRepo, readEventPayload } from "./github.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mobileDir = path.join(repoRoot, "apps/mobile");

/** markdownAnnotator label for the managed PR-body section. */
export const bodySectionLabel = "mobile-pr-preview";

/** Release whose assets host the QR PNGs (already exists; images render
 * inline from release-download URLs, unlike API-posted attachments). */
const qrAssetsReleaseTag = "gh-attach-assets";

/** EAS channel names are much more restrictive than git branch names. */
export const channelForBranch = (branch: string) =>
  branch.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

export type PreviewPlan = {
  /** Does the PR's JS run on the binary Misha already has installed? */
  runtimeMatchesInstalled: boolean;
  channel: string;
  deepLinkUrl: string;
  installUrl: string;
};

export const planPreview = (input: {
  scheme: string;
  channel: string;
  publishedRuntime: string;
  /** Runtime of the newest FINISHED preview-profile build — what's installable today. */
  installedRuntime: string | undefined;
  /** Install page of the build serving this PR: the newest usable build whose
   * runtime matches the published update (may be freshly triggered). */
  installUrl: string;
}): PreviewPlan => ({
  runtimeMatchesInstalled: input.publishedRuntime === input.installedRuntime,
  channel: input.channel,
  deepLinkUrl: `${input.scheme}://preview-channel/${input.channel}`,
  installUrl: input.installUrl,
});

const qrDetails = (opts: {
  open: boolean;
  summary: string;
  qrImageUrl: string;
  href: string;
  caption: string;
}) =>
  [
    `<details${opts.open ? " open" : ""}><summary>${opts.summary}</summary>`,
    "",
    `<a href="${opts.href}"><img src="${opts.qrImageUrl}" width="180" alt="QR code" /></a>`,
    "",
    `${opts.caption}: ${opts.href}`,
    "",
    "</details>",
  ].join("\n");

export const renderBodySection = (input: {
  plan: PreviewPlan;
  deepLinkQrUrl: string;
  installQrUrl: string;
  headSha: string;
  publishedRuntime: string;
}) => {
  const { plan } = input;
  return [
    "## 📱 Mobile preview",
    "",
    `Channel \`${plan.channel}\` · runtime \`${input.publishedRuntime.slice(0, 9)}\` · ${
      plan.runtimeMatchesInstalled
        ? "**JS-only** — the installed app can run it"
        : "**native changes** — needs a fresh install"
    } · ${input.headSha.slice(0, 9)}`,
    "",
    qrDetails({
      open: plan.runtimeMatchesInstalled,
      summary: "OTA — switch the installed app to this PR's channel",
      qrImageUrl: input.deepLinkQrUrl,
      href: plan.deepLinkUrl,
      caption: "Deep link (only works with the app installed)",
    }),
    qrDetails({
      open: !plan.runtimeMatchesInstalled,
      summary: "Full install — if the app is uninstalled or the runtime differs",
      qrImageUrl: input.installQrUrl,
      href: plan.installUrl,
      caption: "EAS build install page",
    }),
    "",
    `<sub>Back to main inside the app: Build info → Reset to default channel. Republishes on every push to this PR.</sub>`,
  ].join("\n");
};

const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Same JSON-slicing as publish-mobile-update.ts: pnpm dlx and eas-cli both
// write noise around the payload.
const easJson = (args: string[]) => {
  const output = run(
    "pnpm",
    ["dlx", "eas-cli@21.0.1", ...args, "--non-interactive", "--json"],
    mobileDir,
  );
  const start = output.search(/[[{]/);
  const end = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
  if (start === -1 || end < start) {
    throw new Error(`no JSON found in eas output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
};

const usableStatuses = ["NEW", "IN_QUEUE", "IN_PROGRESS", "FINISHED"];

async function uploadQrAsset(name: string, url: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-pr-qr-"));
  const file = path.join(dir, name);
  writeFileSync(file, await QRCode.toBuffer(url, { width: 512, margin: 2 }));
  const github = getOctokit();
  const repo = getRepo();
  const release = await github.rest.repos.getReleaseByTag({ ...repo, tag: qrAssetsReleaseTag });
  const existing = release.data.assets.find((a) => a.name === name);
  if (existing) {
    // Re-runs on the same sha: content is identical (URL-derived), keep it.
    return existing.browser_download_url;
  }
  const uploaded = await github.rest.repos.uploadReleaseAsset({
    ...repo,
    release_id: release.data.id,
    name,
    // Octokit types want a string; the payload is binary and passes through fine.
    data: readFileSync(file) as unknown as string,
    headers: { "content-type": "image/png", "content-length": String(readFileSync(file).length) },
  });
  return uploaded.data.browser_download_url;
}

async function publishMobilePrPreview() {
  const payload = readEventPayload();
  const pullRequest = payload.pull_request;
  if (!pullRequest?.head?.ref || !pullRequest.head.sha) {
    throw new Error("pull_request payload with head ref/sha is required");
  }
  if (!process.env.EXPO_TOKEN) {
    throw new Error("EXPO_TOKEN is not set — eas-cli cannot authenticate");
  }

  const appConfig = JSON.parse(readFileSync(path.join(mobileDir, "app.json"), "utf8"));
  const { scheme, owner, slug } = appConfig.expo;
  const channel = channelForBranch(pullRequest.head.ref);
  const headSha = pullRequest.head.sha;

  run("node", ["scripts/write-build-info.mjs"], mobileDir);
  const message = `PR #${pullRequest.number}: ${(pullRequest.title || "").slice(0, 900)}`;
  // --clear-cache: CI reuses sandboxes across branches and Metro's cache
  // bakes in absolute paths (see tasks/complete/2026-08-04-mobile-build-info-commit-message.md).
  const published = easJson([
    "update",
    "--channel",
    channel,
    "--platform",
    "ios",
    "--clear-cache",
    "--message",
    message,
  ]);
  const updates: any[] = Array.isArray(published) ? published : [published];
  const publishedRuntime = updates[0]?.runtimeVersion;
  if (!publishedRuntime) {
    throw new Error(`unexpected eas update output: ${JSON.stringify(published)}`);
  }
  console.log(
    `published update ${updates[0].id} to channel ${channel} (runtime ${publishedRuntime})`,
  );

  const installedBuilds: any[] = easJson([
    "build:list",
    "--platform",
    "ios",
    "--build-profile",
    "preview",
    "--status",
    "FINISHED",
    "--limit",
    "1",
  ]);
  const installedRuntime: string | undefined = installedBuilds[0]?.runtimeVersion;

  // A build the PR's JS can actually run on: reuse any usable one for this
  // runtime (on match that's the build already on the phone), else trigger.
  const runtimeBuilds: any[] = easJson([
    "build:list",
    "--platform",
    "ios",
    "--build-profile",
    "preview",
    "--runtime-version",
    publishedRuntime,
    "--limit",
    "30",
  ]);
  let installBuild = runtimeBuilds.find((b) => usableStatuses.includes(b.status));
  if (!installBuild) {
    console.log(`no build for runtime ${publishedRuntime} — triggering one`);
    const triggered = easJson(["build", "--platform", "ios", "--profile", "preview", "--no-wait"]);
    installBuild = Array.isArray(triggered) ? triggered[0] : triggered;
  }
  if (!installBuild?.id) {
    throw new Error(`could not find or trigger an install build: ${JSON.stringify(installBuild)}`);
  }

  const plan = planPreview({
    scheme,
    channel,
    publishedRuntime,
    installedRuntime,
    installUrl: `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${installBuild.id}`,
  });

  const [deepLinkQrUrl, installQrUrl] = await Promise.all([
    uploadQrAsset(
      `mobile-pr-${pullRequest.number}-${headSha.slice(0, 9)}-ota.png`,
      plan.deepLinkUrl,
    ),
    uploadQrAsset(
      `mobile-pr-${pullRequest.number}-${headSha.slice(0, 9)}-install-${installBuild.id.slice(0, 8)}.png`,
      plan.installUrl,
    ),
  ]);

  const section = renderBodySection({
    plan,
    deepLinkQrUrl,
    installQrUrl,
    headSha,
    publishedRuntime,
  });
  const github = getOctokit();
  const repo = getRepo();
  // Fresh body, not the event payload's - it may have been edited since.
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: pullRequest.number });
  const body = markdownAnnotator(pr.body || "", bodySectionLabel).update(section);
  await github.rest.pulls.update({ ...repo, pull_number: pullRequest.number, body });
  console.log(`updated mobile preview section in PR #${pullRequest.number} body`);
}

if (isMainModule(import.meta.url)) {
  await publishMobilePrPreview();
}
