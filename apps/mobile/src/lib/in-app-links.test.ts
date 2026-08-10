import { expect, test } from "vitest";
import { resolveInAppLink } from "./in-app-links.ts";

const context = { baseUrl: "https://os.iterate.com", projectId: "prj_1" };

test("media links land on the Media screen searching the original filename", () => {
  expect(
    resolveInAppLink(`https://os.iterate.com/media/${"a".repeat(64)}-IMG_0001.png`, context),
  ).toEqual({
    pathname: "/project/[projectId]/media",
    params: { projectId: "prj_1", q: "IMG_0001.png" },
  });
  // The bare stream path opens the screen with no search.
  expect(resolveInAppLink("https://os.iterate.com/media", context)).toEqual({
    pathname: "/project/[projectId]/media",
    params: { projectId: "prj_1" },
  });
});

test("repo links open the repo screen at the repo root", () => {
  expect(resolveInAppLink("https://os.iterate.com/repos/config/docs/plan.md", context)).toEqual({
    pathname: "/project/[projectId]/repo",
    params: { projectId: "prj_1", repoPath: "/repos/config" },
  });
});

test("everything else falls through to the system browser", () => {
  // Different origin — including lookalike hosts and schemes.
  expect(resolveInAppLink("https://evil.example/media/x.png", context)).toBeNull();
  expect(resolveInAppLink("http://os.iterate.com/media/x.png", context)).toBeNull();
  // Same origin, no special prefix ("/mediation" must not match "/media").
  expect(resolveInAppLink("https://os.iterate.com/mediation/x", context)).toBeNull();
  expect(resolveInAppLink("https://os.iterate.com/projects/foo", context)).toBeNull();
  // Unparseable input or missing context.
  expect(resolveInAppLink("not a url", context)).toBeNull();
  expect(
    resolveInAppLink("https://os.iterate.com/media/x.png", {
      baseUrl: undefined,
      projectId: "prj_1",
    }),
  ).toBeNull();
});

test("local dev origins with ports match exactly", () => {
  const dev = { baseUrl: "http://localhost:61366", projectId: "prj_1" };
  expect(resolveInAppLink("http://localhost:61366/media/abc-x.png", dev)).toMatchObject({
    params: { q: "abc-x.png" },
  });
  expect(resolveInAppLink("http://localhost:9999/media/abc-x.png", dev)).toBeNull();
});
