// Best practices here:
// https://posthog.com/docs/libraries/cloudflare-workers

import type { GenericMessageEvent } from "@slack/types";
import { PostHog } from "posthog-node";

const publicApiKey = process.env.POSTHOG_PUBLIC_KEY;

type BotProfile = Exclude<GenericMessageEvent["bot_profile"], undefined>;

export function createRawPosthogCloudflareClient() {
  return new PostHog(publicApiKey!, {
    // Tip: user webhook.site as the host to test out events without all the noise
    // host: "https://webhook.site/????",
    host: "https://eu.i.posthog.com",
    disabled: !publicApiKey,
    flushAt: 1,
    flushInterval: 0,
  });
}

/**
 * Used for human users
 */
type IdentityUser = {
  type: "user";
  email: string | null;
};

/**
 * Used for our own agent
 */
type IdentityAgent = {
  type: "agent";
  slackBotProfile?: BotProfile;
};

/**
 * Used for 3rd party bots (never our own agent)
 */
type IdentityBot = {
  type: "bot";
  name: string;
  slackBotProfile: BotProfile;
};

export type Identity = IdentityUser | IdentityAgent | IdentityBot;

export class PosthogCloudflare<
  TEvents extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
> {
  private readonly ctx: { waitUntil: (promise: Promise<void>) => void };
  readonly client: PostHog;
  readonly estateMeta: { estateName: string; environmentName: string };

  constructor(
    ctx: { waitUntil: (promise: Promise<void>) => void },
    estateMeta: { estateName: string; environmentName: string },
    client = createRawPosthogCloudflareClient(),
  ) {
    this.ctx = ctx;
    this.client = client;
    this.estateMeta = estateMeta;

    this.client.groupIdentify({
      groupType: "estate",
      groupKey: estateMeta.estateName,
      properties: {
        environment: estateMeta.environmentName,
      },
    });
  }

  identify(internalUserId: string, properties: IdentityAgent | IdentityUser | IdentityBot) {
    // `name` and `email` are special properties which get picked up as the UI label for a Person profile
    // This helps us identify agents/bots more clearly
    const name = properties.type === "agent" ? `Agent on ${this.estateMeta.estateName}` : undefined;

    this.ctx.waitUntil(
      this.client.identifyImmediate({
        distinctId: internalUserId,
        properties: {
          name,
          ...this.estateMeta,
          ...properties,
        },
      }),
    );
  }

  track<TEvent extends keyof TEvents>({
    event,
    distinctId,
    properties,
  }: {
    event: TEvent;
    distinctId: string;
    properties: TEvents[TEvent];
  }) {
    this.ctx.waitUntil(
      this.client.captureImmediate({
        event: String(event),
        distinctId,
        properties: {
          ...properties,
          ...this.estateMeta,
        },
        groups: {
          estate: this.estateMeta.estateName,
        },
      }),
    );
  }

  /**
   * Must be called by the end of worker fetch so events can flush
   */
  shutdown() {
    this.ctx.waitUntil(this.client.shutdown());
  }
}

export const SELF_AGENT_DISTINCT_ID = (estateName: string) => `AGENT[${estateName}]`;
