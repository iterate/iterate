// session-teardown.test.ts — the SessionTeardown lease: a handle disposes only what it registered.
import { expect, test } from "vitest";
import { SessionTeardown } from "./session-teardown.ts";

const undo = (log: string[], label: string) => ({ dispose: () => void log.push(label) });

test("re-adding a key replaces (the incumbent is disposed once); a STALE lease's dispose is inert; the current lease's disposes", () => {
  const log: string[] = [];
  const teardown = new SessionTeardown();
  const first = teardown.add("k", undo(log, "first"));
  const second = teardown.add("k", undo(log, "second"));
  expect(log).toEqual(["first"]); // replaced ⇒ disposed at replacement
  first.dispose();
  expect(log).toEqual(["first"]); // the stale handle touched nothing — its replacement lives
  second.dispose();
  expect(log).toEqual(["first", "second"]);
  second.dispose();
  expect(log).toEqual(["first", "second"]); // idempotent
});

test("the session's own dispose(key) takes whatever is current; disposeAll takes everything once", () => {
  const log: string[] = [];
  const teardown = new SessionTeardown();
  teardown.add("a", undo(log, "a"));
  const b = teardown.add("b", undo(log, "b"));
  teardown.dispose("a");
  expect(log).toEqual(["a"]);
  teardown.disposeAll();
  expect(log).toEqual(["a", "b"]);
  b.dispose();
  expect(log).toEqual(["a", "b"]);
});
