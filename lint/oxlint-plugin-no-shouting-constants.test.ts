// Tests for iterate/no-shouting-constants: a module-scope SCREAMING_SNAKE
// const that holds a plain literal and is read once is an indirection the
// reader has to chase — the literal belongs inline at its use site. Each row
// runs the real oxlint binary against a temp project with the plugin armed.

import { expect, test } from "vitest";
import { lintOne } from "./oxlint-fixture.ts";

test.for([
  {
    name: "flags single-use number, string, template and negative-number consts",
    source: `
      const MAX_BYTES = 1_000_000;
      const GREETING = "hello";
      const LABEL = \`plain template\`;
      const FLOOR = -1;
      export const sizes = [MAX_BYTES, GREETING.length, LABEL.length, FLOOR];
    `,
    reports: ["MAX_BYTES", "GREETING", "LABEL", "FLOOR"],
  },
  {
    name: "leaves exported consts alone",
    source: `
      export const PUBLIC_LIMIT = 10;
      const REEXPORTED_LIMIT = 20;
      export { REEXPORTED_LIMIT };
      const DEFAULT_LIMIT = 30;
      export default DEFAULT_LIMIT;
      export const total = PUBLIC_LIMIT + REEXPORTED_LIMIT + DEFAULT_LIMIT;
    `,
    reports: [],
  },
  {
    name: "leaves non-literal initializers alone",
    source: `
      declare const region: string;
      const HEADERS = { accept: 'application/json' };
      const RETRY_DELAYS_MS = [100, 200];
      const IS_PROD = () => false;
      const SLUG_PATTERN = /^[a-z-]+$/;
      const HOST = \`https://\${region}.example\`;
      const MODE = "strict" as const;
      const STARTED_AT = Date.now();
      const SHARED = 5n;
      export const bag = [HEADERS, RETRY_DELAYS_MS, IS_PROD, SLUG_PATTERN, HOST, MODE, STARTED_AT, SHARED];
    `,
    reports: [],
  },
  {
    name: "leaves consts read more than once alone, counting typeof as a read",
    source: `
      const EVENT_TYPE = "events.example/thing-happened";
      export const first = { type: EVENT_TYPE };
      export const second = { type: EVENT_TYPE };
      const MODE = "strict";
      export type Mode = typeof MODE;
      export const mode = MODE;
    `,
    reports: [],
  },
  {
    name: "a JSDoc block above the const is an escape hatch; a line comment is not",
    source: `
      /** workerd rejects settlements above this size; see the isolate limits doc. */
      const MAX_SETTLEMENT_BYTES = 1_000_000;
      // this one is just a note
      const MAX_SCRIPT_BYTES = 200_000;
      export const limits = [MAX_SETTLEMENT_BYTES, MAX_SCRIPT_BYTES];
    `,
    reports: ["MAX_SCRIPT_BYTES"],
  },
  {
    name: "only module-scope SCREAMING_SNAKE names are in scope",
    source: `
      const maxBytes = 1_000_000;
      const MaxBytes = 2_000_000;
      export function limit() {
        const LOCAL_LIMIT = 3;
        return maxBytes + MaxBytes + LOCAL_LIMIT;
      }
    `,
    reports: [],
  },
])("$name", ({ source, reports }) => {
  const { messages } = lintOne("no-shouting-constants", "input.ts", source);
  expect(messages).toEqual(
    reports.map((name) =>
      expect.stringContaining(
        `${name} is a SCREAMING_SNAKE constant holding a plain literal that is used once. ` +
          "Write the literal inline at its use site",
      ),
    ),
  );
});
