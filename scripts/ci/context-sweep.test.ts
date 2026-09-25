import { expect, test } from "vitest";
import { classifyContexts, type SweptContext } from "./context-sweep.ts";

test.each([
  ["a live project's context is left alone", [context("a", "prj_live")], { live: ["a"] }],
  ["a global context is never swept", [context("g", "global", "/users/u1")], { global: ["g"] }],
  [
    "a context of a project the control plane no longer holds is an orphan",
    [context("o", "prj_gone", "/agents/x")],
    { orphans: [context("o", "prj_gone", "/agents/x")] },
  ],
  [
    "one that could not say who it is is reported, never destroyed",
    [{ id: "u", error: "must be addressed by name" }],
    { unidentified: [{ id: "u", error: "must be addressed by name" }] },
  ],
])("%s", (_name, contexts, expected) => {
  expect(classifyContexts(contexts, new Set(["prj_live"]))).toEqual({
    live: [],
    global: [],
    orphans: [],
    unidentified: [],
    ...expected,
  });
});

function context(id: string, projectId: string, path = "/"): SweptContext {
  return { id, projectId, path };
}
