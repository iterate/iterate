// Send one HTTPS request through a client-provided, non-MITM egress proxy.
//
// The Worker is the TLS client here: it substitutes the secret, then runs the
// full TLS handshake + HTTP write/read itself, in pure JS, over a raw byte
// stream the proxy opened. The proxy only ever dials TCP and shuttles ciphertext
// (`dial` -> read/write), so it sees the target host/port but never the request,
// body, or substituted secret. Running TLS in-worker (rather than terminating at
// the proxy) is what makes it non-MITM.
//
// Scope is deliberately narrow for a POC: HTTPS only, and an HTTP/1.1 response
// parser that handles content-length, chunked, and close-delimited bodies up to
// MAX_PROXY_RESPONSE_BYTES. The connection is method-based RPC (read/write/close)
// because deployed Cap'n Web did not reliably stream Web Stream chunks here.
import { makeTLSClient, setCryptoImplementation, type X509Certificate } from "@reclaimprotocol/tls";
import { pureJsCrypto } from "@reclaimprotocol/tls/purejs-crypto";
import type { EgressHttpsProxy, EgressHttpsProxyConnection } from "../../types.ts";

export const EGRESS_PROXY_PINNED_CERT_SHA256_HEADER = "x-itx-egress-proxy-cert-sha256";
const EGRESS_PROXY_SKIP_TLS_VERIFY_HEADER = "x-itx-egress-proxy-insecure-skip-tls-verify";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_PROXY_RESPONSE_BYTES = 8 * 1024 * 1024;

setCryptoImplementation({
  ...pureJsCrypto,
  randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },
});

export async function runHttpsThroughProxy(
  request: Request,
  proxy: EgressHttpsProxy,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    return Response.json({ error: "egress proxy only supports https" }, { status: 400 });
  }

  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Response.json({ error: "invalid egress proxy port" }, { status: 400 });
  }

  const requestBytes = await serializeHttpRequest(request, url);
  const connection = await proxy.dial({ host: url.hostname, port });
  const responseBytes = await runTlsHttpRequest({
    connection,
    hostname: url.hostname,
    pinnedCertSha256: request.headers.get(EGRESS_PROXY_PINNED_CERT_SHA256_HEADER),
    requestBytes,
    skipTlsVerify: request.headers.get(EGRESS_PROXY_SKIP_TLS_VERIFY_HEADER) === "1",
  });
  return parseHttpResponse(responseBytes);
}

/**
 * Drive one HTTPS request/response over the proxy's raw byte stream.
 *
 * The TLS client is callback-driven, so this wraps it in a Promise:
 *  - `write` callback  -> push ciphertext to the proxy (connection.write)
 *  - `pumpEncryptedInput` -> read ciphertext from the proxy back into the client
 *  - `onHandshake` -> (optionally pin the cert, then) send the HTTP request
 *  - `onApplicationData` -> accumulate plaintext until a full HTTP response is framed
 *  - `onTlsEnd` -> resolve close-delimited responses, or fail
 * `complete`/`fail` settle exactly once (guarded by `settled`) and always close
 * the connection. `progress` is diagnostic only — it decorates the timeout error.
 */
