// context/websocket-close.ts — THE ONE CLOSE-CODE POLICY for a close relayed from one WebSocket to
// another (rpc-stubs.ts, fetch-upgrade-splice.ts, project-host-lease.ts; the CLI's tunnel keeps a
// copy, packages/cli src/tunnel.ts, since it is published on its own).

/** What a socket that dropped is closed with: the drop was not an orderly end, and a client told
 *  1000 may take the end as meant and not reconnect. */
export const DROPPED_CLOSE_CODE = 1011;

/** The code a relayed close carries on. An orderly code passes through, and a close frame without
 *  one (1005, or none at all) was orderly too: 1000. A connection that dropped (1006; 1015 for TLS),
 *  the reserved 1004 and anything no endpoint may send become `DROPPED_CLOSE_CODE`. */
export function relayedCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005) return 1000;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  return code >= 3000 && code <= 4999 ? code : DROPPED_CLOSE_CODE;
}

/** A close reason within the RFC's 123 UTF-8 bytes, whole characters: workerd enforces the cap and
 *  THROWS past it, so a UTF-16 `.slice(0, 123)` is not enough for a multibyte reason. */
export function truncateCloseReason(reason: string): string {
  let out = reason;
  while (new TextEncoder().encode(out).length > 123) out = out.slice(0, -1);
  return out;
}
