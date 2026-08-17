import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";

const ONBOARDING_OPEN_REQUEST_KEY = "iterate/config/onboarding-open-requested:v1";
const ONBOARDING_OPEN_WINDOW_MS = 5 * 60 * 1_000;

export default class VoiceProjectWorker extends IterateWorkerEntrypoint {
  /** Open only tabs still sitting on this project's landing page. The same
   * userspace action serves tabs present at creation and tabs whose generic
   * browser capability finishes mounting moments later. */
  async #openOnboardingOnProjectHome(clientPaths: string[]): Promise<void> {
    const { slug } = await this.itx.identity();
    const projectHomePath = `/projects/${slug}`;
    const onboardingUrl = `/projects/${slug}/agents/streams/agents/onboarding`;
    await Promise.all(
      clientPaths.map(async (clientPath) => {
        const browserClient = this.itx.clients.get(clientPath);
        const description = await browserClient.__describe();
        if (
          !description.capabilities.some(
            (capability) => capability.path.length === 1 && capability.path[0] === "capabilities",
          )
        ) {
          return;
        }
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

  protected override async processEvent(event: StreamEvent): Promise<void> {
    if (
      event.type === "events.iterate.com/capability-host/capability-provided" &&
      event.path === "/"
    ) {
      // projects.connect copies this generic, post-mount fact from the client
      // scope. A short-lived userspace request bridges the ordinary race
      // between project creation and the destination route mounting itself.
      const source = event.source?.copiedFrom?.at(-1);
      if (!source?.path.startsWith("/clients/os-app/")) return;
      const openRequest = await this.itx.streams
        .get("/")
        .getEvent({ idempotencyKey: ONBOARDING_OPEN_REQUEST_KEY });
      if (openRequest === undefined) return;
      const requestedAt = Date.parse(openRequest.createdAt);
      if (!Number.isFinite(requestedAt)) {
        throw new Error("The onboarding open request has an invalid creation timestamp.");
      }
      if (Date.now() - requestedAt > ONBOARDING_OPEN_WINDOW_MS) return;
      await this.#openOnboardingOnProjectHome([source.path]);
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

    // This durable userspace fact makes a just-after-creation client as
    // actionable as one that happened to be connected already. It expires
    // in the capability-provided case, so a later visit is never onboarding.
    await this.itx.streams.get("/").append({
      type: "events.iterate.com/config/onboarding-open-requested",
      idempotencyKey: ONBOARDING_OPEN_REQUEST_KEY,
    });
    const clients = await this.itx.clients.list();
    await this.#openOnboardingOnProjectHome(
      clients
        .filter((client) => client.connected && client.path.startsWith("/clients/os-app/"))
        .map((client) => client.path),
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
