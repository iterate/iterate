import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { appServerEntry } from "@iterate-com/ui/apps/server";
import { issuerAnswersAt } from "iterate/app-server";
import { deviceClientMetadata } from "./firmware/device-client.ts";
import { proxyFirmwareFile } from "./firmware/firmware-proxy.ts";
import { deviceAuth } from "./device-auth.ts";
export { BrowserSession } from "iterate/app-session";

/** Kit has no OAuth client of its own: every device is one (device-auth.ts), whose sign-in also
 *  answers the gate's `/.auth/login` and `/.auth/connect`. */
export default createServerEntry(
  appServerEntry(handler, {
    async before(request, config) {
      // Firmware release files are public: esp-web-tools fetches them from the page (firmware-proxy.ts).
      const firmware = await proxyFirmwareFile(request, fetch);
      if (firmware) return firmware;
      return (
        deviceClientMetadata(new URL(request.url)) ??
        deviceAuth(
          request,
          {
            sessions: env.BROWSER_SESSION,
            defaultIssuer: config.urls.os,
            denyZones: config.denyZones,
          },
          { issuerAnswersAt },
        )
      );
    },
  }),
);
