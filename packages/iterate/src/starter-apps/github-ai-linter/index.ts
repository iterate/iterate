import type { ItxBinding, StreamEvent } from "../../sdk.ts";
import { reviewBotSubscriptionEvent, type GithubAiLinterConfig } from "./worker-ref.ts";

export type { GithubAiLinterConfig } from "./worker-ref.ts";

export const GithubAiLinter = {
  create(env: { ITX: ItxBinding }, config: GithubAiLinterConfig) {
    return {
      async processEvent(event: StreamEvent) {
        const linkedConnection =
          event.type === "events.iterate.com/repo/github-link-configured"
            ? event.payload?.connection
            : undefined;
        if (
          event.type === "events.iterate.com/repo/github-link-configured" &&
          (typeof linkedConnection !== "string" || linkedConnection.length === 0)
        ) {
          return;
        }
        if (
          event.type !== "events.iterate.com/repo/github-link-configured" &&
          (event.type !== "events.iterate.com/project/worker-updated" || event.path !== "/")
        ) {
          return;
        }

        using itx = await env.ITX.get();
        let connections: string[];
        if (typeof linkedConnection === "string") {
          connections = [linkedConnection];
        } else {
          const repos = await itx.repos.list();
          const links = await Promise.all(
            repos.map(
              async ({ path }) => (await itx.repos.get(path).processor.snapshot()).state.github,
            ),
          );
          connections = links.flatMap((link) => (link === null ? [] : [link.connection]));
        }
        await Promise.all(
          [...new Set(connections)].map(async (connection) => {
            await itx.streams
              .get(`/integrations/github/${connection}`)
              .append(await reviewBotSubscriptionEvent(event, connection, config));
          }),
        );
      },
    };
  },
};
