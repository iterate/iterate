// A deterministic slow image server, so "the download timed out" is a fact
// rather than a hope about somebody else's website.
//
// The timeout case used `httpbin.org/drip?duration=60&numbytes=400000` and
// failed: the device refused it in 849ms as "too-large", because 400,000 bytes
// is past the firmware's MAX_BODY_BYTES of 384 KiB, so the size gate answered
// long before anything could be slow. A fixture that fails the wrong gate does
// not test the gate it was written for — and worse, it LOOKED like a device
// fault.
//
// So the fixture is local and explicit: a real baseline JPEG, a truthful
// Content-Length comfortably under the cap, and a body that stops arriving. The
// device's image deadline (15s) fires while the connection is still open and
// still perfectly healthy, which is exactly the condition being tested.
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";

/** The device's own limits, from waveshare_image.c — the numbers this must respect. */
export const DEVICE_IMAGE_LIMITS = {
  /** `MAX_BODY_BYTES`: a declared length past this is refused as "too-large". */
  maxBodyBytes: 384 * 1024,
  /** `DEADLINE_MS`: the whole fetch, after which the device answers "timeout". */
  deadlineMs: 15_000,
  /** `STALL_MS`: one socket read's patience, so silence longer than this stalls. */
  stallMs: 4_000,
} as const;

/**
 * Why a byte string is not the bounded baseline JPEG this fixture needs.
 *
 * Checked rather than assumed, because every failure mode here is one the device
 * reports with a DIFFERENT word than "timeout" — and a fixture that trips
 * `too-large` or `unsupported-format` would quietly turn the timeout case into a
 * second copy of a case that already passes.
 */
export function baselineJpegProblems(bytes: Uint8Array): string[] {
  const problems: string[] = [];
  if (bytes.length === 0) return ["the fixture image is empty"];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    problems.push("the fixture image does not start with a JPEG SOI marker");
  }
  if (bytes.length >= DEVICE_IMAGE_LIMITS.maxBodyBytes) {
    problems.push(
      `the fixture image is ${bytes.length} bytes, at or past the device's ` +
        `${DEVICE_IMAGE_LIMITS.maxBodyBytes} byte cap — the device would answer "too-large" ` +
        `instead of "timeout"`,
    );
  }
  /* SOF0/SOF1 is baseline; SOF2 is progressive, which the ROM decoder refuses. */
  let baseline = false;
  let progressive = false;
  for (let at = 2; at + 1 < bytes.length; at++) {
    if (bytes[at] !== 0xff) continue;
    const marker = bytes[at + 1];
    if (marker === 0xc0 || marker === 0xc1) baseline = true;
    if (marker === 0xc2) progressive = true;
  }
  if (progressive) {
    problems.push(
      'the fixture image is progressive (SOF2) — the device would answer "unsupported-format"',
    );
  }
  if (!baseline && !progressive) {
    problems.push("the fixture image has no SOF0/SOF1 frame header; it is not a baseline JPEG");
  }
  return problems;
}

/** This machine's address on the lab network, which is where the device is. */
export function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error(
    "no non-internal IPv4 address on this machine, so the device has no way to reach a local " +
      "fixture. Pass --stalling-url instead.",
  );
}

/**
 * A minimal, valid PNG: 1x1, greyscale, one IDAT. Embedded rather than fetched
 * because `httpbin.org/image/png` failed the proof twice — once serving an HTTP
 * error where the case expected "unsupported-format", which read as a device
 * fault and was somebody else's website having a bad minute.
 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg==";

/**
 * Rewrite a baseline JPEG's frame header so the device sees a PROGRESSIVE frame.
 *
 * The firmware refuses progressive JPEG on the marker — SOF2 — before it decodes
 * anything, because the ROM's TJpgDec cannot handle it. Flipping SOF0 to SOF2
 * exercises exactly that guard with bytes we control, instead of depending on a
 * CDN to keep serving a progressive file.
 */
export function asProgressiveJpeg(baseline: Uint8Array): Uint8Array {
  const patched = new Uint8Array(baseline);
  for (let at = 2; at + 1 < patched.length; at++) {
    if (patched[at] === 0xff && patched[at + 1] === 0xc0) {
      patched[at + 1] = 0xc2;
      return patched;
    }
  }
  throw new Error("no SOF0 marker to rewrite; the source is not a baseline JPEG");
}

/**
 * Rewrite a baseline JPEG's declared dimensions so it cannot fit the panel.
 *
 * The device has two independent size guards: a Content-Length cap, and the
 * decoded frame being larger than 368x448. This exercises the second one — the
 * one a real oversized photo trips — without needing an encoder or a CDN.
 */
