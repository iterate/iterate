import { describe, it } from "vitest";
import { runCommand } from "./run-observability-lib.ts";

const enabled = process.env["RUN_OBSERVABILITY_E2E"] === "1";
const describeFn = enabled ? describe : describe.skip;
const backends = (process.env["E2E_BACKENDS"] ?? "docker")
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is "docker" | "fly" => value === "docker" || value === "fly");

describeFn("observability integration", () => {
  for (const backend of backends) {
    it(
      `runs shared scenario via ${backend}`,
      () => {
        runCommand("tsx", ["./e2e/run-observability.ts"], {
          env: {
            ...process.env,
            E2E_BACKEND: backend,
            E2E_CLEANUP_ON_EXIT: process.env["E2E_CLEANUP_ON_EXIT"] ?? "1",
          },
        });
      },
      20 * 60 * 1000,
    );
  }
});
