import { describe, expect, test } from "vitest";
import { resolveProjectHost, type ProjectHostDirectory } from "./ingress.ts";

const deployed: ProjectHostDirectory = {
  projectHostnameBase: "*.iterate2.app",
  projects: { team: "prj_team", "blue-team": "prj_blue" },
  customHostnames: {
    "notes.example.com": "prj_notes",
    "editor.notes.example.com": "prj_editor_notes",
  },
};

const resolve = (host: string) => resolveProjectHost(new URL(`https://${host}/`), deployed);

describe("resolveProjectHost", () => {
  test("prefers a complete configured slug, then the longest app suffix in both supported spellings", () => {
    expect(resolve("blue-team.iterate2.app")).toEqual({
      kind: "project",
      projectId: "prj_blue",
      app: null,
    });
    expect(resolve("writer-blue-team.iterate2.app")).toEqual({
      kind: "project",
      projectId: "prj_blue",
      app: "writer",
    });
    expect(resolve("writer--blue-team.iterate2.app")).toEqual({
      kind: "project",
      projectId: "prj_blue",
      app: "writer",
    });
  });

  test("prefers exact custom names, then one app label below the registered name", () => {
    expect(resolve("editor.notes.example.com")).toEqual({
      kind: "project",
      projectId: "prj_editor_notes",
      app: null,
    });
    expect(resolve("preview.notes.example.com")).toEqual({
      kind: "project",
      projectId: "prj_notes",
      app: "preview",
    });
  });

  test("refuses unknown hosts below the configured wildcard and never inherits prototype names", () => {
    expect(resolve("missing.iterate2.app")).toEqual({ kind: "unknown" });
    expect(resolve("constructor.iterate2.app")).toEqual({ kind: "unknown" });
    expect(resolve("other.example.com")).toBeNull();
  });
});
