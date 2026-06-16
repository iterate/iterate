import { describe, expect, it } from "vitest";
import {
  formatDurableObjectName,
  normalizeDurableObjectProjectId,
  NULL_DURABLE_OBJECT_PROJECT_ID,
  parseDurableObjectName,
} from "./durable-object-names.ts";

describe("Durable Object names", () => {
  it("encodes project-local stream coordinates", () => {
    expect(formatDurableObjectName({ projectId: "prj_123", path: "/repos/project" })).toBe(
      "prj_123:/repos/project",
    );
  });

  it("normalizes null and __null__ project ids to the same encoded name", () => {
    const input = { path: "/repos/iterate-config-base" };

    expect(formatDurableObjectName({ ...input, projectId: null })).toBe(
      "__null__:/repos/iterate-config-base",
    );
    expect(formatDurableObjectName({ ...input, projectId: NULL_DURABLE_OBJECT_PROJECT_ID })).toBe(
      "__null__:/repos/iterate-config-base",
    );
  });

  it("parses the null sentinel back to projectId null", () => {
    expect(parseDurableObjectName("__null__:/repos/iterate-config-base")).toEqual({
      projectId: null,
      path: "/repos/iterate-config-base",
    });
  });

  it("normalizes the null sentinel before callers compare project ids", () => {
    expect(normalizeDurableObjectProjectId(NULL_DURABLE_OBJECT_PROJECT_ID)).toBe(null);
    expect(normalizeDurableObjectProjectId(null)).toBe(null);
    expect(normalizeDurableObjectProjectId("prj_123")).toBe("prj_123");
  });
});
