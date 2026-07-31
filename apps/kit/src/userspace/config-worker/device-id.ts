const kitDeviceIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * A device identity is a single conservative path segment shared by the
 * capability mount, PCM authentication header, and durable evidence stream.
 * Keeping this test in one dependency-free module prevents those boundaries
 * from gradually accepting different spellings for the same physical board.
 */
export function isKitDeviceId(value: string): boolean {
  return kitDeviceIdPattern.test(value);
}
