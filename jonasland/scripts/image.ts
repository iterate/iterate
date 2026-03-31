import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { os } from "@orpc/server";
import { z } from "zod/v4";

const repoRoot = join(import.meta.dirname, "..", "..");
const defaultDepotBuildPlatform = "linux/amd64,linux/arm64";

export const imageRouter = os.router({
  build: os
    .input(
      z
        .object({
          builder: z.enum(["local", "depot"]).default("local"),
          imageTag: z.string().min(1).optional(),
        })
        .default({ builder: "local" }),
    )
    .meta({
      description: "Build jonasland sandbox image into local Docker",
      default: true,
    })
    .handler(async ({ input }) => {
      const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
      const gitShaShort = gitSha.slice(0, 7);
      const isDirty = (() => {
        try {
          const status = execSync("git status --porcelain", {
            cwd: repoRoot,
            encoding: "utf-8",
          });
          return status.trim().length > 0;
        } catch {
          return false;
        }
      })();
      // Keep tags content-addressable in a human-readable way so local, Fly, and
      // Depot image refs all line up across the same build.
      const tagSuffix = `jonasland-sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;
      const defaultImageTag = `jonasland-sandbox:${tagSuffix}`;
      const latestImageTag = "jonasland-sandbox:latest";
      const imageTag = input.imageTag ?? defaultImageTag;
      const extraLocalTags = input.imageTag ? [] : [latestImageTag];
      const builtBy = process.env.ITERATE_USER ?? "unknown";

      console.log(`Tag suffix: ${tagSuffix}${isDirty ? " (dirty)" : ""}`);

      if (input.builder === "depot") {
        // The Depot path is our "publishable" build: multi-arch, pushed to Fly,
        // saved in Depot, and then loaded back into the local daemon.
        const flyApiToken = process.env.FLY_API_TOKEN?.trim();
        if (!flyApiToken) {
          throw new Error("FLY_API_TOKEN is required when builder=depot");
        }

        const flyRegistryApp =
          process.env.JONASLAND_SANDBOX_FLY_REGISTRY_APP?.trim() ||
          process.env.SANDBOX_FLY_REGISTRY_APP?.trim() ||
          "iterate-sandbox";
        const flyImageTag = `registry.fly.io/${flyRegistryApp}:${tagSuffix}`;
        const depotProjectId = readDepotProjectId();
        const depotImageTag = `registry.depot.dev/${depotProjectId}:${tagSuffix}`;

        ensureFlyAuth(flyApiToken);

        const buildArgs = [
          "build",
          "--platform",
          defaultDepotBuildPlatform,
          "--progress=plain",
          "--save",
          "--save-tag",
          tagSuffix,
          "--load",
          "--push",
          "-t",
          flyImageTag,
          "-f",
          "jonasland/sandbox/Dockerfile",
          "--build-arg",
          `GIT_SHA=${gitSha}`,
          "--label",
          `com.iterate.built_by=${builtBy}`,
          ".",
        ];

        console.log(`Building with Depot for ${defaultDepotBuildPlatform}`);
        console.log(`Fly image: ${flyImageTag}`);
        console.log(`Depot image: ${depotImageTag}`);
        console.log(`Local image: ${imageTag}`);
        for (const extraLocalTag of extraLocalTags) {
          console.log(`Local alias: ${extraLocalTag}`);
        }
        console.log("Loading into local Docker daemon");
        execFileSync("depot", buildArgs, {
          cwd: repoRoot,
          stdio: "inherit",
          timeout: 15 * 60 * 1000,
        });

        // Depot loads the pushed Fly tag into the local daemon, so keep the
        // requested local tag stable by re-tagging after the build completes.
        console.log(`Re-tagging ${flyImageTag} -> ${imageTag}`);
        execFileSync("docker", ["tag", flyImageTag, imageTag], {
          cwd: repoRoot,
          stdio: "inherit",
          timeout: 15 * 60 * 1000,
        });

        for (const extraLocalTag of extraLocalTags) {
          console.log(`Re-tagging ${imageTag} -> ${extraLocalTag}`);
          execFileSync("docker", ["tag", imageTag, extraLocalTag], {
            cwd: repoRoot,
            stdio: "inherit",
            timeout: 15 * 60 * 1000,
          });
        }

        return {
          builder: input.builder,
          depotImageTag,
          extraLocalTags,
          flyImageTag,
          gitSha,
          imageTag,
          isDirty,
          tagSuffix,
        };
      }

      const buildArgs = [
        "build",
        "--progress=plain",
        "-f",
        "jonasland/sandbox/Dockerfile",
        "-t",
        imageTag,
        "--build-arg",
        `GIT_SHA=${gitSha}`,
        "--label",
        `com.iterate.built_by=${builtBy}`,
        ".",
      ];

      console.log(`Building local Docker image ${imageTag}`);
      execFileSync("docker", buildArgs, {
        cwd: repoRoot,
        stdio: "inherit",
        timeout: 15 * 60 * 1000,
      });

      for (const extraLocalTag of extraLocalTags) {
        console.log(`Re-tagging ${imageTag} -> ${extraLocalTag}`);
        execFileSync("docker", ["tag", imageTag, extraLocalTag], {
          cwd: repoRoot,
          stdio: "inherit",
          timeout: 15 * 60 * 1000,
        });
      }

      return {
        builder: input.builder,
        extraLocalTags,
        imageTag,
        gitSha,
        isDirty,
        tagSuffix,
      };
    }),
});

function readDepotProjectId(): string {
  const config = JSON.parse(readFileSync(join(repoRoot, "depot.json"), "utf-8")) as {
    id?: string;
  };
  if (!config.id) {
    throw new Error("Missing depot project id in depot.json");
  }
  return config.id;
}

function ensureFlyAuth(token: string): void {
  try {
    // Prefer Fly's helper because it configures the Docker auth entry the way Fly expects.
    execFileSync("flyctl", ["auth", "docker", "-t", token], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, FLY_ACCESS_TOKEN: token },
      timeout: 15 * 60 * 1000,
    });
  } catch {
    // Fall back to a plain Docker login so the builder still works in environments
    // where `flyctl auth docker` is unavailable.
    execFileSync("docker", ["login", "registry.fly.io", "-u", "x", "--password-stdin"], {
      cwd: repoRoot,
      input: `${token}\n`,
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 15 * 60 * 1000,
    });
  }
}
