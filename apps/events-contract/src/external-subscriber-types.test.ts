import assert from "node:assert/strict";
import {
  ExternalSubscriber,
  HtmlRendererConfiguredEventInput,
  StreamState,
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

function testLegacyCallbackUrlSubscriptionInputNormalizesToCallable() {
  const parsed = StreamSubscriptionConfiguredEventInput.parse({
    type: "events.iterate.com/core/subscription-configured",
    payload: {
      slug: "agent",
      type: "websocket",
      callbackUrl: "wss://agents.example.com/socket?streamPath=%2Fdemo",
    },
  });

  assert.deepEqual(parsed.payload, {
    slug: "agent",
    type: "websocket",
    callable: fetchCallable("https://agents.example.com/socket?streamPath=%2Fdemo"),
  });
}

function testLegacyCallbackUrlStreamStateNormalizesPersistedSubscribers() {
  const parsed = StreamState.parse({
    projectSlug: "public",
    path: "/legacy",
    eventCount: 4,
    childPaths: [],
    metadata: {},
    processors: {
      "circuit-breaker": {
        paused: false,
        pauseReason: null,
        pausedAt: null,
        config: {
          burstCapacity: 500,
          refillRatePerMinute: 500,
        },
        availableTokens: 100,
        lastRefillAtMs: null,
      },
      "external-subscriber": {
        subscribersBySlug: {
          agent: {
            slug: "agent",
            type: "websocket",
            callbackUrl: "ws://localhost:8788/socket?streamPath=%2Flegacy",
          },
        },
      },
    },
  });

  assert.deepEqual(parsed.processors["external-subscriber"].subscribersBySlug.agent, {
    slug: "agent",
    type: "websocket",
    callable: fetchCallable("http://localhost:8788/socket?streamPath=%2Flegacy"),
  });
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
await testLegacyCallbackUrlSubscriptionInputNormalizesToCallable();
await testLegacyCallbackUrlStreamStateNormalizesPersistedSubscribers();
await testValidHtmlRendererConfigParses();
await testInvalidHtmlRendererMatcherFailsFast();

function fetchCallable(url: string) {
  return {
    type: "fetch" as const,
    via: { type: "url" as const, url },
  };
}
