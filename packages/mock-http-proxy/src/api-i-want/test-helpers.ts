import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mockttp from "mockttp";
import { request } from "undici";
import { expect } from "vitest";
import { MockEgressProxy, type Har } from "../index.ts";

type TemporaryDirectoryFixture = Disposable & {
  path: string;
};

type UseMockHttpServerOptions = {
  harDirectory: string;
  port?: number;
  harFileName?: string;
};

type MockHttpServerFixture = AsyncDisposable & {
  url: string;
  port: number;
  getHar(): Har;
};

type UseMitmProxyOptions = {
  externalEgressProxyUrl: string;
  port?: number;
};

type MitmProxyFixture = AsyncDisposable & {
  url: string;
  port: number;
  envForNode(): Record<string, string>;
};

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toOriginalUrl(
  rawUrl: string,
  headers: Record<string, string | string[] | undefined>,
): URL {
  if (/^https?:\/\//i.test(rawUrl) || /^wss?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }

  const host = firstHeaderValue(headers.host);
  if (!host) {
    throw new Error("missing host header for proxied request");
  }
  return new URL(rawUrl, `https://${host}`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function currentTestHarPath(harDirectory: string): string {
  const currentTestName = expect.getState().currentTestName;
  const slug = slugify(currentTestName ?? "") || "unknown-test";
  return join(harDirectory, `${slug}.har`);
}

export function useTemporaryDirectory(prefix = "mock-http-proxy-api-"): TemporaryDirectoryFixture {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    [Symbol.dispose]() {
      rmSync(path, { force: true, recursive: true });
    },
  };
}

export async function useMockHttpServer(
  options: UseMockHttpServerOptions,
): Promise<MockHttpServerFixture> {
  const harRecordingPath = options.harFileName
    ? join(options.harDirectory, options.harFileName)
    : currentTestHarPath(options.harDirectory);
  const egress = await MockEgressProxy.start({
    harRecordingPath,
    port: options.port,
  });

  const fixture: MockHttpServerFixture = {
    url: egress.url,
    port: egress.port,
    getHar() {
      return egress.getHar();
    },
    async [Symbol.asyncDispose]() {
      await egress.close();
    },
  };

  return fixture;
}

export async function useMitmProxy(options: UseMitmProxyOptions): Promise<MitmProxyFixture> {
  const ca = await mockttp.generateCACertificate();
  const tempDirPath = await mkdtemp(join(tmpdir(), "mock-http-proxy-mitm-ca-"));
  const caCertPath = join(tempDirPath, "ca.pem");
  await writeFile(caCertPath, ca.cert, "utf8");

  const mitmServer = mockttp.getLocal({ https: ca });
  const egressUrl = new URL(options.externalEgressProxyUrl);
  const egressWsUrl = `ws://${egressUrl.host}`;

  await mitmServer.forAnyRequest().thenCallback(async (req) => {
    const originalUrl = toOriginalUrl(req.url, req.headers);
    const bodyBuffer = req.body ? await req.body.getDecodedBuffer() : undefined;

    const response = await request(
      `${options.externalEgressProxyUrl}${originalUrl.pathname}${originalUrl.search}`,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: egressUrl.host,
          "x-iterate-target-url": originalUrl.origin,
          "x-iterate-original-host": originalUrl.host,
          "x-iterate-original-proto": originalUrl.protocol.replace(":", ""),
        },
        body: bodyBuffer,
      },
    );
    const responseBody = response.body ? Buffer.from(await response.body.arrayBuffer()) : undefined;

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: responseBody,
    };
  });
  await mitmServer.forAnyWebSocket().thenPassThrough({
    transformRequest: {
      setProtocol: "ws",
      replaceHost: {
        targetHost: egressUrl.host,
        updateHostHeader: false,
      },
    },
  });
  await mitmServer.start(options.port ?? 0);

  return {
    url: mitmServer.url,
    port: mitmServer.port,
    envForNode() {
      return {
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: mitmServer.url,
        HTTPS_PROXY: mitmServer.url,
        http_proxy: mitmServer.url,
        https_proxy: mitmServer.url,
        NODE_EXTRA_CA_CERTS: caCertPath,
      };
    },
    async [Symbol.asyncDispose]() {
      await mitmServer.stop();
      await rm(tempDirPath, { force: true, recursive: true });
    },
  };
}
