import { writeFile } from "node:fs/promises";
import { URL } from "node:url";
import mockttp from "mockttp";
import { request } from "undici";

const EXTERNAL_EGRESS_PROXY = process.env.EXTERNAL_EGRESS_PROXY ?? "http://127.0.0.1:8082";
const MITM_PORT = 8081;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function main(): Promise<void> {
  const ca = await mockttp.generateCACertificate();
  await writeFile("ca.pem", ca.cert, "utf8");

  console.log("MITM CA saved to ./ca.pem");
  console.log("Fingerprint:", ca.certFingerprint256);

  const server = mockttp.getLocal({ https: ca });

  await server.forAnyRequest().thenCallback(async (req) => {
    const originalUrl = req.url;
    const parsedOriginalUrl = new URL(originalUrl);
    const originalHost = firstHeaderValue(req.headers.host) ?? parsedOriginalUrl.host;
    const originalScheme = parsedOriginalUrl.protocol.startsWith("https") ? "https" : "http";

    console.log(`[MITM] Intercepted ${req.method} ${originalUrl}`);

    const forwardHeaders: Record<string, string> = {
      ...req.headers,
      host: new URL(EXTERNAL_EGRESS_PROXY).host,
      "x-original-url": originalUrl,
      "x-original-host": originalHost,
      "x-original-scheme": originalScheme,
    };

    const targetPath = `${parsedOriginalUrl.pathname}${parsedOriginalUrl.search}`;
    const bodyBuffer = req.body ? await req.body.getDecodedBuffer() : undefined;

    const response = await request(`${EXTERNAL_EGRESS_PROXY}${targetPath}`, {
      method: req.method,
      headers: forwardHeaders,
      body: bodyBuffer,
    });
    const responseBody = response.body ? Buffer.from(await response.body.arrayBuffer()) : undefined;

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: responseBody,
    };
  });

  await server.start(MITM_PORT);
  console.log(`MITM proxy running on http://127.0.0.1:${String(MITM_PORT)}`);
  console.log(`EXTERNAL_EGRESS_PROXY=${EXTERNAL_EGRESS_PROXY}`);
}

void main().catch((error) => {
  console.error("MITM bootstrap failed", error);
  process.exitCode = 1;
});
