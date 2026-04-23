import handler from "./server-entry.js";

export class App {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      return await handler.fetch(request);
    } catch (err) {
      console.error("[Facet] error:", err.message, err.stack);
      return new Response("Error: " + err.message, { status: 500 });
    }
  }
}
