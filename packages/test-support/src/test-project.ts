import type { Project } from "iterate/node";
import type { RpcStub } from "capnweb";
import { codemodeBackticksResponse } from "./resilient-ai-interceptor.ts";

/** Intercept from birth; scripts that need a reply replace the background handler. */
export async function createProject(
  project: RpcStub<Project>,
  args: NonNullable<Parameters<Project["create"]>[0]> = {},
) {
  const created = await project.create({
    ...args,
    aiPolicy: args.aiPolicy || { liveAgentPaths: [] },
  });
  await installNoOpAgent(created);
  return created;
}

/** A durable responder keeps ordinary test sessions usable across stream eviction. */
export async function installNoOpAgent(project: Pick<RpcStub<Project>, "provideCapability">) {
  const body = await codemodeBackticksResponse("async () => {}", {
    request: { body: {} },
  }).text();
  await project.provideCapability({
    path: ["aiInterceptor"],
    type: "itx-call",
    expression: [
      "workers",
      [
        "get",
        {
          type: "stateless",
          path: "/",
          source: {
            createWorker: {
              bundle: false,
              entryPoint: "interceptor.js",
              files: {
                type: "inline",
                files: {
                  "interceptor.js": `
                    import { WorkerEntrypoint } from "cloudflare:workers";
                    export default class extends WorkerEntrypoint {
                      respond(call) {
                        if (call.source !== "agent-turn") {
                          throw new Error("Test must script its " + call.source + " response (" + call.model + ")");
                        }
                        return new Response(${JSON.stringify(body)}, {
                          headers: { "content-type": "text/event-stream" },
                        });
                      }
                    }
                  `,
                },
              },
            },
          },
        },
      ],
      "respond",
    ],
  });
}
