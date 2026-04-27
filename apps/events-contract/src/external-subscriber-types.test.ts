import assert from "node:assert/strict";
import {
  ExternalSubscriber,
  HtmlRendererConfiguredEventInput,
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

function testValidHtmlRendererConfigParses() {
  const parsed = HtmlRendererConfiguredEventInput.parse({
    type: "https://events.iterate.com/events/stream/html-renderer-configured",
    payload: {
      slug: "todo-card",
      matcher: "type = 'todo.created'",
      template: "<article>{{payload.title}}</article>",
    },
  });

  assert.equal(parsed.payload.slug, "todo-card");
}

function testInvalidHtmlRendererMatcherFailsFast() {
  const parsed = HtmlRendererConfiguredEventInput.safeParse({
    type: "https://events.iterate.com/events/stream/html-renderer-configured",
    payload: {
      slug: "todo-card",
      matcher: "type = ",
      template: "<article>{{payload.title}}</article>",
    },
  });

  assert.equal(parsed.success, false);
}

await testValidExternalSubscriberJsonataExpressionsParse();
await testInvalidExternalSubscriberJsonataExpressionsFailFast();
await testInvalidJsonataTransformerExpressionsFailFast();
await testValidHtmlRendererConfigParses();
await testInvalidHtmlRendererMatcherFailsFast();
