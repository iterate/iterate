import app1 from "./apps/app1/worker.js";
import app2 from "./apps/app2/worker.js";
import webhooks from "./apps/webhooks/worker.js";

const apps = [app1, app2, webhooks];

export default {
  async fetch(request, env) {
    for (const app of apps) {
      const response = await app.fetch(request, env);
      if (response) return response;
    }

    return new Response("Hello from the project config worker");
  },

  // The project worker is a stream processor: processEvent receives every
  // event committed to the project root stream ("/"), in order. React to
  // project facts here when you want customer-specific behavior.
  async processEvent({ event, streamPath }) {
    console.log("Project worker processEvent", streamPath, event.type);
  },
};
