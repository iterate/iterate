import { test as base } from "@playwright/test";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  cloudflareWorkerVersionOverrideHeaders,
} from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";

export { expect } from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use) => {
    if (Object.keys(cloudflareWorkerVersionOverrideHeaders(process.env)).length) {
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          await route.continue();
          return;
        }

        const frame = !request.serviceWorker() ? request.frame() : null;
        const sameOrigin = !!frame && new URL(request.url()).origin === new URL(frame.url()).origin;
        if (sameOrigin) {
          await route.continue();
          return;
        }

        const headers = request.headers();
        delete headers[CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER.toLowerCase()];
        await route.continue({ headers });
      });
    }
    await use(context);
  },
});
