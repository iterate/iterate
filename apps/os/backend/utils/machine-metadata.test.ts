import { describe, expect, test } from "vitest";
import { stripMachineStateMetadata } from "./machine-metadata.ts";

describe("stripMachineStateMetadata", () => {
  test("removes known transient machine-state keys", () => {
    const cleaned = stripMachineStateMetadata({
      snapshotName: "registry.fly.io/iterate-sandbox:sha-abc1234",
      flyMachineCpus: 8,
      provisioningError: "old error",
      daemonStatus: "error",
      daemonStatusMessage: "Provisioning failed",
      daemonReadyAt: "2026-02-12T00:10:14.172Z",
      host: "localhost",
      port: 3000,
      ports: { "3000": 49999 },
      containerId: "abc",
      containerName: "container-name",
      sandboxName: "sandbox-123",
      fly: { machineId: "old-fly-machine-id", extra: "keep-me" },
      daytona: { sandboxId: "old-daytona-sandbox-id", extra: "keep-me" },
      docker: { containerRef: "old-container-ref", extra: "keep-me" },
      localDocker: { imageName: "iterate-sandbox:sha-abc1234", syncRepo: true },
      triggeredBy: "commit_comment:123",
    });

    expect(cleaned).toEqual({
      snapshotName: "registry.fly.io/iterate-sandbox:sha-abc1234",
      flyMachineCpus: 8,
      fly: { extra: "keep-me" },
      daytona: { extra: "keep-me" },
      docker: { extra: "keep-me" },
      localDocker: { imageName: "iterate-sandbox:sha-abc1234", syncRepo: true },
      triggeredBy: "commit_comment:123",
    });
  });

  test("removes empty nested runtime containers after stripping ids", () => {
    const cleaned = stripMachineStateMetadata({
      fly: { machineId: "old-fly-machine-id" },
      daytona: { sandboxId: "old-daytona-sandbox-id" },
      docker: { containerRef: "old-container-ref" },
    });

    expect(cleaned).toEqual({});
  });
});
