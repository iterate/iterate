import { expect, test } from "vitest";
import {
  formatConfigRepoTemplateReference,
  normalizeConfigRepoTemplateReference,
  parseBuiltinConfigTemplate,
  parseConfigRepoTemplateReference,
} from "./reference.ts";

test.for([
  ["github:iterate/iterate", { owner: "iterate", repo: "iterate" }],
  [
    "github:iterate/iterate#path:configs/default",
    { owner: "iterate", path: "configs/default", repo: "iterate" },
  ],
  [
    "github:iterate/iterate#main&path:configs/with-voice",
    { owner: "iterate", path: "configs/with-voice", ref: "main", repo: "iterate" },
  ],
  [
    "github:iterate/iterate#feature/voice",
    { owner: "iterate", ref: "feature/voice", repo: "iterate" },
  ],
  [
    "git+https://github.com/iterate/iterate.git#abc123&path:configs/default",
    { owner: "iterate", path: "configs/default", ref: "abc123", repo: "iterate" },
  ],
] as const)("parses %s", ([input, expected]) => {
  expect(parseConfigRepoTemplateReference(input)).toEqual(expected);
});

test("serializes every accepted prefix to canonical GitHub shorthand", () => {
  expect(
    normalizeConfigRepoTemplateReference(
      " git+https://github.com/iterate/iterate.git#main&path:configs/with-voice ",
    ),
  ).toBe("github:iterate/iterate#main&path:configs/with-voice");
});

test("formats path-only, ref-only, and repository-root references", () => {
  expect(formatConfigRepoTemplateReference({ owner: "o", repo: "r" })).toBe("github:o/r");
  expect(formatConfigRepoTemplateReference({ owner: "o", ref: "main", repo: "r" })).toBe(
    "github:o/r#main",
  );
  expect(formatConfigRepoTemplateReference({ owner: "o", path: "a/b", repo: "r" })).toBe(
    "github:o/r#path:a/b",
  );
});

test.for([
  "",
  "https://github.com/iterate/iterate",
  "github:iterate",
  "github:iterate/iterate/extra",
  "github:-iterate/iterate",
  "github:iterate/..",
  "github:iterate/iterate#",
  "github:iterate/iterate#main#other",
  "github:iterate/iterate#main&unknown:value",
  "github:iterate/iterate#main&path:",
  "github:iterate/iterate#main&path:/configs/default",
  "github:iterate/iterate#main&path:configs/../default",
  "github:iterate/iterate#main&path:configs/.git/objects",
  "github:iterate/iterate#main&path:configs\\default",
  "github:iterate/iterate#main..other",
  "git+http://github.com/iterate/iterate.git",
  "git+https://token@github.com/iterate/iterate.git",
  "git+https://gitlab.com/iterate/iterate.git",
  "git+https://github.com/iterate/iterate/extra.git",
  "git+https://github.com/iterate/iterate.git?token=nope",
])("rejects %s", (input) => {
  expect(() => parseConfigRepoTemplateReference(input)).toThrow();
});

test("a built-in template names a configs/ folder and the build that baked it; nothing else is one", () => {
  expect(
    parseBuiltinConfigTemplate("builtin:with-agents@0cf0e602c0e1b2c3d4e5f60718293a4b5c6d7e8f"),
  ).toEqual({
    name: "with-agents",
    commit: "0cf0e602c0e1b2c3d4e5f60718293a4b5c6d7e8f",
  });
  expect(
    [
      "github:iterate/iterate#main&path:configs/with-agents",
      "builtin:with-agents",
      "builtin:With_Agents@0cf0e60",
      "builtin:../x@0cf0e60",
    ].map(parseBuiltinConfigTemplate),
  ).toEqual([undefined, undefined, undefined, undefined]);
});
