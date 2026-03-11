import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland/service-contract";
import type { ServiceManifestWithEntryPoint } from "@iterate-com/shared/jonasland/service-contract";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

export const ExecInput = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.coerce.number().int().positive().optional().default(120_000),
});

export const ExecOutput = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Daemon service health metadata",
  sqlSummary: "Execute SQL against daemon service database",
  debugSummary: "Daemon service runtime debug details",
});

export const daemonContract = oc.router({
  ...serviceSubRouter,
  tools: {
    exec: oc
      .route({
        method: "POST",
        path: "/tools/exec",
        summary: "Execute a shell command",
        tags: ["tools"],
      })
      .input(ExecInput)
      .output(ExecOutput),
  },
});

export const DaemonServiceEnv = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(17330),
});

export type DaemonServiceEnv = z.infer<typeof DaemonServiceEnv>;
export type ExecInput = z.infer<typeof ExecInput>;
export type ExecOutput = z.infer<typeof ExecOutput>;

export {
  ExecInput as execInputSchema,
  ExecOutput as execOutputSchema,
  DaemonServiceEnv as daemonServiceEnvSchema,
};

export const daemonServiceManifest = {
  name: packageJson.name,
  slug: "daemon",
  version: packageJson.version ?? "0.0.0",
  port: 17330,
  serverEntryPoint: "services/daemon/server.ts",
  orpcContract: daemonContract,
  envVars: DaemonServiceEnv,
} as const satisfies ServiceManifestWithEntryPoint;
