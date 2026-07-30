import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RpcSession,
  RpcTarget,
  type RpcTransport,
} from "@iterate-com/capnweb";
import { describe, expect, test } from "vitest";
import {
  cInteropKnownFailures,
  type CInteropKnownFailure,
} from "./c-interop-known-failures.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(testDirectory, "../../..");
const nativePeerPath =
  process.env.ITERATE_KIT_CAPNWEB_NATIVE_PEER ??
  resolve(
    packageDirectory,
    "firmware/build-capnweb-interop/capnweb-native-peer",
  );

type PendingReceive = {
  readonly resolve: (message: string) => void;
  readonly reject: (reason: Error) => void;
};

/*
 * The C fixture speaks one complete Cap'n Web JSON message per stdio line.
 * This transport intentionally adds no protocol adapter: RpcSession generates
 * the exact messages used in production, while the child process runs the
 * compiled C peer. A queue exists only on the host test side; it does not make
 * any claim about acceptable buffering on an ESP32.
 */
class NativePeerTransport implements RpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #messages: string[] = [];
  readonly #receivers: PendingReceive[] = [];
  readonly #exit: Promise<number>;
  #stdoutRemainder = "";
  #stderr = "";
  #failure: Error | undefined;

  constructor() {
    if (!existsSync(nativePeerPath)) {
      throw new Error(
        `C peer is missing at ${nativePeerPath}; run pnpm firmware:test:capnweb so the sanitized fixture is built first.`,
      );
    }
    this.#child = spawn(nativePeerPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#stdoutRemainder += chunk;
      for (;;) {
        const newline = this.#stdoutRemainder.indexOf("\n");
        if (newline < 0) break;
        const message = this.#stdoutRemainder.slice(0, newline);
        this.#stdoutRemainder = this.#stdoutRemainder.slice(newline + 1);
        this.#publish(message);
      }
    });
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#exit = new Promise<number>((resolveExit) => {
      this.#child.once("error", (error) => {
        this.#fail(error);
      });
      this.#child.once("exit", (code, signal) => {
        const exitCode = code ?? 128;
        if (this.#stdoutRemainder.length > 0) {
          this.#publish(this.#stdoutRemainder);
          this.#stdoutRemainder = "";
        }
        if (exitCode !== 0 || signal !== null) {
          this.#fail(
            new Error(
              `C peer exited code=${String(code)} signal=${String(signal)} stderr=${JSON.stringify(this.#stderr)}`,
            ),
          );
        } else {
          this.#fail(new Error("C peer closed"));
        }
        resolveExit(exitCode);
      });
    });
  }

  send(message: string): Promise<void> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    return new Promise<void>((resolveWrite, rejectWrite) => {
      this.#child.stdin.write(`${message}\n`, (error) => {
        if (error) {
          rejectWrite(error);
        } else {
          resolveWrite();
        }
      });
    });
  }

  receive(): Promise<string> {
    const message = this.#messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return new Promise<string>((resolveMessage, rejectMessage) => {
      this.#receivers.push({
        resolve: resolveMessage,
        reject: rejectMessage,
      });
    });
  }

  abort(reason: unknown): void {
    this.#fail(
      reason instanceof Error ? reason : new Error(`RPC aborted: ${String(reason)}`),
    );
    this.#child.stdin.end();
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    const exitCode = await this.#exit;
    if (exitCode !== 0) {
      throw new Error(
        `C peer failed during clean close: exit=${exitCode} stderr=${JSON.stringify(this.#stderr)}`,
      );
    }
  }

  #publish(message: string): void {
    const receiver = this.#receivers.shift();
    if (receiver === undefined) {
      this.#messages.push(message);
    } else {
      receiver.resolve(message);
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const receiver of this.#receivers.splice(0)) {
      receiver.reject(error);
    }
  }
}

class CallbackCounter extends RpcTarget {
  #value: number;

  constructor(value: number) {
    super();
    this.#value = value;
  }

  increment(amount = 1): number {
    this.#value += amount;
    return this.#value;
  }
}

