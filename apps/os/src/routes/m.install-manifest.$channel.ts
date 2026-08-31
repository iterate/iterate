import { createFileRoute } from "@tanstack/react-router";
import { handleInstallManifestRequest } from "../domains/mobile/channel-status.ts";
import { itxEnv } from "../env.ts";

/**
 * The itms-services manifest behind /m/install/<channel>'s Install button:
 * iOS fetches this plist and installs the channel's expected build to the
 * home screen without leaving the page. Logic + tests:
 * domains/mobile/channel-status.ts.
 */
export const Route = createFileRoute("/m/install-manifest/$channel")({
  server: {
    handlers: {
      GET: ({ params }) =>
        handleInstallManifestRequest({ bucket: itxEnv.FILES_BUCKET, channel: params.channel }),
    },
  },
});
