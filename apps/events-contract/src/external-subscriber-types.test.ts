import assert from "node:assert/strict";
import {
  ExternalSubscriber,
  JsonataTransformerConfiguredEventInput,
  StreamSubscriptionConfiguredEventInput,
} from "./index.ts";

function testValidExternalSubscriberJsonataExpressionsParse() {
  const parsed = ExternalSubscriber.parse({
    slug: "audit",
    type: "webhook",
    callbackUrl: "https://example.com/hook",
    jsonataFilter: "type = 'ping'",
    jsonataTransform: '{"kind":"hook","value":payload.value}',
  });

  assert.equal(parsed.slug, "audit");
  assert.equal(parsed.type, "webhook");
}

function testInvalidExternalSubscriberJsonataExpressionsFailFast() {
  const parsed = StreamSubscriptionConfiguredEventInput.safeParse({
    type: "https://events.iterate.com/events/stream/subscription/configured",
    payload: {
      slug: "audit",
      type: "webhook",
      callbackUrl: "https://example.com/hook",
      jsonataFilter: "{",
    },
  });

  assert.equal(parsed.success, false);
}

function testInvalidJsonataTransformerExpressionsFailFast() {
  const parsed = JsonataTransformerConfiguredEventInput.safeParse({
    type: "https://events.iterate.com/events/stream/jsonata-transformer-configured",
    payload: {
      slug: "fanout",
      matcher: "type = ",
      transform: '{"kind":"copy"}',
    },
  });

  assert.equal(parsed.success, false);
}

await testValidExternalSubscriberJsonataExpressionsParse();
await testInvalidExternalSubscriberJsonataExpressionsFailFast();
await testInvalidJsonataTransformerExpressionsFailFast();
