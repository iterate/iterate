import { makeTLSClient, setCryptoImplementation, type X509Certificate } from "@reclaimprotocol/tls";
import { pureJsCrypto } from "@reclaimprotocol/tls/purejs-crypto";
import type { BlindEgressRelay, BlindEgressRelayConnection } from "../../types.ts";

export const BLIND_RELAY_PINNED_CERT_SHA256_HEADER = "x-itx-blind-relay-cert-sha256";
const INSECURE_BLIND_RELAY_SKIP_TLS_VERIFY_HEADER = "x-itx-blind-relay-insecure-skip-tls-verify";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_BLIND_RELAY_RESPONSE_BYTES = 8 * 1024 * 1024;

setCryptoImplementation({
  ...pureJsCrypto,
  randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },
});

export async function relayedFetchWithBlindRelay(
  request: Request,
  relay: BlindEgressRelay,
): Promise<Response> {
  // POC shape: the Worker materializes secret placeholders, then runs TLS
  // locally. The relay only dials TCP and shuttles encrypted TLS records, so it
  // sees the target host/port but not HTTP headers, body, or the substituted
  // secret. The connection is method-based RPC because deployed Cap'n Web did
  // not reliably return Web Stream chunks for this path. HTTP parsing is
  // intentionally narrow: HTTP/1.1 content-length, chunked, or close-delimited
  // responses up to MAX_BLIND_RELAY_RESPONSE_BYTES.
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    return Response.json({ error: "blind relay egress only supports https" }, { status: 400 });
  }

  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Response.json({ error: "invalid blind relay port" }, { status: 400 });
  }

  const requestBytes = await serializeHttpRequest(request, url);
  const connection = await relay.dial({ host: url.hostname, port });
  const responseBytes = await runTlsHttpRequest({
    connection,
    hostname: url.hostname,
    pinnedCertSha256: request.headers.get(BLIND_RELAY_PINNED_CERT_SHA256_HEADER),
    requestBytes,
    skipTlsVerify: request.headers.get(INSECURE_BLIND_RELAY_SKIP_TLS_VERIFY_HEADER) === "1",
  });
  return parseHttpResponse(responseBytes);
}

