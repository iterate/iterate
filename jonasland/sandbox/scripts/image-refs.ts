import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const thisFilePath = fileURLToPath(import.meta.url);
const repoRoot = join(import.meta.dirname, "..", "..", "..");

export type ImageRefs = {
  depotImageTag: string;
  flyImageTag: string | null;
  gitShaFull: string;
  gitShaShort: string;
  isDirty: boolean;
  localImageTag: string;
  tagSuffix: string;
};

function readDepotProjectId(): string {
  const config = JSON.parse(readFileSync(join(repoRoot, "depot.json"), "utf-8")) as { id?: string };
  if (!config.id) throw new Error("Missing depot project id in depot.json");
  return config.id;
}

export function computeImageRefs(): ImageRefs {
  const gitShaFull = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
  const gitShaShort = gitShaFull.slice(0, 7);
  const isDirty = (() => {
    try {
      const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" });
      return status.trim().length > 0;
    } catch {
      return false;
    }
  })();
  const tagSuffix = `jonasland-sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;
  const configuredFlyRegistryApp =
    process.env.JONASLAND_SANDBOX_FLY_REGISTRY_APP || process.env.SANDBOX_FLY_REGISTRY_APP;
  const depotProjectId = readDepotProjectId();
  const localImageTag = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
  const flyImageTag = configuredFlyRegistryApp
    ? `registry.fly.io/${configuredFlyRegistryApp}:${tagSuffix}`
    : null;
  const depotImageTag = `registry.depot.dev/${depotProjectId}:${tagSuffix}`;

  return {
    depotImageTag,
    flyImageTag,
    gitShaFull,
    gitShaShort,
    isDirty,
    localImageTag,
    tagSuffix,
  };
}

function outputGithub(refs: ImageRefs): void {
  process.stdout.write(`image=${refs.flyImageTag ?? ""}\n`);
  process.stdout.write(`fly_image_tag=${refs.flyImageTag ?? ""}\n`);
  process.stdout.write(`depot_image_tag=${refs.depotImageTag}\n`);
  process.stdout.write(`git_sha=${refs.gitShaFull}\n`);
}

function outputKv(refs: ImageRefs): void {
  process.stdout.write(`image_tag=${refs.localImageTag}\n`);
  process.stdout.write(`fly_image_tag=${refs.flyImageTag ?? ""}\n`);
  process.stdout.write(`depot_image_tag=${refs.depotImageTag}\n`);
  process.stdout.write(`git_sha=${refs.gitShaFull}\n`);
}

function parseFormat(argv: string[]): "github-output" | "kv" {
  const inline = argv.find((arg) => arg.startsWith("--format="));
  if (inline) return inline.slice("--format=".length) === "github-output" ? "github-output" : "kv";
  const idx = argv.indexOf("--format");
  if (idx >= 0 && argv[idx + 1] === "github-output") return "github-output";
  return "kv";
}

if (process.argv[1] === thisFilePath) {
  const refs = computeImageRefs();
  const format = parseFormat(process.argv.slice(2));
  if (format === "github-output") {
    outputGithub(refs);
  } else {
    outputKv(refs);
  }
}
