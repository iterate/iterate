import { expect, test } from "vitest";
import { githubRepositoryOf } from "./github-repository.ts";

const placeholder = 'getSecret("/secrets/github-5339133b", { field: "accessToken" })';

test.for([
  [`https://x-access-token:${placeholder}@github.com/iterate/config.git`, "iterate/config"],
  [
    `https://x-access-token:${encodeURIComponent(placeholder)}@github.com/iterate/config.git`,
    "iterate/config",
  ],
  ["https://github.com/octocat/Spoon-Knife.git", "octocat/Spoon-Knife"],
  ["https://github.com/octocat/Spoon-Knife", "octocat/Spoon-Knife"],
  ["https://github.com/octocat/Spoon-Knife/", "octocat/Spoon-Knife"],
  ["https://gitlab.com/acme/config.git", null],
  ["https://github.com/acme", null],
  ["https://evil.example/github.com/acme/config.git", null],
  [null, null],
] as const)("the origin %s names %s", ([origin, repository]) => {
  expect(githubRepositoryOf(origin)).toBe(repository);
});
