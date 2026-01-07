import { spawn, type ChildProcess } from "node:child_process";

let serverProcess: ChildProcess | null = null;

export async function setup() {
  const port = process.env.TEST_PORT || "5173";
  const baseUrl = `http://localhost:${port}`;

  try {
    const response = await fetch(baseUrl, { method: "HEAD" });
    if (response.ok) {
      console.log("Dev server already running at", baseUrl);
      return;
    }
  } catch {
    console.log("Dev server not running, starting it...");
  }

  console.log("Starting dev server...");

  return new Promise<void>((resolve, reject) => {
    serverProcess = spawn("pnpm", ["dev"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: port },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let resolved = false;

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);

      if (!resolved && (text.includes("ready") || text.includes("Local:") || text.includes("localhost"))) {
        resolved = true;
        setTimeout(() => {
          console.log("Dev server is ready!");
          resolve();
        }, 2000);
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    serverProcess.on("error", (error) => {
      console.error("Failed to start dev server:", error);
      reject(error);
    });

    serverProcess.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`Dev server exited with code ${code}`);
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (output.length === 0) {
        reject(new Error("Server startup timeout - no output received"));
      } else {
        reject(new Error(`Server startup timeout after 60s. Last output:\n${output.slice(-500)}`));
      }
    }, 60000);
  });
}

export async function teardown() {
  if (serverProcess) {
    console.log("Shutting down dev server...");
    serverProcess.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      serverProcess!.on("exit", () => {
        console.log("Dev server shut down");
        resolve();
      });

      setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          console.log("Force killing dev server...");
          serverProcess.kill("SIGKILL");
        }
        resolve();
      }, 5000);
    });

    serverProcess = null;
  }
}
