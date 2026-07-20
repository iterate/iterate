import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// Page worker only. The stateful /api entry lives in todos-app.ts so waking a
// todo Durable Object never has to load the TanStack server-rendering bundle.

export default createServerEntry({
  fetch(request) {
    return handler.fetch(request);
  },
});
