// Minimal ULID (https://github.com/ulid/spec): 48-bit millisecond timestamp +
// 80 random bits, Crockford base32, 26 chars, lexically sortable by time.
// Hand-rolled instead of a dependency: the codec treats ids as opaque tokens,
// so only generation lives here.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function cryptoRandom(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function ulid(
  timestamp = Date.now(),
  random: (bytes: number) => Uint8Array = cryptoRandom,
): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 2 ** 48 - 1) {
    throw new Error(`ulid timestamp out of range: ${timestamp}`);
  }
  let time = "";
  let t = timestamp;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(10);
  if (bytes.length !== 10) {
    throw new Error(`ulid random source returned ${bytes.length} bytes, expected 10`);
  }
  // 10 bytes = 80 bits = 16 base32 chars, consumed 5 bits at a time.
  let rand = "";
  let acc = 0;
  let accBits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      rand += CROCKFORD[(acc >> accBits) & 31];
      acc &= (1 << accBits) - 1;
    }
  }
  return time + rand;
}

export function newThreadId(): string {
  return `th_${ulid()}`;
}

export function newCommentId(): string {
  return `cm_${ulid()}`;
}
