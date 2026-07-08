import { expect, test } from "vitest";
import { repoPathFromSplat, repoPathToSplat } from "./repo-splat.ts";

test("normal repo paths round-trip through the splat", () => {
  expect(repoPathToSplat("/repos/project")).toBe("project");
  expect(repoPathFromSplat("project")).toBe("/repos/project");
  expect(repoPathFromSplat("/project")).toBe("/repos/project");
  expect(repoPathToSplat("/repos/nested/path")).toBe("nested/path");
  expect(repoPathFromSplat("nested/path")).toBe("/repos/nested/path");
});

test("the legacy root repo at / round-trips via the ~ sentinel", () => {
  // TEMPORARY HACK: "/" would otherwise produce an empty splat, and the URL
  // ".../repos//" normalizes to the repos index — making the repo unviewable.
  // Delete along with repo-splat.ts when the / repo becomes /repos/config.
  expect(repoPathToSplat("/")).toBe("~");
  expect(repoPathFromSplat("~")).toBe("/");
});
