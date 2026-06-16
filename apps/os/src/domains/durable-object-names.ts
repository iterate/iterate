import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";

export const NULL_DURABLE_OBJECT_PROJECT_ID = "__null__";

export type DurableObjectNameParts = {
  projectId: string | null;
  path: StreamPathType | string;
};

export type ParsedDurableObjectName = {
  projectId: string | null;
  path: StreamPathType;
};

/**
 * Normalizes the null project sentinel used in encoded Durable Object names.
 *
 * Examples:
 * - `null` -> `null`
 * - `"__null__"` -> `null`
 * - `"proj_123"` -> `"proj_123"`
 */
export function normalizeDurableObjectProjectId(projectId: string | null): string | null {
  return projectId === NULL_DURABLE_OBJECT_PROJECT_ID ? null : projectId;
}

/**
 * Encodes an OS Durable Object name from the canonical object form.
 *
 * Examples:
 * - `{ projectId: "proj_123", path: "/repos/project" }` -> `proj_123:/repos/project`
 * - `{ projectId: null, path: "/repos/iterate-config-base" }` -> `__null__:/repos/iterate-config-base`
 * - `{ projectId: "__null__", path: "/repos/iterate-config-base" }` -> `__null__:/repos/iterate-config-base`
 */
export function formatDurableObjectName(input: DurableObjectNameParts): string {
  const projectId =
    normalizeDurableObjectProjectId(input.projectId) ?? NULL_DURABLE_OBJECT_PROJECT_ID;
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
 * - `__null__:/repos/iterate-config-base` -> `{ projectId: null, path: "/repos/iterate-config-base" }`
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
    projectId: normalizeDurableObjectProjectId(encodedProjectId),
    path: StreamPath.parse(name.slice(colon + 1)),
  };
}