export function withDeclaredSize(baseline: Uint8Array, width: number, height: number): Uint8Array {
  const patched = new Uint8Array(baseline);
  for (let at = 2; at + 1 < patched.length; at++) {
    if (patched[at] !== 0xff) continue;
    const marker = patched[at + 1]!;
    if (marker !== 0xc0 && marker !== 0xc1) continue;
    /* SOF payload: length(2) precision(1) height(2) width(2) */
    const payload = at + 2;
    patched[payload + 3] = (height >> 8) & 0xff;
    patched[payload + 4] = height & 0xff;
    patched[payload + 5] = (width >> 8) & 0xff;
    patched[payload + 6] = width & 0xff;
    return patched;
  }
  throw new Error("no SOF0/SOF1 marker to resize; the source is not a baseline JPEG");
}

/** A running fixture: where the device should fetch, and how to shut it down. */
export interface SlowImageFixture {
  /** A valid baseline JPEG served immediately — for verifying the CONTENT. */
  fastUrl: string;
  /** The same baseline JPEG on a second path, for the concurrent-overlap case. */
  otherUrl: string;
  /** The same bytes, served too slowly to finish — for verifying the TIMEOUT. */
  slowUrl: string;
  /** A real PNG, which the ROM decoder must refuse. */
  pngUrl: string;
  /** The same JPEG marked progressive (SOF2), which must also be refused. */
  progressiveUrl: string;
  /** The same JPEG declaring 800x900, which cannot fit the panel. */
  oversizeUrl: string;
  bytes: number;
  close(): Promise<void>;
}

/**
 * Serve `image` fast on one path and stalled on another.
 *
 * The stalled response is deliberately NOT a truncated one: headers are sent
 * with the real Content-Length, a first slice goes out so the device commits to
 * the download, and then nothing more arrives. Every socket read after that hits
 * the device's 4s patience, the 15s whole-fetch deadline expires, and the
 * connection was healthy the entire time — which is what separates this from a
 * dropped connection or a refused request.
 */
export async function startSlowImageFixture(image: Uint8Array): Promise<SlowImageFixture> {
  const problems = baselineJpegProblems(image);
  if (problems.length > 0) {
    throw new Error(`the slow-image fixture was given unusable bytes: ${problems.join("; ")}`);
  }
  /* Enough to be a committed download, far too little to be a picture. */
  const firstSlice = image.subarray(0, Math.min(64, image.length));
  const sockets = new Set<{ destroy: () => void }>();

  const png = Buffer.from(TINY_PNG_BASE64, "base64");
  const progressive = Buffer.from(asProgressiveJpeg(image));
  const oversize = Buffer.from(withDeclaredSize(image, 800, 900));
  /*
   * A second PATH serving the same valid bytes. The overlap case needs two
   * concurrent requests, not two different pictures — and patching the declared
   * dimensions to make them differ produced "decode-failed", because the header
   * then disagrees with the entropy-coded data it describes.
   */
  const other = Buffer.from(image);

  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    const body = path.startsWith("/png")
      ? png
      : path.startsWith("/progressive")
        ? progressive
        : path.startsWith("/oversize")
          ? oversize
          : path.startsWith("/other")
            ? other
            : null;
    if (body !== null) {
      response.setHeader("content-type", path.startsWith("/png") ? "image/png" : "image/jpeg");
      response.setHeader("content-length", String(body.length));
      response.end(body);
      return;
    }
    const slow = path.startsWith("/slow");
    response.setHeader("content-type", "image/jpeg");
    response.setHeader("content-length", String(image.length));
    if (!slow) {
      response.end(Buffer.from(image));
      return;
    }
    sockets.add(request.socket);
    request.socket.on("close", () => sockets.delete(request.socket));
    response.write(Buffer.from(firstSlice));
    /*
     * And then silence, held well past the device's deadline. No timer finishes
     * this body: the device must be the one to give up, which is the assertion.
     */
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the slow-image fixture did not bind a port");
  }
  const base = `http://${lanAddress()}:${String(address.port)}`;
  return {
    bytes: image.length,
    fastUrl: `${base}/fast.jpg`,
    otherUrl: `${base}/other.jpg`,
    oversizeUrl: `${base}/oversize.jpg`,
    pngUrl: `${base}/png.png`,
    progressiveUrl: `${base}/progressive.jpg`,
    slowUrl: `${base}/slow.jpg`,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
