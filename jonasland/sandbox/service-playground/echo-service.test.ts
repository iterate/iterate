import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { echoService } from "./echo-service.ts";

const PLAYGROUND_DIR = path.dirname(new URL(import.meta.url).pathname);
const GO_SOURCE = path.join(PLAYGROUND_DIR, "echo-tcp-server.go");
const GO_BINARY = path.join(PLAYGROUND_DIR, "echo-tcp-server");

describe("echo service (hybrid TCP/HTTP proxy)", () => {
  let target: string;
  let port: number;
  let proxyCleanup: (() => void) | undefined;

  beforeAll(async () => {
    // Compile the Go binary
    execSync(`go build -o ${GO_BINARY} ${GO_SOURCE}`, { stdio: "pipe" });

    // Start the service using our abstraction
    const result = await echoService.start({ binaryPath: GO_BINARY });
    target = result.target;
    port = parseInt(target.split(":")[1], 10);
  }, 30_000);

  afterAll(() => {
    // The proxy and Go process will be cleaned up when the test process exits
    // In a real scenario SIGTERM would handle this
  });

  test("health endpoint responds via managed HTTP path", async () => {
    const res = await fetch(`http://${target}/service/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.slug).toBe("echo");
    expect(body.pid).toBeTypeOf("number");
  });

  test("openapi.json responds via managed HTTP path", async () => {
    const res = await fetch(`http://${target}/openapi.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.0.0");
    expect(body.info.title).toBe("Echo TCP Service");
  });

  test("raw TCP traffic proxies through to Go echo server", async () => {
    const response = await tcpExchange(port, "hello world\n");
    expect(response).toBe("ECHO: hello world\n");
  });

  test("multiple TCP messages on same connection", async () => {
    const responses = await tcpConversation(port, [
      "first message\n",
      "second message\n",
      "third message\n",
    ]);
    expect(responses).toEqual([
      "ECHO: first message\n",
      "ECHO: second message\n",
      "ECHO: third message\n",
    ]);
  });

  test("HTTP to non-managed path proxies through to inner service", async () => {
    // The Go server is a TCP echo server, not HTTP — so an HTTP request to
    // a non-managed path will be forwarded as raw TCP. The Go server will
    // echo back the raw HTTP request line. This proves L4 passthrough works.
    const socket = connect(port, "127.0.0.1");
    const response = await new Promise<string>((resolve) => {
      socket.write("GET /some/random/path HTTP/1.1\r\nHost: test\r\n\r\n");
      socket.once("data", (data) => {
        resolve(data.toString());
        socket.destroy();
      });
    });
    // The Go echo server reads line-by-line, so it echoes back each line
    expect(response).toContain("ECHO: GET /some/random/path HTTP/1.1");
  });
});

/** Send a single message over TCP and get the response */
function tcpExchange(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(message);
    });
    socket.once("data", (data) => {
      resolve(data.toString());
      socket.destroy();
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP exchange timed out"));
    }, 5_000);
  });
}

/** Send multiple messages on a single connection, collecting responses */
function tcpConversation(port: number, messages: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const responses: string[] = [];
    const socket = connect(port, "127.0.0.1", () => {
      sendNext();
    });

    let idx = 0;
    function sendNext() {
      if (idx >= messages.length) {
        socket.destroy();
        resolve(responses);
        return;
      }
      socket.write(messages[idx]);
      idx++;
    }

    socket.on("data", (data) => {
      responses.push(data.toString());
      sendNext();
    });

    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP conversation timed out"));
    }, 10_000);
  });
}
