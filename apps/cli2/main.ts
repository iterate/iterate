import { stdin, stdout } from "node:process";
import WebSocket from "ws";

const DEFAULT_SERVER_URL = "http://localhost:3005";

interface ConnectOptions {
  useTmux?: boolean;
  serverURL?: string;
}

export async function connectTerminal(
  agentId: string,
  options: ConnectOptions = {},
): Promise<WebSocket> {
  const serverURL = options.serverURL ?? DEFAULT_SERVER_URL;
  const wsURL = serverURL.replace(/^http/, "ws");
  const url = new URL(`${wsURL}/agents/${agentId}/terminal`);
  if (options.useTmux) {
    url.searchParams.set("tmux", "true");
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.toString());

    ws.on("open", () => {
      resolve(ws);
    });

    ws.on("error", (err) => {
      reject(err);
    });
  });
}

export async function interactiveTerminal(agentId: string, options: ConnectOptions = {}) {
  const ws = await connectTerminal(agentId, options);

  console.log(`Connected to agent: ${agentId}${options.useTmux ? " (tmux)" : ""}`);
  console.log("Press Ctrl+C twice to exit\n");

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.setEncoding("utf8");

  sendResize(ws);
  stdout.on("resize", () => sendResize(ws));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "output") {
        stdout.write(msg.data);
      }
    } catch {
      stdout.write(data.toString());
    }
  });

  let ctrlCCount = 0;
  let ctrlCTimer: NodeJS.Timeout | null = null;

  stdin.on("data", (key: string) => {
    if (key === "\x03") {
      ctrlCCount++;
      if (ctrlCCount >= 2) {
        cleanup(ws);
        return;
      }
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      ctrlCTimer = setTimeout(() => (ctrlCCount = 0), 500);
    } else {
      ctrlCCount = 0;
    }

    ws.send(JSON.stringify({ type: "input", data: key }));
  });

  ws.on("close", () => {
    console.log("\nConnection closed");
    cleanup(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    cleanup(ws);
  });
}

function sendResize(ws: WebSocket) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "resize",
        cols: stdout.columns || 80,
        rows: stdout.rows || 24,
      }),
    );
  }
}

function cleanup(ws: WebSocket) {
  if (stdin.isTTY) {
    stdin.setRawMode(false);
  }
  ws.close();
  process.exit(0);
}

export async function executeTmuxCommand(
  args: string[],
  serverURL = DEFAULT_SERVER_URL,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const response = await fetch(`${serverURL}/tmux`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });

  return response.json() as Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export async function listTmuxSessions(serverURL = DEFAULT_SERVER_URL): Promise<string[]> {
  const response = await fetch(`${serverURL}/tmux/sessions`);
  const data = (await response.json()) as { sessions: string[] };
  return data.sessions;
}

function printUsage() {
  console.log(`Usage:
  cli agent <agent-id> connect           Connect to agent's tmux session (creates if needed)
  cli agent <agent-id> connect --shell   Connect to a raw shell (no tmux)
  cli tmux [args...]                     Execute tmux command on server
  cli tmux sessions                      List tmux sessions on server
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const command = args[0];

  switch (command) {
    case "agent": {
      const agentId = args[1];
      const subcommand = args[2];

      if (!agentId) {
        console.error("Error: agent-id is required");
        printUsage();
        process.exit(1);
      }

      if (subcommand === "connect") {
        // Default to tmux, use --shell for raw shell
        const useShell = args.includes("--shell");
        await interactiveTerminal(agentId, { useTmux: !useShell });
      } else {
        console.error(`Error: Unknown subcommand "${subcommand}"`);
        printUsage();
        process.exit(1);
      }
      break;
    }

    case "tmux": {
      const tmuxArgs = args.slice(1);

      if (tmuxArgs.length === 0 || tmuxArgs[0] === "sessions") {
        const sessions = await listTmuxSessions();
        if (sessions.length === 0) {
          console.log("No tmux sessions found");
        } else {
          console.log("Tmux sessions:");
          for (const session of sessions) {
            console.log(`  - ${session}`);
          }
        }
      } else {
        const result = await executeTmuxCommand(tmuxArgs);
        if (result.stdout) {
          console.log(result.stdout);
        }
        if (result.stderr) {
          console.error(result.stderr);
        }
        process.exit(result.exitCode ?? 0);
      }
      break;
    }

    default:
      console.error(`Error: Unknown command "${command}"`);
      printUsage();
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
