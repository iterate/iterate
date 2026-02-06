import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { runDockerObservability } from "./run-observability-docker.ts";

function nowTag(): string {
  const date = new Date();
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

const enabled = process.env["RUN_DOCKER_E2E"] === "1";
const describeFn = enabled ? describe : describe.skip;

describeFn("docker observability e2e", () => {
  it(
    "proves HTTPS traffic traverses gateway + MITM",
    async () => {
      const cwd = process.cwd();
      const flyDir = cwd.endsWith("/fly-test") ? cwd : join(cwd, "fly-test");
      const app = `iterate-docker-obsv-${nowTag()}`;
      const artifactDir = join(flyDir, "proof-logs", app);
      mkdirSync(artifactDir, { recursive: true });

      await runDockerObservability({
        flyDir,
        artifactDir,
        app,
        targetUrl: process.env["TARGET_URL"] ?? "https://example.com/",
        cleanupOnExit: true,
        log: (line: string) => {
          process.stdout.write(`${line}\n`);
        },
      });
    },
    15 * 60 * 1000,
  );
});
