import assert from "node:assert/strict";
import {
  ExternalSubscriber,
  HtmlRendererConfiguredEventInput,
  StreamSubscriptionConfiguredEventInput,
} from "./index.ts";

function testValidExternalSubscriberJsonataExpressionsParse() {
  const parsed = ExternalSubscriber.parse({
    slug: "audit",
    type: "webhook",
    callable: fetchCallable("https://example.com/hook"),
    jsonataFilter: "type = 'ping'",
    jsonataTransform: '{"kind":"hook","value":payload.value}',
  });

  assert.equal(parsed.slug, "audit");
  assert.equal(parsed.type, "webhook");
}

function testInvalidExternalSubscriberJsonataExpressionsFailFast() {
  const parsed = StreamSubscriptionConfiguredEventInput.safeParse({
    type: "events.iterate.com/core/subscription-configured",
    payload: {
      slug: "audit",
      type: "webhook",
      callable: fetchCallable("https://example.com/hook"),
      jsonataFilter: "{",
    },
  });

  assert.equal(parsed.success, false);
}

function testValidHtmlRendererConfigParses() {
  const parsed = HtmlRendererConfiguredEventInput.parse({
    type: "events.iterate.com/core/html-renderer-configured",
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
    type: "events.iterate.com/core/html-renderer-configured",
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
await testValidHtmlRendererConfigParses();
await testInvalidHtmlRendererMatcherFailsFast();

function fetchCallable(url: string) {
  return {
    type: "fetch" as const,
    via: { type: "url" as const, url },
  };
}
