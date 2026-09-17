import type { Project } from "iterate/node";
import type { RpcStub } from "capnweb";
import { codemodeBackticksResponse } from "./resilient-ai-interceptor.ts";

/** Set up the project's own configuration; no production model-selection override. */
export async function createProject(
  project: RpcStub<Project>,
  args: NonNullable<Parameters<Project["create"]>[0]> = {},
) {
  const created = await project.create(args, { waitUntilCreated: false });
  await configureOnboarding(created);
  await created.waitUntilCreated();
  await configureAgentModels(created);
  return created;
}

/** Configure the known proactive caller while the project template is still bootstrapping. */
export async function configureOnboarding(project: any) {
  await project.capabilityHost.create();
  await installNoOpAgent(project);
  const onboarding = project.agents.get("/agents/onboarding");
  await onboarding.create();
  await onboarding.append({
    type: "events.iterate.com/agent/configured",
    payload: {
      config: { llm: { model: "intercepted/openai/gpt-5.6-terra" }, llmRequestDebounceMs: 250 },
    },
  });
}

/** Edit only this fixture's config repo, using the normal newborn configuration event. */
export async function configureAgentModels(project: any) {
  const worker = await project.repo.readFile({ path: "worker.ts" });
  if (!worker) throw new Error("Test project has no worker.ts");
  const original = "payload: { config: { llmRequestDebounceMs: 250 } },";
  const configured =
    'payload: { config: { llm: { model: "intercepted/openai/gpt-5.6-terra" }, llmRequestDebounceMs: 250 } },';
  if (worker.content.includes(configured)) return;
  if (!worker.content.includes(original))
    throw new Error("Test template has no expected agent birth configuration");
  await project.repo.commitFiles({
    message: "Configure intercepted models for this test project",
    changes: [{ path: "worker.ts", content: worker.content.replace(original, configured) }],
  });
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
