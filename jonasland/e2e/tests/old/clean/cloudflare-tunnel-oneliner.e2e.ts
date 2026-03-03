import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, test } from "vitest";

const TRYCLOUDFLARE_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);
  });
}

describe("clean cloudflare tunnel one-liner", () => {
  test("runs one-liner, parses tunnel URL, fetches 'This is working'", async () => {
    const port = await allocatePort();
    const logs: string[] = [];
    let tunnelUrl: string | null = null;

    const oneLiner = [
      `PORT=${String(port)}`,
      `python3 -c 'import sys;from http.server import BaseHTTPRequestHandler,HTTPServer;port=int(sys.argv[1]);H=type("H",(BaseHTTPRequestHandler,),{"do_GET":lambda self:(self.send_response(200),self.send_header("Content-Type","text/plain; charset=utf-8"),self.end_headers(),self.wfile.write(b"This is working")),"log_message":lambda self,*a:None});HTTPServer(("127.0.0.1",port),H).serve_forever()' "$PORT" >/dev/null 2>&1 & PID=$!`,
      `trap "kill $PID" EXIT`,
      `cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --loglevel info`,
    ].join("; ");

    const child = spawn("sh", ["-lc", oneLiner], { stdio: ["ignore", "pipe", "pipe"] });

    const onChunk = (chunk: Buffer | string) => {
      const text = String(chunk);
      logs.push(text);
      TRYCLOUDFLARE_URL_REGEX.lastIndex = 0;
      const match = TRYCLOUDFLARE_URL_REGEX.exec(text);
      if (match?.[0]) {
        tunnelUrl = match[0];
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    try {
      const discovered = await new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + 60_000;
        const timer = setInterval(() => {
          if (tunnelUrl) {
            clearInterval(timer);
            resolve(tunnelUrl);
            return;
          }
          if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for trycloudflare URL\n${logs.join("")}`));
          }
        }, 200);

        child.once("exit", (code, signal) => {
          clearInterval(timer);
          reject(
            new Error(
              `one-liner exited before URL was discovered (code=${String(code)} signal=${String(signal)})\n${logs.join("")}`,
            ),
          );
        });
      });

      const deadline = Date.now() + 120_000;
      let lastError = "no response";
      while (Date.now() < deadline) {
        try {
          const response = await fetch(discovered, { signal: AbortSignal.timeout(10_000) });
          const text = await response.text();
          if (response.ok && text.includes("This is working")) {
            expect(text).toContain("This is working");
            return;
          }
          lastError = `status=${String(response.status)} body=${text.slice(0, 200)}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      throw new Error(
        `failed to fetch expected body from ${discovered}: ${lastError}\none-liner logs:\n${logs.join("")}`,
      );
    } finally {
      await stop(child);
    }
  }, 240_000);
});