async function withNativePeer(
  body: (remote: any) => Promise<void>,
): Promise<void> {
  const transport = new NativePeerTransport();
  const session = new RpcSession(transport);
  try {
    await body(session.getRemoteMain());
    await session.drain();
  } finally {
    await transport.close();
  }
}

function runTerminalKnownFailure(
  failure: Extract<
    CInteropKnownFailure,
    { readonly kind: "terminal-wire-status" }
  >,
): void {
  const result = spawnSync(nativePeerPath, [], {
    input: `${failure.frames.join("\n")}\n`,
    encoding: "utf8",
  });

  /*
   * "Known failing" must not mean skipped. The fixture has to emit the
   * classified abort and return its documented protocol status. If it starts
   * succeeding, or fails as malformed input, this assertion forces somebody
   * to update the supported suite and the compatibility profile together.
   */
  expect(result.status).toBe(4);
  expect(result.stderr).toContain(
    `capnweb_session_receive failed: ${failure.expectedStatus}`,
  );
  expect(result.stdout.trim()).toBe(
    JSON.stringify([
      "abort",
      ["error", "Error", failure.expectedAbortReason],
    ]),
  );
}

describe("C peer interoperability with the real TypeScript Cap'n Web runtime", () => {
  test("runs the upstream primitive, object, error, and bytes behaviors across the language boundary", async () => {
    /*
     * These cases are lifted from the upstream TestTarget contract rather than
     * reimplementing Cap'n Web framing in TypeScript. They jointly catch wire
     * drift in calls, nested expressions, Unicode/escaping, remote errors, and
     * fragmented byte output. A native-only test cannot detect any of those
     * disagreements with the runtime Iterate actually deploys.
     */
    await withNativePeer(async (remote) => {
      expect(await remote.square(12)).toBe(144);
      expect(await remote.generateFibonacci(7)).toEqual([
        0, 1, 1, 2, 3, 5, 8,
      ]);
      expect(
        await remote.servos.move({
          yaw: -23,
          pitch: 17,
        }),
      ).toEqual({ yaw: -23, pitch: 17 });
      expect(
        await remote.renderOnScreen({
          url: 'https://example.com/snowman-☃?q="quoted"',
        }),
      ).toBe(true);
      await expect(remote.throwError()).rejects.toThrow(
        new RangeError("test error"),
      );

      expect(Array.from(await remote.getBytes())).toEqual([
        0, 1, 2, 127, 128, 254, 255,
      ]);
      const largeBytes = new Uint8Array(await remote.getLargeBytes(70_000));
      expect(largeBytes).toHaveLength(70_000);
      expect(largeBytes[0]).toBe(0);
      expect(largeBytes[69_999]).toBe(69_999 % 251);
    });
  });

  test("runs upstream capability return, pipelining, and bidirectional callback behaviors", async () => {
    /*
     * Device capabilities are useful only if object references survive both
     * directions. The first increment is deliberately pipelined before the
     * returned counter resolves; the callbacks then make the C peer call back
     * into a JS object and function. This is the minimum cross-language proof
     * for future subscriptions such as subscribeToMetrics(cb).
     */
    await withNativePeer(async (remote) => {
      const returnedCounter = remote.makeCounter(4);
      expect(await returnedCounter.increment()).toBe(5);
      expect(await returnedCounter.increment(4)).toBe(9);

      const callbackCounter = new CallbackCounter(10);
      expect(await remote.incrementCounter(callbackCounter, 3)).toBe(13);
      expect(
        await remote.callFunction(async (value: number) => value * value, 6),
      ).toEqual({ result: 36 });
    });
  });

  for (const failure of cInteropKnownFailures) {
    test(`executes declared compatibility failure: ${failure.id}`, async () => {
      if (failure.kind === "terminal-wire-status") {
        runTerminalKnownFailure(failure);
        return;
      }

      await withNativePeer(async (remote) => {
        await expect(failure.invoke(remote)).rejects.toThrow(
          failure.expectedMessage,
        );
      });
    });
  }
});
