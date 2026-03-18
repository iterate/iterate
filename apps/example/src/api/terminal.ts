import type { AppWebSocketEvents } from "@iterate-com/shared/apps/define-app";

export interface ExampleTerminalDep {
  createWebSocketEvents(options: { request: Request }): AppWebSocketEvents;
}

export function createNotImplementedTerminalDep(message: string): ExampleTerminalDep {
  return {
    createWebSocketEvents() {
      let sent = false;

      return {
        onMessage(_event, ws) {
          if (sent) return;
          sent = true;
          ws.send(`\r\n${message}\r\n`);
          ws.close(4000, "Terminal not implemented");
        },
      };
    },
  };
}
