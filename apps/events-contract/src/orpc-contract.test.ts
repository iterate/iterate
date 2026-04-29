import assert from "node:assert/strict";
import type { ContractRouterClient } from "@orpc/contract";
import { z } from "zod";
import { AppendInput, eventsContract } from "./orpc-contract.ts";
import {
  EventInput,
  InvalidEventAppendedEventInput,
  StreamQuery,
  StreamMetadataUpdatedEventInput,
  StreamPath,
} from "./types.ts";

type EventsContractClient = ContractRouterClient<typeof eventsContract>;
type ClientAppendArgs = Parameters<EventsContractClient["append"]>[0];
type ClientStreamArgs = Parameters<EventsContractClient["stream"]>[0];
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
type _clientAppendArgsExposeTypedPath = Assert<
  IsAssignable<
    ClientAppendArgs,
    {
      path: z.infer<typeof StreamPath>;
      event: EventInput;
    }
  >
>;
type _clientStreamArgsExposeTypedCursors = Assert<
  IsAssignable<
    ClientStreamArgs,
    {
      path: z.infer<typeof StreamPath>;
      afterOffset?: z.infer<typeof StreamQuery>["afterOffset"];
      beforeOffset?: z.infer<typeof StreamQuery>["beforeOffset"];
    }
  >
>;

const builtInEvent: AppendArgs = {
  path: examplePath,
  event: {
    type: "events.iterate.com/core/metadata-updated",
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

assert.deepEqual(
  StreamQuery.parse({
    afterOffset: 1,
    beforeOffset: 2,
  }),
  {
    afterOffset: 1,
    beforeOffset: 2,
  },
);

assert.equal(
  StreamQuery.safeParse({
    after: 1,
    before: 2,
  }).success,
  false,
);

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
    type: "events.iterate.com/core/metadata-updated",
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
    type: "events.iterate.com/core/metadata-updated",
    payload: {
      metadata: {
        owner: "jonas",
      },
    },
  },
});

const parsedBuiltInWithGenericPayload = AppendInput.parse({
  path: examplePath,
  event: {
    type: "events.iterate.com/core/metadata-updated",
    payload: {
      owner: "jonas",
    },
  },
});

assert.deepEqual(parsedBuiltInWithGenericPayload.event.payload, {
  owner: "jonas",
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
      type: "events.iterate.com/core/metadata-updated",
      payload: "not-an-object",
    },
  }).event,
);

assert.equal(malformedBuiltIn.type, "events.iterate.com/core/invalid-event-appended");
assert.deepEqual(malformedBuiltIn.payload.rawInput, {
  type: "events.iterate.com/core/metadata-updated",
  payload: "not-an-object",
});
const malformedBuiltInError = malformedBuiltIn.payload.error;
if (typeof malformedBuiltInError !== "string") {
  throw new Error("malformedBuiltIn.payload.error should be a string");
}
assert.match(malformedBuiltInError, /payload/i);
assert.match(malformedBuiltInError, /Invalid input/i);
assert.doesNotMatch(
  malformedBuiltInError,
  /Built-in event types must use their built-in payload schema/i,
);

assert.equal(
  StreamMetadataUpdatedEventInput.safeParse({
    type: "events.iterate.com/core/metadata-updated",
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

assert.equal(malformedArray.type, "events.iterate.com/core/invalid-event-appended");
assert.deepEqual(malformedArray.payload.rawInput, ["weird", { posted: true }]);
const malformedArrayError = malformedArray.payload.error;
if (typeof malformedArrayError !== "string") {
  throw new Error("malformedArray.payload.error should be a string");
}
assert.match(malformedArrayError, /expected object/);

const malformedBareObject = InvalidEventAppendedEventInput.parse(
  AppendInput.parse({
    path: examplePath,
    event: {
      command: "/iterate",
      team_id: "T123",
      text: "deploy status",
    },
  }).event,
);

assert.equal(malformedBareObject.type, "events.iterate.com/core/invalid-event-appended");
assert.deepEqual(malformedBareObject.payload.rawInput, {
  command: "/iterate",
  team_id: "T123",
  text: "deploy status",
});

const nestedFn = () => "nope";
const genericEventWithNestedNonJsonValues = AppendInput.parse({
  path: examplePath,
  event: {
    type: "https://events.iterate.com/events/example/unknown-to-the-contract",
    payload: {
      nested: [1, BigInt(2), { fn: nestedFn, deeper: [BigInt(3), undefined] }],
    },
  },
}).event;

assert.equal(
  genericEventWithNestedNonJsonValues.type,
  "https://events.iterate.com/events/example/unknown-to-the-contract",
);
assert.equal(genericEventWithNestedNonJsonValues.payload.nested[1], BigInt(2));
assert.equal(genericEventWithNestedNonJsonValues.payload.nested[2].fn, nestedFn);
assert.equal(genericEventWithNestedNonJsonValues.payload.nested[2].deeper[0], BigInt(3));
assert.equal(genericEventWithNestedNonJsonValues.payload.nested[2].deeper[1], undefined);

const streamInitializedEvent = AppendInput.parse({
  path: examplePath,
  event: {
    type: "events.iterate.com/core/stream-first-initialized",
    payload: { projectSlug: "public", path: examplePath },
  },
});

assert.deepEqual(streamInitializedEvent.event.payload, {
  projectSlug: "public",
  path: examplePath,
});

const subscriptionConfiguredEvent = AppendInput.parse({
  path: examplePath,
  event: {
    type: "events.iterate.com/core/subscription-configured",
    payload: {
      slug: "audit",
      type: "webhook",
      callbackUrl: "https://example.com/hook",
      jsonataFilter: "type = 'source'",
      jsonataTransform: '{"kind":"hook"}',
    },
  },
});

assert.deepEqual(subscriptionConfiguredEvent.event.payload, {
  slug: "audit",
  type: "webhook",
  callbackUrl: "https://example.com/hook",
  jsonataFilter: "type = 'source'",
  jsonataTransform: '{"kind":"hook"}',
});

const streamDurableObjectWokeUpEvent = AppendInput.parse({
  path: examplePath,
  event: {
    type: "events.iterate.com/core/durable-object-woke-up",
    payload: {},
  },
});

assert.deepEqual(streamDurableObjectWokeUpEvent.event.payload, {});

const durableObjectWokeUpEvent = AppendInput.parse({
  path: examplePath,
  event: {
    type: "events.iterate.com/core/durable-object-woke-up",
    payload: {},
  },
});

assert.deepEqual(durableObjectWokeUpEvent.event.payload, {});

console.log("events-contract append client typing and runtime normalization checks passed");
