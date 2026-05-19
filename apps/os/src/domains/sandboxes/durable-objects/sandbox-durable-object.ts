import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export const SANDBOX_WORKSPACE_PATH = "/workspace";
export const SANDBOX_WORKSPACE_MOUNT_PATH = "/mnt/workspace";
export const SANDBOX_ITERATE_CONFIG_PATH = "/workspace/iterate-config";

export type SandboxStructuredName = {
  projectId: string;
  sandboxSlug: string;
};

export type SandboxInfo = {
  iterateConfigPath: string;
  name: string;
  projectId: string;
  runtimeId: string;
  slug: string;
  workspacePath: string;
};

const SandboxStructuredName = z.object({
  projectId: z.string().trim().min(1),
  sandboxSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Sandbox slug must be lowercase kebab-case"),
});

type SandboxEnv = {
  DO_CATALOG: D1Database;
};

const SandboxBase = createIterateDurableObjectBase<
  typeof SandboxStructuredName,
  Pick<SandboxEnv, "DO_CATALOG">
>({
  className: "SandboxDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
    sandboxSlug: (params) => params.sandboxSlug,
  },
  nameSchema: SandboxStructuredName,
});

export class SandboxDurableObject extends SandboxBase<SandboxEnv> {
  async getInfo(): Promise<SandboxInfo> {
    await this.ensureStarted();
    return sandboxInfo(this.structuredName);
  }
}

export function sandboxInfo(name: SandboxStructuredName): SandboxInfo {
  return {
    iterateConfigPath: SANDBOX_ITERATE_CONFIG_PATH,
    name: getSandboxDurableObjectName(name),
    projectId: name.projectId,
    runtimeId: sandboxRuntimeId(name),
    slug: name.sandboxSlug,
    workspacePath: SANDBOX_WORKSPACE_PATH,
  };
}

export function getSandboxDurableObjectName(name: SandboxStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: name,
  });
}

export function sandboxRuntimeId(name: SandboxStructuredName) {
  return `os-${fnv1a(name.projectId)}-${name.sandboxSlug}`;
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
