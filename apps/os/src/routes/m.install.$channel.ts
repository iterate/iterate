import { createFileRoute } from "@tanstack/react-router";
import { handleInstallPageRequest } from "../domains/mobile/channel-status.ts";
import { itxEnv } from "../env.ts";

/**
 * The "native build installer that always works": QR codes on PR bodies and
 * commit comments encode this channel-stable URL, and it resolves the
 * channel's expected native build at scan time from the CI-pushed snapshot.
 * Logic + tests: domains/mobile/channel-status.ts.
 */
export const Route = createFileRoute("/m/install/$channel")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleInstallPageRequest({
          bucket: itxEnv.FILES_BUCKET,
          channel: params.channel,
          origin: new URL(request.url).origin,
        }),
    },
  },
});
