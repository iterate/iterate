import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const command =
  'PORT=8000; python3 -m http.server "$PORT" >/dev/null 2>&1 & PID=$!; trap "kill $PID" EXIT; cloudflared tunnel --url "http://127.0.0.1:$PORT"';

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

console.log(`cmd: ${command}`);

const child = spawn("sh", ["-lc", command], {
  stdio: ["ignore", "pipe", "pipe"],
});

let tunnelUrl: string | null = null;

const onData = (chunk: Buffer | string) => {
  const text = String(chunk);
  process.stdout.write(text);
  urlRegex.lastIndex = 0;
  const match = urlRegex.exec(text);
  if (match?.[0] && !tunnelUrl) {
    tunnelUrl = match[0];
    console.log(`\n[parser] tunnelUrl=${tunnelUrl}`);
  }
};

child.stdout.on("data", onData);
child.stderr.on("data", onData);
child.once("exit", (code, signal) => {
  console.log(`\n[process-exit] code=${String(code)} signal=${String(signal)}`);
});

const maxAttempts = 10;
let attempt = 0;

try {
  while (attempt < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    attempt += 1;

    try {
      const localResponse = await fetch("http://127.0.0.1:8000/", {
        signal: AbortSignal.timeout(3_000),
      });
      const localBody = await localResponse.text();
      console.log(
        `[poll ${String(attempt)}] localhost:8000 status=${String(localResponse.status)} body=${JSON.stringify(localBody.slice(0, 60))}`,
      );
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
      console.log(
        `[poll ${String(attempt)}] localhost:8000 error code=${err.cause?.code ?? err.code ?? ""} message=${err.message}`,
      );
    }

    if (!tunnelUrl) {
      console.log(`[poll ${String(attempt)}] waiting for URL`);
      continue;
    }
    try {
      const response = await fetch(`${tunnelUrl}/`, { signal: AbortSignal.timeout(8_000) });
      const text = await response.text();
      console.log(
        `[poll ${String(attempt)}] tunnel status=${String(response.status)} body=${JSON.stringify(text.slice(0, 120))}`,
      );
      if (response.ok) {
        console.log("[result] SUCCESS");
        process.exitCode = 0;
        break;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
      console.log(
        `[poll ${String(attempt)}] tunnel fetch error code=${err.cause?.code ?? err.code ?? ""} message=${err.message}`,
      );
    }
  }

  if (process.exitCode !== 0) {
    console.log("[result] FAIL after 10 retries");
    process.exitCode = 1;
  }
} finally {
  await stop(child);
}
