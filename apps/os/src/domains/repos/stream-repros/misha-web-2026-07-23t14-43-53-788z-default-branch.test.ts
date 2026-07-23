import { expect, test } from "vitest";
import { resolveRepoCreateRequest } from "../repo-defaults.ts";
import fixture from "./misha-web-2026-07-23t14-43-53-788z-default-branch.fixture.json" with { type: "json" };

test("a GitHub repo creation request adopts the repository's reported default branch", async () => {
  const request = await resolveRepoCreateRequest(
    fixture.createRequest as any,
    async (coordinates) => {
      expect(coordinates).toMatchObject({
        connection: "install-114628444-bjinlk2pdykc",
        owner: "mmkal",
        repo: "lerna-learning",
      });
      return fixture.githubRepository.defaultBranch;
    },
  );

  expect(request).toEqual({
    ...fixture.createRequest,
    defaultBranch: "master",
  });
});
