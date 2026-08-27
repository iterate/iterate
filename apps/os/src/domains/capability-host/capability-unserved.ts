// The two "nobody is serving this capability" failure shapes, owned in one
// place: never mounted (or revoked), and mounted-but-provider-away (the live
// mount's Pager is offline). Platform consumers that translate these into a
// domain error (the AI interceptor consult) need to RECOGNIZE them after a
// Workers RPC hop — which delivers plain Errors, not subclasses — so the
// contract is the message itself: factories here, predicate here, and no
// caller hand-writing the strings.

function noCapabilityMessage(path: string[]): string {
  return `no capability "${path.join(".")}"`;
}

function capabilityOfflineMessage(path: string[]): string {
  return `capability "${path.join(".")}" is offline`;
}

export function noCapabilityError(path: string[]): Error {
  return new Error(noCapabilityMessage(path));
}

export function capabilityOfflineError(path: string[]): Error {
  return new Error(capabilityOfflineMessage(path));
}

/** Whether an error (possibly relayed over RPC) says the capability at `path` is unserved. */
export function isCapabilityUnservedError(error: unknown, path: string[]): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(noCapabilityMessage(path)) || message.includes(capabilityOfflineMessage(path))
  );
}