async function runTlsHttpRequest({
  connection,
  hostname,
  pinnedCertSha256,
  requestBytes,
  skipTlsVerify,
}: {
  connection: EgressHttpsProxyConnection;
  hostname: string;
  pinnedCertSha256: string | null;
  requestBytes: Uint8Array;
  skipTlsVerify: boolean;
}): Promise<Uint8Array> {
  let settled = false;
  let leafCertificate: X509Certificate | undefined;
  const responseChunks: Uint8Array[] = [];
  const progress = { handshakeDone: false, requestWritten: false };

  return await new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => {
      fail(
        new Error(
          `timed out waiting for egress proxy HTTP response (${concatBytes(responseChunks).byteLength} bytes received, progress=${JSON.stringify(progress)})`,
        ),
      );
    }, 15_000);

    const client = makeTLSClient({
      host: hostname,
      logger: silentTlsLogger,
      verifyServerCertificate: pinnedCertSha256 === null && !skipTlsVerify,
      write: async ({ header, content }) => {
        await connection.write(concatBytes([header, content]));
      },
      onRecvCertificates: ({ certificates }) => {
        leafCertificate = certificates[0];
      },
      onHandshake: () => {
        progress.handshakeDone = true;
        void sendRequest();
      },
      onApplicationData: (data) => {
        if (data.byteLength === 0) return;
        responseChunks.push(data);

        try {
          const responseBytes = concatBytes(responseChunks);
          if (responseBytes.byteLength > MAX_PROXY_RESPONSE_BYTES) {
            fail(new Error("egress proxy response exceeded maximum POC response size"));
            return;
          }
          const completeLength = completedHttpResponseLength(responseBytes);
          if (completeLength !== undefined) complete(responseBytes.slice(0, completeLength));
        } catch (error) {
          fail(error);
        }
      },
      onTlsEnd: (error) => {
        if (error !== undefined) {
          fail(error);
          return;
        }
        if (responseChunks.length === 0) {
          fail(new Error("egress proxy TLS connection closed before response"));
          return;
        }

        try {
          const responseBytes = concatBytes(responseChunks);
          const completeLength = completedHttpResponseLength(responseBytes);
          if (completeLength !== undefined) {
            complete(responseBytes.slice(0, completeLength));
            return;
          }
          if (isCloseDelimitedHttpResponse(responseBytes)) {
            complete(responseBytes);
            return;
          }
          fail(new Error("egress proxy TLS connection closed before complete HTTP response"));
        } catch (parseError) {
          fail(parseError);
        }
      },
    });

    client.startHandshake().catch(fail);
    void pumpEncryptedInput(client);

    async function sendRequest() {
      try {
        if (pinnedCertSha256 !== null) {
          if (leafCertificate === undefined) {
            throw new Error("egress proxy TLS connection did not receive a certificate");
          }
          const leafSha256 = await certificateSha256(leafCertificate);
          if (leafSha256 !== pinnedCertSha256.toLowerCase().replaceAll(/[^a-f0-9]/g, "")) {
            throw new Error("leaf certificate SHA-256 pin did not match");
          }
        }
        await client.write(requestBytes);
        progress.requestWritten = true;
      } catch (error) {
        fail(error);
        await client.end(error instanceof Error ? error : new Error(String(error)));
      }
    }

    async function pumpEncryptedInput(
      tlsClient: Pick<typeof client, "handleReceivedBytes" | "end">,
    ) {
      try {
        while (!settled) {
          const result = await connection.read();
          if (result === null) {
            await tlsClient.end();
            return;
          }
          await tlsClient.handleReceivedBytes(result);
        }
      } catch (error) {
        fail(error);
      }
    }

    function complete(bytes: Uint8Array) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      connection.close().catch(() => {});
      resolve(bytes);
    }

    function fail(error: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      connection.close().catch(() => {});
      reject(error);
    }
  });
}

const silentTlsLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function serializeHttpRequest(request: Request, url: URL): Promise<Uint8Array> {
  const body =
    request.body === null ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
  const headers = new Headers(request.headers);
  headers.delete(EGRESS_PROXY_PINNED_CERT_SHA256_HEADER);
  headers.delete(EGRESS_PROXY_SKIP_TLS_VERIFY_HEADER);
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("host");
  headers.delete("te");
  headers.delete("trailer");
  headers.delete("transfer-encoding");
  headers.delete("upgrade");
  headers.set("connection", "close");
  headers.set("host", url.host);
  if (body.byteLength > 0 || (request.method !== "GET" && request.method !== "HEAD")) {
    headers.set("content-length", String(body.byteLength));
  }

  const path = `${url.pathname}${url.search}`;
  let head = `${request.method} ${path === "" ? "/" : path} HTTP/1.1\r\n`;
  headers.forEach((value, name) => {
    head += `${name}: ${value}\r\n`;
  });
  head += "\r\n";

  return concatBytes([textEncoder.encode(head), body]);
}

export function parseHttpResponse(bytes: Uint8Array): Response {
  const headerEnd = indexOfHeaderEnd(bytes);
  if (headerEnd === -1) throw new Error("egress proxy response did not contain HTTP headers");

  const headerText = textDecoder.decode(bytes.slice(0, headerEnd));
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?: (.*))?$/.exec(statusLine ?? "");
  if (statusMatch === null) {
    throw new Error(`egress proxy response had invalid status line: ${statusLine ?? ""}`);
  }

  const headers = new Headers();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  headers.delete("connection");
  headers.delete("transfer-encoding");

  const rawBody = bytes.slice(headerEnd + 4);
  const body = /\bchunked\b/i.test(
    headerLines.find((line) => /^transfer-encoding:/i.test(line)) ?? "",
  )
    ? decodeChunkedBody(rawBody)
    : rawBody;

  return new Response(exactArrayBuffer(body), {
    headers,
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
  });
}

