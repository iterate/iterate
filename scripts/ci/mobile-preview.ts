// Shared machinery for the mobile preview QR sections that CI maintains on
// PR bodies (scripts/ci/publish-mobile-pr-preview.ts) and main commit
// comments (scripts/ci/publish-mobile-update.ts): eas-cli JSON calls,
// find-or-trigger install builds, QR generation/upload, and the rendered
// two-QR markdown section.
//
// Links deliberately go through the OS https interstitial
// (`/m/preview-channel/<channel>`, apps/os/src/routes/m.preview-channel.$channel.ts)
// rather than `iterate://` directly: GitHub strips custom-scheme hrefs at
// render time, so raw deep links were scannable but never tappable.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { envs } from "../../envs.ts";
import { getOctokit, getRepo } from "./github.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const mobileDir = path.join(repoRoot, "apps/mobile");

/** Release whose assets host the QR PNGs (already exists; images render
 * inline from release-download URLs, unlike API-posted attachments). */
const qrAssetsReleaseTag = "gh-attach-assets";

/** EAS channel names are much more restrictive than git branch names. */
export const channelForBranch = (branch: string) =>
  branch.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

/** The tappable form of a preview-channel deep link (GitHub strips
 * custom-scheme hrefs, so markdown links bounce through this https page).
 * Channel only — the recommended backend + test login travel inside the
 * published bundle itself (apps/mobile/scripts/write-build-info.mjs), not
 * the link. */
export const interstitialUrl = (baseUrl: string, channel: string) =>
  `${baseUrl}/m/preview-channel/${channel}`;

/** Production OS — the phone's app talks to prd, so QR links do too. */
export const prdBaseUrl = envs.prd.baseUrl;

export const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// pnpm dlx prefixes install noise and eas-cli appends upgrade notices, so
// slice out the JSON payload rather than parsing the whole stream.
export const easJson = (args: string[]) => {
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

/** Runtime of the newest finished preview build — what a phone can be running today. */
export const latestInstalledRuntime = (): string | undefined => {
  const builds: any[] = easJson([
    "build:list",
    "--platform",
    "ios",
    "--build-profile",
    "preview",
    "--status",
    // The flag wants lowercase; the JSON output reports uppercase. Sigh.
    "finished",
    "--limit",
    "1",
  ]);
  return builds[0]?.runtimeVersion;
};

/** A build that can run JS published for `runtime`: reuse any usable one,
 * else trigger a fresh build (--no-wait) and return it. */
export const ensureBuildForRuntime = (runtime: string) => {
  const builds: any[] = easJson([
    "build:list",
    "--platform",
    "ios",
    "--build-profile",
    "preview",
    "--runtime-version",
    runtime,
    "--limit",
    "30",
  ]);
  let build = builds.find((b) => usableStatuses.includes(b.status));
  if (!build) {
    console.log(`no preview build for runtime ${runtime} — triggering one`);
    const triggered = easJson(["build", "--platform", "ios", "--profile", "preview", "--no-wait"]);
    build = Array.isArray(triggered) ? triggered[0] : triggered;
  }
  if (!build?.id) {
    throw new Error(`could not find or trigger an install build: ${JSON.stringify(build)}`);
  }
  return build;
};

export type PreviewPlan = {
  /** Does the published JS run on the binary a phone already has installed? */
  runtimeMatchesInstalled: boolean;
  channel: string;
  /** Https interstitial that bounces to iterate://preview-channel/<channel> —
   * the TAP path (GitHub strips custom-scheme hrefs, so links need https). */
  deepLinkUrl: string;
  /** Raw app-scheme URL — the SCAN path. The camera opens custom schemes
   * directly, so QR codes encode this and skip the interstitial hop. */
  otaQrContent: string;
  installUrl: string;
};

export const planPreview = (input: {
  baseUrl: string;
  /** The app's URL scheme (app.json `scheme`, i.e. "iterate"). */
  scheme: string;
  channel: string;
  publishedRuntime: string;
  /** Runtime of the newest FINISHED preview-profile build — what's installable today. */
  installedRuntime: string | undefined;
  /** Install page of the build serving this update: the newest usable build
   * whose runtime matches (may be freshly triggered). */
  installUrl: string;
}): PreviewPlan => ({
  runtimeMatchesInstalled: input.publishedRuntime === input.installedRuntime,
  channel: input.channel,
  deepLinkUrl: interstitialUrl(input.baseUrl, input.channel),
  otaQrContent: `${input.scheme}://preview-channel/${input.channel}`,
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
    // The caption is the tap path (phone reading the page); the QR is the
    // scan path (phone pointed at another screen). The <a> around the img is
    // best-effort - GitHub's mobile app opens images fullscreen regardless.
    `**[${opts.caption}](${opts.href})**`,
    "",
    `<a href="${opts.href}"><img src="${opts.qrImageUrl}" width="90" alt="QR code" /></a>`,
    "",
    "</details>",
  ].join("\n");

export const renderPreviewSection = (input: {
  variant: "pr" | "main";
  plan: PreviewPlan;
  deepLinkQrUrl: string;
  installQrUrl: string;
  headSha: string;
  /** Commit the install build was compiled from — often older than headSha
   * when a still-compatible build is reused. */
  installBuildSha: string | undefined;
  publishedRuntime: string;
}) => {
  const { plan } = input;
  const forMain = input.variant === "main";
  return [
    forMain ? "## 📱 Mobile preview — main" : "## 📱 Mobile preview",
    "",
    `Channel \`${plan.channel}\` · runtime \`${input.publishedRuntime.slice(0, 9)}\` · ${
      plan.runtimeMatchesInstalled
        ? "**JS-only** — the installed app can run it"
        : "**native changes** — needs a fresh install"
    }`,
    "",
    qrDetails({
      open: plan.runtimeMatchesInstalled,
      summary: forMain
        ? `OTA — default-channel phones pull this automatically (\`${input.headSha.slice(0, 7)}\`)`
        : `OTA — switch the installed app to this PR's channel (\`${input.headSha.slice(0, 7)}\`)`,
      qrImageUrl: input.deepLinkQrUrl,
      href: plan.deepLinkUrl,
      caption: forMain
        ? "Switch this phone back to the default channel now"
        : "Switch this phone to the PR channel",
    }),
    qrDetails({
      open: !plan.runtimeMatchesInstalled,
      summary: `Full install — if the app is uninstalled or the runtime differs (\`${
        input.installBuildSha?.slice(0, 7) || "unknown sha"
      }\`)`,
      qrImageUrl: input.installQrUrl,
      href: plan.installUrl,
      caption: "Open the EAS build install page",
    }),
    "",
    forMain
      ? `<sub>Posted by mobile-eas-update on merges touching apps/mobile.</sub>`
      : `<sub>Back to main inside the app: Build info → Reset to default channel. Republishes on every push to this PR.</sub>`,
  ].join("\n");
};

export async function uploadQrAsset(name: string, url: string) {
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
