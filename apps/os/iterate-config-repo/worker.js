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
