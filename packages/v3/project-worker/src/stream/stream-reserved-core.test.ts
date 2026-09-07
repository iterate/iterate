// stream-reserved-core.test.ts — RESERVE `core` at the append door (wave-0 4A, v4 §2.4). `core` is
// the always-on core reduce, addressable as a facet but never a configurable SUBSCRIPTION; v3 guards
// it at the facet doors only, so a RAW `subscription-configured { name: "core" }` (bypassing them)
// would install an undeliverable row that climbs the retry ladder to a halt. The append door now
// refuses it, coded, before it lands.

import { expect, test } from "vitest";
import { errorCode } from "../lib/errors.ts";
import { nodeSqliteDurableObjectStorage } from "./node-sqlite-durable-object-storage.ts";
import { Stream } from "./stream.ts";

const newStream = () =>
  new Stream({
    storage: nodeSqliteDurableObjectStorage(),
    path: "/",
    projectId: "prj_reserved_core",
    onCommit: () => {},
  });

const CONFIGURED = "events.iterate.com/stream/subscription-configured";

test("a raw subscription-configured named `core` is refused at the append door, coded, nothing lands", () => {
  const stream = newStream();
  const headBefore = stream.highestDurableOffset();
  let code: string | undefined;
  try {
    stream.append({ type: CONFIGURED, payload: { name: "core", target: ["itx", "builtins", "kv"] } });
  } catch (error) {
    code = errorCode(error);
  }
  expect(code).toBe("RESERVED_SUBSCRIPTION_NAME");
  expect(stream.highestDurableOffset()).toBe(headBefore); // the transaction rolled back — nothing burned
});

test("a subscription-configured for any OTHER name still lands (the guard is `core`-only)", () => {
  const stream = newStream();
  const [event] = stream.append({
    type: CONFIGURED,
    payload: { name: "presence", target: ["itx", "facets", ["get", "presence"], "processEventBatch"] },
  });
  expect(event.offset).toBeGreaterThan(0);
});
