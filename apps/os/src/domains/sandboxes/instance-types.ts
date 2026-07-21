import { z } from "zod";

/**
 * The instance types a sandbox can be created as — Cloudflare's container
 * instance-type names, verbatim
 * (https://developers.cloudflare.com/containers/platform-details/limits/):
 *
 * | instanceType | vCPU | memory  | disk  |
 * | ------------ | ---- | ------- | ----- |
 * | lite         | 1/16 | 256 MiB |  2 GB |
 * | basic        | 1/4  |   1 GiB |  4 GB |
 * | standard-1   | 1/2  |   4 GiB |  8 GB |
 * | standard-2   | 1    |   6 GiB | 12 GB |
 * | standard-3   | 2    |   8 GiB | 16 GB |
 * | standard-4   | 4    |  12 GiB | 20 GB |
 *
 * Cloudflare fixes the instance type PER CONTAINER CLASS in wrangler config —
 * there is no per-sandbox option on the SDK — so each instance type is its
 * own Durable Object class (all sharing one implementation). The type is
 * CONFIGURATION, not identity: it never appears in the sandbox path
 * (`/sandboxes/<name>` — a type segment would materialize meaningless
 * intermediate folder streams like `/sandboxes/lite`). The collection
 * records it on `create-requested` and routes every `get` by reading the
 * stream — honest about the one thing a sandbox can never change.
 */
export const SANDBOX_INSTANCE_TYPES = [
  "lite",
  "basic",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const;

export const SandboxInstanceType = z.enum(SANDBOX_INSTANCE_TYPES);
/** A sandbox's size tier ("lite" | "basic" | "standard-1"…"standard-4") —
 * Cloudflare container instance-type names, fixed at `create` and immutable
 * for the sandbox's lifetime. See {@link SANDBOX_INSTANCE_TYPES} for the
 * vCPU/memory/disk table. */
export type SandboxInstanceType = z.infer<typeof SandboxInstanceType>;

/** The instance type a new sandbox gets when `create` doesn't pick one.
 * `basic` (1/4 vCPU, 1 GiB, 4 GB disk) comfortably runs shell work and small
 * servers on the stock image; anything heavier is an explicit choice. */
export const DEFAULT_SANDBOX_INSTANCE_TYPE: SandboxInstanceType = "basic";

/**
 * One row per instance type: the Durable Object class (= container class) and
 * the env binding that namespace is bound as. Wrangler config generation,
 * env.ts, the worker's class exports, and the collection's routing all read
 * this table so they cannot drift.
 */
export const SANDBOX_INSTANCE_TYPE_BINDINGS: Record<
  SandboxInstanceType,
  { binding: string; className: string }
> = {
  lite: { binding: "SANDBOX_LITE", className: "SandboxLiteDurableObject" },
  basic: { binding: "SANDBOX_BASIC", className: "SandboxBasicDurableObject" },
  "standard-1": { binding: "SANDBOX_STANDARD_1", className: "SandboxStandard1DurableObject" },
  "standard-2": { binding: "SANDBOX_STANDARD_2", className: "SandboxStandard2DurableObject" },
  "standard-3": { binding: "SANDBOX_STANDARD_3", className: "SandboxStandard3DurableObject" },
  "standard-4": { binding: "SANDBOX_STANDARD_4", className: "SandboxStandard4DurableObject" },
};
