import { expect, test } from "vitest";
import { RepoProcessorContract } from "../repo-processor-contract.ts";
import fixture from "./misha-web-2026-07-23t14-43-53-788z-default-branch.fixture.json" with { type: "json" };

test("a GitHub repo creation request records the repository's reported default branch", () => {
  const requestSchema =
    RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema;
  const request = requestSchema.parse({
    ...fixture.createRequest,
    defaultBranch: fixture.githubRepository.defaultBranch,
  });

  expect(request).toEqual({
    ...fixture.createRequest,
    defaultBranch: "master",
  });
});
