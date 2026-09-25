// The composer's YAML: one event or a list, checked as far as the envelope's shape; every refusal
// says why, naming the event in a list.
import { expect, test } from "vitest";
import {
  DEFAULT_APPEND_YAML,
  exampleGroups,
  exampleYaml,
  parseAppendYaml,
} from "./append-events.ts";

test.each([
  {
    name: "the prefilled draft",
    yaml: DEFAULT_APPEND_YAML,
    events: [{ type: "manual/note-added", payload: { text: "Hello" } }],
  },
  { name: "a type alone", yaml: "type: demo/ping", events: [{ type: "demo/ping" }] },
  {
    name: "every field",
    yaml: "type: demo/ping\npayload: { n: 1 }\nmetadata: { why: test }\nidempotencyKey: k1",
    events: [
      { type: "demo/ping", payload: { n: 1 }, metadata: { why: "test" }, idempotencyKey: "k1" },
    ],
  },
  {
    name: "a list, in order",
    yaml: "- type: demo/a\n- type: demo/b\n  payload: {}\n- type: demo/c",
    events: [{ type: "demo/a" }, { type: "demo/b", payload: {} }, { type: "demo/c" }],
  },
  {
    name: "flow-style JSON",
    yaml: '{"type": "demo/ping", "payload": {"ok": true}}',
    events: [{ type: "demo/ping", payload: { ok: true } }],
  },
])("parses $name", ({ yaml, events }) => {
  expect(parseAppendYaml(yaml)).toEqual({ events });
});

test.each([
  { name: "an empty draft", yaml: "", error: "Nothing to append." },
  { name: "a comment only", yaml: "# nothing", error: "Nothing to append." },
  { name: "an empty list", yaml: "[]", error: "Nothing to append." },
  { name: "a scalar", yaml: "hello", error: "an event is a mapping with a `type`." },
  { name: "no type", yaml: "payload: {}", error: "`type` must be a non-empty string." },
  { name: "a blank type", yaml: "type: ''", error: "`type` must be a non-empty string." },
  { name: "a numeric type", yaml: "type: 12", error: "`type` must be a non-empty string." },
  {
    name: "a list payload",
    yaml: "type: a/b\npayload: [1]",
    error: "`payload` must be a mapping.",
  },
  {
    name: "a string metadata",
    yaml: "type: a/b\nmetadata: x",
    error: "`metadata` must be a mapping.",
  },
  {
    name: "a numeric idempotency key",
    yaml: "type: a/b\nidempotencyKey: 3",
    error: "`idempotencyKey` must be a string.",
  },
  { name: "an unknown field", yaml: "type: a/b\noffset: 3", error: "unknown field `offset`." },
  {
    name: "the bad event of a list, by number",
    yaml: "- type: a/b\n- payload: {}",
    error: "Event 2: `type` must be a non-empty string.",
  },
])("refuses $name", ({ yaml, error }) => {
  expect(parseAppendYaml(yaml)).toEqual({ error });
});

test("refuses YAML that does not parse, saying so", () => {
  const result = parseAppendYaml("type: [unclosed");
  expect("error" in result && result.error.startsWith("Not YAML: ")).toBe(true);
});

test("an example loads as a draft that parses back to its type", () => {
  expect(parseAppendYaml(exampleYaml("events.iterate.com/agent/message-added"))).toEqual({
    events: [{ type: "events.iterate.com/agent/message-added", payload: {} }],
  });
});

test.each([
  {
    name: "one group per processor, by name; types once each, sorted; wildcards left out",
    processors: [
      { name: "zeta", consumes: ["demo/b", "*", "demo/a", "demo/b"] },
      { name: "empty" },
      { name: "only-wildcards", consumes: ["events.iterate.com/itx/*"] },
      { name: "alpha", consumes: ["events.iterate.com/itx/*", "demo/c"] },
    ],
    groups: [
      { label: "alpha", types: ["demo/c"] },
      { label: "zeta", types: ["demo/a", "demo/b"] },
    ],
  },
  {
    name: "processors that consume the same types share a group, named by the first and the rest",
    processors: [
      { name: "sub-b", consumes: ["itx/live-state-changed"] },
      { name: "sub-a", consumes: ["itx/live-state-changed"] },
      { name: "sub-c", consumes: ["itx/live-state-changed"] },
    ],
    groups: [{ label: "sub-a +2", types: ["itx/live-state-changed"] }],
  },
  {
    name: "a type already shown is not shown again under a later group",
    processors: [
      { name: "a", consumes: ["x/one"] },
      { name: "b", consumes: ["x/one", "x/two"] },
      { name: "c", consumes: ["x/one"] },
    ],
    groups: [
      { label: "a +1", types: ["x/one"] },
      { label: "b", types: ["x/two"] },
    ],
  },
])("examples: $name", ({ processors, groups }) => {
  expect(exampleGroups(processors)).toEqual(groups);
});
