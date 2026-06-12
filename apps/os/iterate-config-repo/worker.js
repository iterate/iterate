import app1 from "./apps/app1/worker.js";
import app2 from "./apps/app2/worker.js";
import webhooks from "./apps/webhooks/worker.js";
import waitroseApp, { connectWaitrose } from "./apps/waitrose/worker.js";

const apps = [app1, app2, webhooks, waitroseApp];

export default {
  async fetch(request, env) {
    for (const app of apps) {
      const response = await app.fetch(request, env);
      if (response) return response;
    }

    return new Response("Hello from the project config worker");
  },

  // USERSPACE integrations: itx.integrations.<slug>.<method>(...) calls that
  // the platform registry doesn't recognize land here as ONE call. Apps
  // export `integrations: { <slug>: sdkObject }` — or, for multi-ACCOUNT
  // integrations (the instance dimension: itx.integrations["waitrose/mum"]),
  // a factory `(account) => sdkObject`. The path walks the sdk locally
  // (where it is concrete) and calls the terminal method.
  async integrations({ slug, account = "default", path, args }) {
    for (const app of apps) {
      const entry = app.integrations?.[slug];
      if (!entry) continue;
      const sdk = typeof entry === "function" ? entry(account) : entry;
      let parent = sdk;
      for (const segment of path.slice(0, -1)) parent = parent?.[segment];
      const method = path.at(-1);
      if (typeof parent?.[method] !== "function") {
        throw new Error(`Integration "${slug}" has no method "${path.join(".")}".`);
      }
      return await parent[method](...args);
    }
    throw new Error(`No userspace integration named "${slug}" in this project.`);
  },

  // Connect flows are ordinary worker exports:
  // itx.worker.connectWaitrose({ username, password })
  connectWaitrose,

  // The config worker is a stream processor: processEvent receives every
  // event committed to the project root stream ("/"), in order. React to
  // facts by appending facts — e.g. customize every new agent in this project
  // by watching for its stream to be created and appending your own context
  // events (the last system-prompt-updated wins; platform defaults yield to
  // yours):
  async processEvent({ event, streamPath }) {
    console.log("Project config worker processEvent", streamPath, event.type);
  },

  // async processEvent({ event }, env) {
  //   if (event.type !== "events.iterate.com/stream/child-stream-created") return;
  //   const agentPath = event.payload.childPath;
  //   if (!agentPath.startsWith("/agents/")) return;
  //   await env.STREAMS.append({
  //     streamPath: agentPath,
  //     event: {
  //       type: "events.iterate.com/agent/system-prompt-updated",
  //       payload: { systemPrompt: "You are this project's agent. ..." },
  //     },
  //   });
  //   await env.STREAMS.append({
  //     streamPath: agentPath,
  //     event: {
  //       type: "events.iterate.com/agent/capability-noted",
  //       payload: { name: "worker.myTool", instructions: "Use itx.worker.myTool({ ... }) to ..." },
  //     },
  //   });
  // },
};
