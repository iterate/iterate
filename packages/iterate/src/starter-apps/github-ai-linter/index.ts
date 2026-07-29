import type { ItxBinding, StreamEvent } from "../../sdk.ts";
import { reviewBotSubscriptionEvent, type GithubAiLinterConfig } from "./worker-ref.ts";

export type { GithubAiLinterConfig } from "./worker-ref.ts";

export const GithubAiLinter = {
  create(env: { ITX: ItxBinding }, config: GithubAiLinterConfig) {
    return {
      async processEvent(event: StreamEvent) {
        if (event.type !== "events.iterate.com/repo/github-link-configured") return;
        const connection = event.payload?.connection;
        if (typeof connection !== "string" || connection.length === 0) return;
        using itx = await env.ITX.get();
        await itx.streams
          .get(`/integrations/github/${connection}`)
          .append(await reviewBotSubscriptionEvent(event, connection, config));
      },
    };
  },
};
