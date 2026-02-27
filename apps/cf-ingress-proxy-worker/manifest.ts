import { workerEnvSchema } from "./env.ts";

// This manifest is a first step toward sharing a common deployment manifest shape.
export const manifest = {
  name: "ingress-proxy",
  requiredEnvSchema: workerEnvSchema,
} as const;