async function runTlsHttpRequest({
  connection,
  hostname,
  pinnedCertSha256,
  requestBytes,
  skipTlsVerify,
}: {
  connection: BlindEgressRelayConnection;
  hostname: string;
  pinnedCertSha256: string | null;
  requestBytes: Uint8Array;
  skipTlsVerify: boolean;
}): Promise<Uint8Array> {
  let settled = false;
  let leafCertificate: X509Certificate | undefined;
  const responseChunks: Uint8Array[] = [];
  const progress = {
    encryptedWrites: 0,
    handshakeDone: false,
    receivedCertificates: 0,
    receivedEncryptedChunks: 0,
    requestWritten: false,
    startHandshakeResolved: false,
    startHandshakeStarted: false,
  };

  return await new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => {
      fail(
        new Error(
          `timed out waiting for blind relay HTTP response (${concatBytes(responseChunks).byteLength} bytes received, progress=${JSON.stringify(progress)})`,
        ),
      );
    }, 15_000);

    const client = makeTLSClient({
      host: hostname,
      logger: silentTlsLogger,
      verifyServerCertificate: pinnedCertSha256 === null && !skipTlsVerify,
      write: async ({ header, content }) => {
        progress.encryptedWrites += 1;
        await connection.write(concatBytes([header, content]));
      },
      onRecvCertificates: ({ certificates }) => {
        progress.receivedCertificates = certificates.length;
        leafCertificate = certificates[0];
      },
      onHandshake: () => {
        progress.handshakeDone = true;
        void sendRequest();
      },
      onApplicationData: (data) => {
        if (data.byteLength === 0) return;
        responseChunks.push(data);
        const responseBytes = concatBytes(responseChunks);
        if (responseBytes.byteLength > MAX_BLIND_RELAY_RESPONSE_BYTES) {
          fail(new Error("blind relay response exceeded maximum POC response size"));
          return;
        }
        const completeLength = completedHttpResponseLength(responseBytes);
        if (completeLength !== undefined) complete(responseBytes.slice(0, completeLength));
      },
      onTlsEnd: (error) => {
        if (error !== undefined) {
          fail(error);
          return;
        }
        if (responseChunks.length > 0) complete(concatBytes(responseChunks));
        else fail(new Error("blind relay TLS connection closed before response"));
      },
    });

    progress.startHandshakeStarted = true;
    client
      .startHandshake()
      .then(() => {
        progress.startHandshakeResolved = true;
      })
      .catch(fail);
    void pumpEncryptedInput(client);

    async function sendRequest() {
      try {
        if (pinnedCertSha256 !== null) {
          if (leafCertificate === undefined) {
            throw new Error("blind relay TLS connection did not receive a certificate");
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
          progress.receivedEncryptedChunks += 1;
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
  headers.delete(BLIND_RELAY_PINNED_CERT_SHA256_HEADER);
  headers.delete(INSECURE_BLIND_RELAY_SKIP_TLS_VERIFY_HEADER);
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

function parseHttpResponse(bytes: Uint8Array): Response {
  const headerEnd = indexOfHeaderEnd(bytes);
  if (headerEnd === -1) throw new Error("blind relay response did not contain HTTP headers");

  const headerText = textDecoder.decode(bytes.slice(0, headerEnd));
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?: (.*))?$/.exec(statusLine ?? "");
  if (statusMatch === null) {
    throw new Error(`blind relay response had invalid status line: ${statusLine ?? ""}`);
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
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const lineEnd = indexOfCrlf(bytes, offset);
    if (lineEnd === -1) throw new Error("blind relay chunked response was truncated");
    const sizeLine = textDecoder.decode(bytes.slice(offset, lineEnd));
    const size = Number.parseInt(sizeLine.split(";", 1)[0]!.trim(), 16);
    if (!Number.isFinite(size)) throw new Error(`invalid chunk size: ${sizeLine}`);
    offset = lineEnd + 2;
    if (size === 0) return concatBytes(chunks);
    chunks.push(bytes.slice(offset, offset + size));
    offset += size + 2;
  }
  throw new Error("blind relay chunked response missing final chunk");
}

function completedHttpResponseLength(bytes: Uint8Array): number | undefined {
  const headerEnd = indexOfHeaderEnd(bytes);
  if (headerEnd === -1) return undefined;
  const headerText = textDecoder.decode(bytes.slice(0, headerEnd));
  const headerLines = headerText.split("\r\n").slice(1);
  const contentLengthLine = headerLines.find((line) => /^content-length:/i.test(line));
  if (contentLengthLine !== undefined) {
    const contentLength = Number(contentLengthLine.slice(contentLengthLine.indexOf(":") + 1));
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error(`invalid content-length: ${contentLengthLine}`);
    }
    const totalLength = headerEnd + 4 + contentLength;
    return bytes.byteLength >= totalLength ? totalLength : undefined;
  }

  const transferEncodingLine = headerLines.find((line) => /^transfer-encoding:/i.test(line));
  if (/\bchunked\b/i.test(transferEncodingLine ?? "")) {
    const chunkedBodyEnd = completedChunkedBodyLength(bytes.slice(headerEnd + 4));
    return chunkedBodyEnd === undefined ? undefined : headerEnd + 4 + chunkedBodyEnd;
  }

  return undefined;
}

function completedChunkedBodyLength(bytes: Uint8Array): number | undefined {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const lineEnd = indexOfCrlf(bytes, offset);
    if (lineEnd === -1) return undefined;
    const sizeLine = textDecoder.decode(bytes.slice(offset, lineEnd));
    const size = Number.parseInt(sizeLine.split(";", 1)[0]!.trim(), 16);
    if (!Number.isFinite(size)) throw new Error(`invalid chunk size: ${sizeLine}`);
    offset = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = indexOfHeaderEnd(bytes, offset);
      return trailerEnd === -1 ? undefined : trailerEnd + 4;
    }
    offset += size + 2;
  }
  return undefined;
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
