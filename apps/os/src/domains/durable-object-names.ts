import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";

export const GLOBAL_DURABLE_OBJECT_PROJECT_ID = "__global__";

export type DurableObjectNameParts = {
  projectId: string | null;
  path: StreamPathType | string;
};

export type ParsedDurableObjectName = {
  projectId: string | null;
  path: StreamPathType;
};

/**
 * Encodes an OS Durable Object name from the canonical object form.
 *
 * Examples:
 * - `{ projectId: "proj_123", path: "/repos/project" }` -> `proj_123:/repos/project`
 * - `{ projectId: null, path: "/repos/iterate-config-base" }` -> `__global__:/repos/iterate-config-base`
 */
export function formatDurableObjectName(input: DurableObjectNameParts): string {
  const projectId = input.projectId ?? GLOBAL_DURABLE_OBJECT_PROJECT_ID;
  if (input.projectId === GLOBAL_DURABLE_OBJECT_PROJECT_ID) {
    throw new Error(
      `Durable Object projectId ${JSON.stringify(GLOBAL_DURABLE_OBJECT_PROJECT_ID)} is reserved; use null for global Durable Objects.`,
    );
  }
  if (projectId.includes(":")) {
    throw new Error(
      `Durable Object projectId must not contain ":", got ${JSON.stringify(projectId)}.`,
    );
  }
  return `${projectId}:${StreamPath.parse(input.path)}`;
}

/**
 * Parses an OS Durable Object name encoded by {@link formatDurableObjectName}.
 *
 * Examples:
 * - `proj_123:/agents/onboarding` -> `{ projectId: "proj_123", path: "/agents/onboarding" }`
 * - `__global__:/repos/iterate-config-base` -> `{ projectId: null, path: "/repos/iterate-config-base" }`
 */
export function parseDurableObjectName(name: string): ParsedDurableObjectName {
  const colon = name.indexOf(":");
  if (colon <= 0 || name[colon + 1] !== "/") {
    throw new Error(
      `Durable Object name must be "{projectId}:{path}", got ${JSON.stringify(name)}.`,
    );
  }

  const encodedProjectId = name.slice(0, colon);
  return {
    projectId: encodedProjectId === GLOBAL_DURABLE_OBJECT_PROJECT_ID ? null : encodedProjectId,
    path: StreamPath.parse(name.slice(colon + 1)),
  };
}
