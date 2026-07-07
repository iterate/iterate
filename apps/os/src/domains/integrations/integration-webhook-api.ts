// The integration webhook door: dispatches inbound HTTP to each integration's
// own imperative fetch handler. Served by the API worker (it carries the engine
// bindings, so a handler routes straight into a project's stream — no capnweb
// round trip). There is deliberately NO webhook framework here: each
// integration's fetch does whatever that provider needs (verify however it
// likes, own its sub-paths, stick things on a stream or not) and returns a
// Response, or null when the path isn't its concern. Adding an integration with
// inbound HTTP is one more handler in this chain.

import { fetchGithubWebhook } from "./github-webhook.ts";
import { fetchSlackWebhook } from "./slack-webhook.ts";
import type { AppConfig } from "~/config.ts";

type IntegrationWebhookFetch = (input: {
  config: AppConfig;
  request: Request;
}) => Promise<Response | null>;

const WEBHOOK_HANDLERS: IntegrationWebhookFetch[] = [fetchSlackWebhook, fetchGithubWebhook];

/** Serve one request if any integration claims it; null means "not a webhook". */
export async function handleIntegrationWebhookApiRequest(input: {
  config: AppConfig;
  request: Request;
}): Promise<Response | null> {
  for (const handler of WEBHOOK_HANDLERS) {
    const response = await handler(input);
    if (response !== null) return response;
  }
  return null;
}
