import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";

export default class VoiceProjectWorker extends IterateWorkerEntrypoint {
  protected override async processEvent(event: StreamEvent): Promise<void> {
    if (
      event.type === "events.iterate.com/agent/created" &&
      event.source?.copiedFrom === undefined
    ) {
      // The platform births agents with a high (10s) debounce — the window
      // for this worker to configure them before their first turn. This
      // template keeps the platform defaults, so lowering the debounce back
      // to the ordinary 250ms is its whole birth reaction; doing so also
      // releases a held first turn immediately.
      await this.itx.agents.get(event.path).append({
        type: "events.iterate.com/agent/configured",
        idempotencyKey: "iterate/config/agent-birth-configured:v1",
        payload: { config: { llmRequestDebounceMs: 250 } },
      });
      return;
    }
    if (event.type !== "events.iterate.com/project/created" || event.path !== "/") return;

    const instructions = await this.itx.repo.readFile({ path: "ONBOARDING.md" });
    if (instructions === null) {
      throw new Error("The voice template enables onboarding but ONBOARDING.md is missing.");
    }

    const onboardingAgent = this.itx.agents.get("/agents/onboarding");
    await onboardingAgent.create();
    await onboardingAgent.append(
      {
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: "iterate/config/onboarding-instructions:v1",
        payload: {
          role: "system",
          key: "config/onboarding-instructions",
          content: instructions.content,
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: "iterate/config/onboarding-start:v1",
        payload: {
          role: "developer",
          key: "config/onboarding-start",
          content:
            "Begin onboarding now. The project owner just created this voice project. Welcome them, then follow the onboarding instructions one question at a time.",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    );

    // Project creation can finish just before the creating tab mounts its
    // ordinary project client. Keep that race entirely in this template: for
    // eight seconds, look for an OS client whose browser capability is ready.
    // No client is a valid outcome (CLI/API-created projects have none).
    const clientDeadline = Date.now() + 8_000;
    let browserClientPaths: string[] = [];
    while (browserClientPaths.length === 0 && Date.now() < clientDeadline) {
      const clients = await this.itx.clients.list();
      browserClientPaths = (
        await Promise.all(
          clients
            .filter((client) => client.connected && client.path.startsWith("/clients/os-app/"))
            .map(async (client) => {
              const description = await this.itx.clients.get(client.path).__describe();
              return description.capabilities.some(
                (capability) =>
                  capability.path.length === 1 && capability.path[0] === "capabilities",
              )
                ? client.path
                : undefined;
            }),
        )
      ).filter((path): path is string => path !== undefined);
      if (browserClientPaths.length === 0 && Date.now() < clientDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    const { slug } = await this.itx.identity();
    const projectHomePath = `/projects/${slug}`;
    const onboardingUrl = `/projects/${slug}/agents/streams/agents/onboarding`;
    await Promise.all(
      browserClientPaths.map(async (clientPath) => {
        const browserClient = this.itx.clients.get(clientPath);
        const currentUrl = await browserClient.invokeCapability({
          path: ["capabilities", "browser", "url"],
        });
        if (
          typeof currentUrl !== "string" ||
          new URL(currentUrl).pathname.replace(/\/$/, "") !== projectHomePath
        ) {
          return;
        }
        await browserClient.invokeCapability({
          path: ["capabilities", "browser", "navigate"],
          args: [onboardingUrl],
        });
      }),
    );
  }

  async fetch(): Promise<Response> {
    return new Response(
      `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Iterate voice starter</title>
          <style>
            body { margin: 0; background: #f5f1e8; color: #17212b; font: 18px/1.5 system-ui, sans-serif; }
            main { width: min(42rem, calc(100% - 2rem)); margin: 12vh auto; }
            textarea { box-sizing: border-box; width: 100%; min-height: 9rem; padding: 1rem; border: 1px solid #9ca3af; border-radius: .75rem; font: inherit; }
            button { margin-top: .75rem; padding: .7rem 1rem; border: 0; border-radius: .65rem; background: #20364b; color: white; font: inherit; cursor: pointer; }
            #status { color: #52606d; }
          </style>
        </head>
        <body>
          <main>
            <h1>Voice starter</h1>
            <p>Enter something for this project to say.</p>
            <textarea id="message">Hello from my Iterate project.</textarea>
            <button id="speak" type="button">Speak</button>
            <p id="status" role="status">Ready.</p>
          </main>
          <script>
            const button = document.querySelector("#speak");
            const message = document.querySelector("#message");
            const status = document.querySelector("#status");
            button.addEventListener("click", () => {
              if (!("speechSynthesis" in window)) {
                status.textContent = "Speech synthesis is unavailable; the text remains above.";
                return;
              }
              window.speechSynthesis.cancel();
              window.speechSynthesis.speak(new SpeechSynthesisUtterance(message.value));
              status.textContent = "Speaking.";
            });
          </script>
        </body>
      </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}
