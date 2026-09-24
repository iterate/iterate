/** Open a WebSocket, trying again for a while when the connection fails: a phone waking up, a
 *  tunnel flapping, a cold edge — the things a first attempt trips over. Resolves with the socket
 *  once it is OPEN; rejects with the last failure after the last attempt. The delays are the
 *  waits BETWEEN attempts (the first is immediate). */
const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000];

export function openSocketWithRetry(
  url: string | URL,
  options: {
    delaysMs?: readonly number[];
    /** the constructor to use — a test's fake, `WebSocket` otherwise */
    WebSocket?: typeof WebSocket;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<WebSocket> {
  const delays = options.delaysMs || RETRY_DELAYS_MS;
  const Socket = options.WebSocket || WebSocket;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const once = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new Socket(url);
      const opened = () => {
        socket.removeEventListener("close", failed);
        resolve(socket);
      };
      const failed = () => {
        socket.removeEventListener("open", opened);
        reject(new Error("WebSocket connection failed."));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
  return (async () => {
    let attempt = 0;
    for (;;) {
      try {
        return await once();
      } catch (error) {
        if (attempt >= delays.length) throw error;
        await sleep(delays[attempt]!);
        attempt += 1;
      }
    }
  })();
}
