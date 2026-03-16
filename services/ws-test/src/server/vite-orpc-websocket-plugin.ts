import type { Server as HttpServer } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import { attachOrpcWebSocketServer } from "./orpc.ts";

export function viteOrpcWebSocketPlugin(): Plugin {
  return {
    name: "orpc-websocket-dev-server",
    configureServer(server: ViteDevServer) {
      let detach: (() => void) | null = null;

      server.httpServer?.once("listening", () => {
        if (!server.httpServer || detach) {
          return;
        }

        detach = attachOrpcWebSocketServer(server.httpServer as HttpServer);
      });

      server.httpServer?.once("close", () => {
        detach?.();
        detach = null;
      });
    },
  };
}
