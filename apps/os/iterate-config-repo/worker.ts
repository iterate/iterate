import { IterateProjectEntrypoint, type IterateProjectEventInput } from "iterate/worker";
import app1 from "./apps/app1/worker.ts";
import app2 from "./apps/app2/worker.ts";
import webhooks from "./apps/webhooks/worker.ts";

const apps = [app1, app2, webhooks];

export default class ProjectWorker extends IterateProjectEntrypoint {
  async fetch(request: Request) {
    for (const app of apps) {
      const response = await app.fetch(request, this.env);
      if (response) return response;
    }

    return new Response("Hello from the project worker");
  }

  // The project worker is a stream processor: onProjectEvent receives every
  // event committed to the project root stream ("/"), in order. React to
  // project facts here when you want customer-specific behavior.
  protected override async onProjectEvent({ event, streamPath }: IterateProjectEventInput) {
    console.log("Project worker event", streamPath, eventType(event));
  }
}

function eventType(event: unknown) {
  if (!event || typeof event !== "object" || !("type" in event)) return "unknown";
  return String(event.type);
}
