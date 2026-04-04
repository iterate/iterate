import assert from "node:assert/strict";
import type { ContractRouterClient } from "@orpc/contract";
import { z } from "zod";
import { AppendInput, eventsContract } from "./orpc-contract.ts";
import {
  EventInput,
  InvalidEventAppendedEventInput,
  StreamMetadataUpdatedEventInput,
  StreamPath,
} from "./types.ts";

type EventsContractClient = ContractRouterClient<typeof eventsContract>;
type ClientAppendArgs = Parameters<EventsContractClient["append"]>[0];
type AppendArgs = z.input<typeof AppendInput>;

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Assert<T extends true> = T;

const examplePath = StreamPath.parse("/type-tests");

type _appendArgsMatchPublicShape = Assert<
  IsAssignable<
    {
      path: z.infer<typeof StreamPath>;
      event: EventInput;
    },
    AppendArgs
  >
>;

const builtInEvent: AppendArgs = {
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/stream/metadata-updated",
    payload: {
      metadata: {
        source: "type-test",
      },
    },
  },
};

const genericEvent: AppendArgs = {
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/example/value-recorded",
    payload: {
      value: 42,
    },
  },
};

void builtInEvent;
void genericEvent;

const clientBuiltInEvent: ClientAppendArgs = {
  path: examplePath,
  event: builtInEvent.event,
};

void clientBuiltInEvent;

assert.equal(
  EventInput.safeParse({
    type: "https://events.iterate.com/events/example/value-recorded",
    payload: "not-an-object",
  }).success,
  false,
);

assert.equal(
  EventInput.safeParse({
    type: "https://events.iterate.com/events/example/value-recorded",
    payload: {
      value: 1,
    },
    extra: true,
  }).success,
  false,
);

const parsedBuiltIn = AppendInput.parse({
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/stream/metadata-updated",
    payload: {
      metadata: {
        owner: "jonas",
      },
    },
  },
});

assert.deepEqual(parsedBuiltIn, {
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/stream/metadata-updated",
    payload: {
      metadata: {
        owner: "jonas",
      },
    },
  },
});

const parsedUnknownEvent = AppendInput.parse({
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/example/unknown-to-the-contract",
    payload: {
      value: 1,
    },
  },
});

assert.deepEqual(parsedUnknownEvent, {
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/example/unknown-to-the-contract",
    payload: {
      value: 1,
    },
  },
});

const malformedBuiltIn = InvalidEventAppendedEventInput.parse(
  AppendInput.parse({
    path: examplePath,
    event: {
      type: "https://events.iterate.com/events/stream/metadata-updated",
      payload: "not-an-object",
    },
  }).event,
);

assert.equal(
  malformedBuiltIn.type,
  "https://events.iterate.com/events/stream/invalid-event-appended",
);
assert.deepEqual(malformedBuiltIn.payload.rawInput, {
  type: "https://events.iterate.com/events/stream/metadata-updated",
  payload: "not-an-object",
});
const malformedBuiltInError = malformedBuiltIn.payload.error;
if (typeof malformedBuiltInError !== "string") {
  throw new Error("malformedBuiltIn.payload.error should be a string");
}
assert.match(malformedBuiltInError, /payload/i);
assert.match(malformedBuiltInError, /expected object/i);
assert.doesNotMatch(
  malformedBuiltInError,
  /Built-in event types must use their built-in payload schema/i,
);

assert.equal(
  StreamMetadataUpdatedEventInput.safeParse({
    type: "https://events.iterate.com/events/stream/metadata-updated",
    payload: {
      metadata: {},
    },
    extra: true,
  }).success,
  false,
);

const malformedArray = InvalidEventAppendedEventInput.parse(
  AppendInput.parse({
    path: examplePath,
    event: ["weird", { posted: true }],
  }).event,
);

assert.equal(
  malformedArray.type,
  "https://events.iterate.com/events/stream/invalid-event-appended",
);
assert.deepEqual(malformedArray.payload.rawInput, ["weird", { posted: true }]);
const malformedArrayError = malformedArray.payload.error;
if (typeof malformedArrayError !== "string") {
  throw new Error("malformedArray.payload.error should be a string");
}
assert.match(malformedArrayError, /expected object/);

const malformedNestedNonJsonValues = InvalidEventAppendedEventInput.parse(
  AppendInput.parse({
    path: examplePath,
    event: {
      type: "https://events.iterate.com/events/example/unknown-to-the-contract",
      payload: {
        nested: [1, BigInt(2), { fn: () => "nope", deeper: [BigInt(3), undefined] }],
      },
    },
  }).event,
);

assert.equal(
  malformedNestedNonJsonValues.type,
  "https://events.iterate.com/events/stream/invalid-event-appended",
);
assert.deepEqual(malformedNestedNonJsonValues.payload.rawInput, {
  type: "https://events.iterate.com/events/example/unknown-to-the-contract",
  payload: {
    nested: [1, null, { fn: null, deeper: [null, null] }],
  },
});

const streamInitializedEvent = AppendInput.parse({
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/stream/initialized",
    payload: { projectSlug: "public", path: examplePath },
  },
});

assert.deepEqual(streamInitializedEvent.event.payload, {
  projectSlug: "public",
  path: examplePath,
});

const streamDurableObjectConstructedEvent = AppendInput.parse({
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/stream/durable-object-constructed",
    payload: {},
  },
});

assert.deepEqual(streamDurableObjectConstructedEvent.event.payload, {});

console.log("events-contract append client typing and runtime normalization checks passed");
