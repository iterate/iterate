import { spawn } from "node:child_process";

type UseMyComputerCommandInput = {
  cliPath: string;
  configName: string;
  name: string;
  projectId: string;
};

export function buildUseMyComputerCommand(input: UseMyComputerCommandInput) {
  return {
    command: "bun",
    args: [
      input.cliPath,
      "--config",
      input.configName,
      "use-my-computer",
      "--json",
      "--project",
      input.projectId,
      "--name",
      input.name,
    ],
  };
}

export function launchUseMyComputerProvider(
  input: UseMyComputerCommandInput & {
    environment: NodeJS.ProcessEnv;
    bearerTokenCameFromStoredSession: boolean;
  },
) {
  const command = buildUseMyComputerCommand(input);
  const environment = { ...input.environment };
  if (input.bearerTokenCameFromStoredSession) delete environment.ITERATE_BEARER_TOKEN;
  return spawn(command.command, command.args, {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

type ProviderProcess = {
  stdout: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    on(event: "end", listener: () => void): unknown;
  };
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  stdin: { end(): unknown };
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
};

type ChatComputerSharingSnapshot = {
  status: "idle" | "starting" | "live" | "reconnecting" | "error";
  notice: string;
};

type ProviderEvent = {
  conflict?: boolean;
  error?: string;
  loggedIn?: boolean;
  method?: string;
  ok?: boolean;
  reconnecting?: boolean;
  summary?: string;
  type?: string;
};

export function createChatComputerSharing(input: { launch: () => ProviderProcess; name: string }) {
  let process: ProviderProcess | undefined;
  let current: ChatComputerSharingSnapshot = { status: "idle", notice: "" };
  const listeners = new Set<() => void>();

  const publish = (next: ChatComputerSharingSnapshot) => {
    current = next;
    for (const listener of listeners) listener();
  };

  return {
    [Symbol.dispose]() {
      process?.stdin.end();
      process = undefined;
      publish({ status: "idle", notice: "" });
    },
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      if (process) return;
      publish({ status: "starting", notice: `starting itx.${input.name}…` });
      const launched = input.launch();
      process = launched;
      let exitIsExplained = false;
      let hasExited = false;
      let exitCode: number | null = null;
      let stdoutEnded = false;
      const finishExit = () => {
        if (process !== launched || !hasExited || !stdoutEnded) return;
        process = undefined;
        if (exitIsExplained) return;
        publish({
          status: "error",
          notice: `itx.${input.name} stopped unexpectedly (exit ${exitCode === null ? "unknown" : exitCode})`,
        });
      };
      launched.on("error", (error) => {
        if (process !== launched) return;
        process = undefined;
        publish({
          status: "error",
          notice: `could not share itx.${input.name}: ${error.message}`,
        });
      });
      launched.on("exit", (code) => {
        if (process !== launched) return;
        hasExited = true;
        exitCode = code;
        finishExit();
      });
      let stdoutBuffer = "";
      let stderrBuffer = "";
      launched.stderr.on("data", (chunk) => {
        if (process !== launched) return;
        stderrBuffer += String(chunk);
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          publish({
            status: "error",
            notice: `could not share itx.${input.name}: ${line}`,
          });
        }
      });
      const processStdoutLine = (line: string) => {
        if (line.trim() === "") return;
        let event: ProviderEvent;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("not an event object");
          }
          event = parsed as ProviderEvent;
        } catch {
          publish({
            status: "error",
            notice: `itx.${input.name} emitted invalid status output`,
          });
          return;
        }
        if (event.type === "call" && event.method) {
          publish({
            status: "live",
            notice: `itx.${input.name}.${event.method}: ${event.summary || "using your computer"}`,
          });
          return;
        }
        if (event.type === "call-done" && event.method && event.ok === false) {
          publish({
            status: "error",
            notice: `itx.${input.name}.${event.method} failed: ${event.error || "unknown error"}`,
          });
          return;
        }
        if (event.type === "call-done" && event.method && event.ok === true) {
          publish({
            status: "live",
            notice: `itx.${input.name} shared for this chat`,
          });
          return;
        }
        if (event.type === "status" && event.loggedIn === false) {
          exitIsExplained = true;
          publish({
            status: "error",
            notice: `itx.${input.name} needs a fresh iterate login`,
          });
          return;
        }
        if (event.type === "status" && event.loggedIn === true) {
          if (event.conflict === true) {
            exitIsExplained = true;
            publish({
              status: "error",
              notice: `another session took itx.${input.name}`,
            });
            return;
          }
          if (event.reconnecting === true) {
            publish({
              status: "reconnecting",
              notice: `itx.${input.name} dropped — reconnecting`,
            });
            return;
          }
          publish({
            status: "live",
            notice: `itx.${input.name} shared for this chat`,
          });
        }
      };
      launched.stdout.on("data", (chunk) => {
        if (process !== launched) return;
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          processStdoutLine(line);
        }
      });
      launched.stdout.on("end", () => {
        if (process !== launched) return;
        processStdoutLine(stdoutBuffer);
        stdoutBuffer = "";
        stdoutEnded = true;
        finishExit();
      });
    },
  };
}
