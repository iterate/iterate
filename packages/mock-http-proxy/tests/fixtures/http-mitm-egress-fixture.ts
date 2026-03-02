import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { Proxy, type IContext, type IWebSocketContext } from "http-mitm-proxy";
import { MockEgressProxy } from "../../src/index.ts";

export type HttpMitmEgressFixtureOptions = {
  harRecordingPath: string;
};

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = firstHeaderValue(value);
    if (!normalized) continue;
    flattened[key.toLowerCase()] = normalized;
  }
  return flattened;
}

function rewriteHttpRequestToMockEgress(
  ctx: IContext,
  mitm: Proxy,
  egressHost: string,
  egressPort: number,
): void {
  if (!ctx.proxyToServerRequestOptions) return;

  const originalHeaders = flattenHeaders(ctx.clientToProxyRequest.headers);
  const originalHost = originalHeaders.host || String(ctx.proxyToServerRequestOptions.host);
  const originalScheme = ctx.isSSL ? "https" : "http";

  ctx.proxyToServerRequestOptions.host = egressHost;
  ctx.proxyToServerRequestOptions.port = egressPort;
  ctx.proxyToServerRequestOptions.path = ctx.clientToProxyRequest.url ?? "/";
  ctx.proxyToServerRequestOptions.agent = mitm.httpAgent;
  ctx.proxyToServerRequestOptions.headers = {
    ...originalHeaders,
    host: originalHost,
    "x-original-host": originalHost,
    "x-original-protocol": originalScheme,
    "x-original-scheme": originalScheme,
    "x-iterate-original-host": originalHost,
    "x-iterate-original-proto": originalScheme,
  };

  // Force downstream connection to mock egress over plain HTTP.
  ctx.isSSL = false;
}

function rewriteWebSocketRequestToMockEgress(
  ctx: IWebSocketContext,
  mitm: Proxy,
  egressHost: string,
  egressPort: number,
): void {
  if (!ctx.proxyToServerWebSocketOptions?.url) return;

  const originalUrl = new URL(ctx.proxyToServerWebSocketOptions.url);
  const originalHost = originalUrl.host;
  const originalScheme = originalUrl.protocol.replace(":", "");
  const rewrittenHeaders = flattenHeaders(
    (ctx.proxyToServerWebSocketOptions.headers as IncomingHttpHeaders | undefined) ?? {},
  );
  const clientUpgradeReqHeaders = (
    ctx.clientToProxyWebSocket as { upgradeReq?: { headers?: IncomingHttpHeaders } } | undefined
  )?.upgradeReq?.headers;
  const clientHeaders = flattenHeaders(
    (clientUpgradeReqHeaders as IncomingHttpHeaders | undefined) ?? {},
  );
  const originalProtocols = clientHeaders["sec-websocket-protocol"];

  ctx.proxyToServerWebSocketOptions.url = `ws://${egressHost}:${String(egressPort)}${originalUrl.pathname}${originalUrl.search}`;
  ctx.proxyToServerWebSocketOptions.agent = mitm.httpAgent;
  ctx.proxyToServerWebSocketOptions.headers = {
    ...rewrittenHeaders,
    host: originalHost,
    "x-original-host": originalHost,
    "x-original-protocol": originalScheme,
    "x-original-scheme": originalScheme,
    "x-iterate-original-host": originalHost,
    "x-iterate-original-proto": originalScheme,
    ...(originalProtocols ? { "sec-websocket-protocol": originalProtocols } : {}),
  };
}

export class HttpMitmEgressFixture implements AsyncDisposable {
  public readonly egress: MockEgressProxy;
  public readonly mitm: Proxy;
  public readonly caCertPath: string;
  private readonly tempDirPath: string;

  private constructor(params: {
    egress: MockEgressProxy;
    mitm: Proxy;
    caCertPath: string;
    tempDirPath: string;
  }) {
    this.egress = params.egress;
    this.mitm = params.mitm;
    this.caCertPath = params.caCertPath;
    this.tempDirPath = params.tempDirPath;
  }

  static async start(options: HttpMitmEgressFixtureOptions): Promise<HttpMitmEgressFixture> {
    const tempDirPath = await mkdtemp(join(tmpdir(), "http-mitm-egress-fixture-"));
    const egress = await MockEgressProxy.start({
      harRecordingPath: options.harRecordingPath,
    });
    const egressAddress = new URL(egress.url);
    const egressHost = egressAddress.hostname;
    const egressPort = Number(egressAddress.port);

    const mitm = new Proxy();
    mitm.onError(() => {});
    mitm.onRequest((ctx, callback) => {
      rewriteHttpRequestToMockEgress(ctx, mitm, egressHost, egressPort);
      callback();
    });
    mitm.onWebSocketConnection((ctx, callback) => {
      rewriteWebSocketRequestToMockEgress(ctx, mitm, egressHost, egressPort);
      callback();
    });

    await new Promise<void>((resolve, reject) => {
      mitm.listen(
        {
          host: "127.0.0.1",
          port: 0,
          sslCaDir: tempDirPath,
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });

    const caCertPath = join(tempDirPath, "certs", "ca.pem");
    return new HttpMitmEgressFixture({
      egress,
      mitm,
      caCertPath,
      tempDirPath,
    });
  }

  envForNode(): Record<string, string> {
    const mitmUrl = `http://127.0.0.1:${String(this.mitm.httpPort)}`;
    return {
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: mitmUrl,
      HTTPS_PROXY: mitmUrl,
      NODE_EXTRA_CA_CERTS: this.caCertPath,
    };
  }

  async close(): Promise<void> {
    this.mitm.close();
    await this.egress.close();
    await rm(this.tempDirPath, { force: true, recursive: true });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