function decodeChunkedBody(bytes: Uint8Array): Uint8Array {
  const result = parseChunkedBody(bytes);
  if (result === undefined) throw new Error("egress proxy chunked response was truncated");
  return result.body;
}

export function completedHttpResponseLength(bytes: Uint8Array): number | undefined {
  const headerEnd = indexOfHeaderEnd(bytes);
  if (headerEnd === -1) return undefined;
  const headerText = textDecoder.decode(bytes.slice(0, headerEnd));
  const headerLines = headerText.split("\r\n").slice(1);
  const transferEncodingLine = headerLines.find((line) => /^transfer-encoding:/i.test(line));
  if (/\bchunked\b/i.test(transferEncodingLine ?? "")) {
    const chunkedBody = parseChunkedBody(bytes.slice(headerEnd + 4));
    return chunkedBody === undefined ? undefined : headerEnd + 4 + chunkedBody.encodedLength;
  }

  const contentLengthLine = headerLines.find((line) => /^content-length:/i.test(line));
  if (contentLengthLine !== undefined) {
    const contentLength = Number(contentLengthLine.slice(contentLengthLine.indexOf(":") + 1));
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error(`invalid content-length: ${contentLengthLine}`);
    }
    const totalLength = headerEnd + 4 + contentLength;
    return bytes.byteLength >= totalLength ? totalLength : undefined;
  }

  return undefined;
}

function isCloseDelimitedHttpResponse(bytes: Uint8Array): boolean {
  const headerEnd = indexOfHeaderEnd(bytes);
  if (headerEnd === -1) return false;
  const headerText = textDecoder.decode(bytes.slice(0, headerEnd));
  const headerLines = headerText.split("\r\n").slice(1);
  const transferEncodingLine = headerLines.find((line) => /^transfer-encoding:/i.test(line));
  if (/\bchunked\b/i.test(transferEncodingLine ?? "")) {
    return false;
  }
  return headerLines.every((line) => !/^content-length:/i.test(line));
}

function parseChunkedBody(
  bytes: Uint8Array,
): { body: Uint8Array; encodedLength: number } | undefined {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const lineEnd = indexOfCrlf(bytes, offset);
    if (lineEnd === -1) return undefined;
    const sizeLine = textDecoder.decode(bytes.slice(offset, lineEnd));
    const sizeToken = sizeLine.split(";", 1)[0]!.trim();
    if (!/^[0-9a-f]+$/i.test(sizeToken)) throw new Error(`invalid chunk size: ${sizeLine}`);
    const size = Number.parseInt(sizeToken, 16);
    if (!Number.isSafeInteger(size)) throw new Error(`invalid chunk size: ${sizeLine}`);
    offset = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = completedTrailerLength(bytes, offset);
      return trailerEnd === undefined
        ? undefined
        : { body: concatBytes(chunks), encodedLength: trailerEnd };
    }
    if (offset + size + 2 > bytes.byteLength) return undefined;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size + 2;
    if (bytes[offset - 2] !== 13 || bytes[offset - 1] !== 10) {
      throw new Error("egress proxy chunked response chunk missing CRLF terminator");
    }
  }
  return undefined;
}

function completedTrailerLength(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.byteLength) return undefined;
  if (bytes[offset] === 13 && bytes[offset + 1] === 10) return offset + 2;
  const trailerEnd = indexOfHeaderEnd(bytes, offset);
  return trailerEnd === -1 ? undefined : trailerEnd + 4;
}

async function certificateSha256(cert: X509Certificate): Promise<string> {
  const der = pemToDer(cert.serialiseToPem());
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(der));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function indexOfHeaderEnd(bytes: Uint8Array, start = 0): number {
  for (let index = start; index <= bytes.byteLength - 4; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function indexOfCrlf(bytes: Uint8Array, start: number): number {
  for (let index = start; index <= bytes.byteLength - 2; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
  }
  return -1;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
