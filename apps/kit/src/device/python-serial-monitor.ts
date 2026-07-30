import { spawn, type ChildProcess } from "node:child_process";

const readyMarker = "__ITERATE_KIT_SERIAL_READY__";
const monitorSource = String.raw`
import serial
import sys

port = serial.Serial()
port.port = sys.argv[1]
port.baudrate = int(sys.argv[2])
port.timeout = 0.2
port.dtr = False
port.rts = False
port.open()
print("${readyMarker}", file=sys.stderr, flush=True)

while True:
    chunk = port.read_until(b"\n")
    if chunk:
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
`;

export interface PythonSerialMonitorOptions {
  baudRate?: number;
  onError(error: Error): void;
  onLine(line: string): void;
  port: string;
  pythonExecutable?: string;
}

export class PythonSerialMonitor {
  readonly #child: ChildProcess;

  private constructor(child: ChildProcess) {
    this.#child = child;
  }

  static async open(options: PythonSerialMonitorOptions) {
    const baudRate = options.baudRate ?? 115_200;
    if (
      !options.port.trim() ||
      options.port.includes("\0") ||
      !Number.isSafeInteger(baudRate) ||
      baudRate <= 0
    ) {
      throw new Error("A valid serial port and baud rate are required.");
    }

    const child = spawn(
      options.pythonExecutable ?? "python",
      ["-u", "-c", monitorSource, options.port, String(baudRate)],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!child.stdout || !child.stderr) {
      child.kill();
      throw new Error("The serial monitor did not expose output streams.");
    }

    await waitUntilReady(child);
    forwardLines(child.stdout, options.onLine, options.onError);
    child.stderr.on("data", (chunk: Buffer) => {
      const detail = chunk.toString("utf8").trim();
      if (detail) {
        options.onError(new Error(`Serial monitor error: ${detail}`));
      }
    });
    child.once("error", options.onError);
    child.once("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        options.onError(
          new Error(
            signal
              ? `Serial monitor terminated by signal ${signal}.`
              : `Serial monitor exited with status ${String(code)}.`,
          ),
        );
      }
    });
    return new PythonSerialMonitor(child);
  }

  [Symbol.dispose]() {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
    }
  }
}

function waitUntilReady(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    if (!child.stderr) {
      reject(new Error("The serial monitor has no diagnostic stream."));
      return;
    }
    let diagnostics = "";
    const timeout = setTimeout(() => {
      cleanup();
      child.kill("SIGTERM");
      reject(new Error("Timed out opening the serial monitor."));
    }, 5_000);
    const onDiagnostics = (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
      if (!diagnostics.includes(readyMarker)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Serial monitor exited before opening: ${
            diagnostics.trim() || (signal ? `signal ${signal}` : `status ${String(code)}`)
          }.`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stderr?.off("data", onDiagnostics);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stderr.on("data", onDiagnostics);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
) {
  let pending = "";
  stream.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        onLine(line.replace(/\r$/, ""));
      } catch (error) {
        onError(error instanceof Error ? error : new Error("Serial line observer failed."));
      }
    }
  });
}
