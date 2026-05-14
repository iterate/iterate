import app1 from "./apps/app1/worker.ts";
import app2 from "./apps/app2/worker.ts";

const apps = [app1, app2];

export default {
  async fetch(request) {
    for (const app of apps) {
      const response = await app.fetch(request);
      if (response) return response;
    }

    return new Response("Hello from the project config worker");
  },

  async afterAppend({ event }) {
    console.log("Project config worker afterAppend", event.type);
  },
};
