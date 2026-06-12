import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

type ParsedArgs = {
  alchemyArgs: string[];
  config?: string;
  doppler: boolean;
};

const appRoot = process.cwd();
const logPath = resolve(appRoot, ".alchemy", "dev-server.log");

const args = parseArgs(process.argv.slice(2));
const config = args.config ?? resolveDopplerConfig();
const command = args.doppler ? "doppler" : "tsx";
const commandArgs = args.doppler
  ? [
      "run",
      "--project",
      "os",
      "--config",
      config,
      "--",
      "tsx",
      "./alchemy.run.ts",
      ...args.alchemyArgs,
    ]
  : ["./alchemy.run.ts", ...args.alchemyArgs];

mkdirSync(resolve(appRoot, ".alchemy"), { recursive: true });

const log = createWriteStream(logPath, { flags: "w" });
log.write(`# OS dev server log\n`);
log.write(`# Started: ${new Date().toISOString()}\n`);
log.write(`# Command: ${[command, ...commandArgs].join(" ")}\n\n`);

const child = spawn(command, commandArgs, {
  env: {
    ...process.env,
    DEV_SERVER_LOG_PATH: logPath,
  },
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout?.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk);
  log.write(chunk);
});

child.stderr?.on("data", (chunk: Buffer) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

child.on("error", (error) => {
  console.error(error);
  log.write(`${error.stack ?? error.message}\n`);
  log.end(() => process.exit(1));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  log.end(() => {
    process.exit(code ?? exitCodeForSignal(signal) ?? 1);
  });
});

function parseArgs(argv: string[]): ParsedArgs {
  const alchemyArgs: string[] = [];
  let config: string | undefined;
  let doppler = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      alchemyArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--no-doppler") {
      doppler = false;
      continue;
    }
    if (arg === "--config") {
      config = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
      continue;
    }
    alchemyArgs.push(arg);
  }

  return { alchemyArgs, config, doppler };
}

function resolveDopplerConfig() {
  if (process.env.DOPPLER_CONFIG?.trim()) return process.env.DOPPLER_CONFIG.trim();

  const result = spawnSync("doppler", ["configure", "get", "config", "--plain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  return result.stdout.trim() || "dev";
}

function exitCodeForSignal(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return undefined;
}
