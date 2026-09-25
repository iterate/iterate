// context/websocket-close.ts — what a WebSocket may be closed with, for a close relayed from another
// socket (rpc-stubs.ts, fetch-upgrade-splice.ts, project-host-lease.ts).

/** A close code a socket may send: the ones only a runtime reports (1005 none, 1006 abnormal, 1015
 *  TLS), the reserved 1004 and anything out of range become 1000; so does an absent code. */
export function sendableCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014))
    return code;
  return code >= 3000 && code <= 4999 ? code : 1000;
}

/** A close reason within the RFC's 123 UTF-8 bytes, whole characters: workerd enforces the cap and
 *  THROWS past it, so a UTF-16 `.slice(0, 123)` is not enough for a multibyte reason. */
export function truncateCloseReason(reason: string): string {
  let out = reason;
  while (new TextEncoder().encode(out).length > 123) out = out.slice(0, -1);
  return out;
}
