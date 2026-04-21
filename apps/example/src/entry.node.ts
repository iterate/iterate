import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { createNodeAppContext, config, manifest } from "~/node-runtime.ts";

export default {
  async fetch(request: Request) {
    return withEvlog(
      {
        request,
        manifest,
        config,
      },
      async ({ log }) => {
        return handler.fetch(request, {
          context: createNodeAppContext({ request, log }),
        });
      },
    );
  },
};
