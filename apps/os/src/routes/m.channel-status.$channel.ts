import { createFileRoute } from "@tanstack/react-router";
import { handleChannelStatusRequest } from "../domains/mobile/channel-status.ts";
import { itxEnv } from "../env.ts";

/**
 * Mobile channel status: GET is public JSON (the app's "does this channel's
 * latest JS need a different native build?" check); PUT/DELETE are the CI
 * writers, admin-bearer-authenticated. Logic + tests:
 * domains/mobile/channel-status.ts.
 */
export const Route = createFileRoute("/m/channel-status/$channel")({
  server: {
    handlers: {
      GET: ({ params, request, context }) =>
        handleChannelStatusRequest({
          bucket: itxEnv.FILES_BUCKET,
          channel: params.channel,
          config: context.config,
          request,
        }),
      PUT: ({ params, request, context }) =>
        handleChannelStatusRequest({
          bucket: itxEnv.FILES_BUCKET,
          channel: params.channel,
          config: context.config,
          request,
        }),
      DELETE: ({ params, request, context }) =>
        handleChannelStatusRequest({
          bucket: itxEnv.FILES_BUCKET,
          channel: params.channel,
          config: context.config,
          request,
        }),
    },
  },
});
