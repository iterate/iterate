import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";

export default class VoiceProjectWorker extends IterateWorkerEntrypoint {
  protected override async processEvent(_event: StreamEvent): Promise<void> {}

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
