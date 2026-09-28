// context/redial.ts — THE ONE RE-DIAL of a socket a stateless invocation holds to a context Durable
// Object: a lent stub's pager (rpc-stub-relay.ts) and either end of a resumable upgrade
// (fetch-upgrade-splice.ts). Every deploy resets every Durable Object and cuts those sockets; the
// invocation holding the other end outlives the reset, and dials again.
//
// One try at a time: at once, then after 250 ms, the wait doubling to 8 s, while the next starts
// within the caller's `deadlineMs` of the drop (30 s: eight tries over ~24 s; 60 s: twelve over
// ~56 s). A throw or a 5xx is the context not ready yet (a deploy's reset answers again within
// seconds) and is tried again; any other answer without a socket is its refusal (a paused stream).
// A dial still pending at the deadline is given up and never dialed again beside, since a socket
// it brings late would replace one a later try brought back.

/** A context's answer to a socket dial: as much of its Response as a re-dial reads. */
type DialAnswer = { status: number; webSocket?: WebSocket | null; body?: ReadableStream | null };

/** Dial until the context answers a socket, for at most `deadlineMs` from now (the drop): the answer
 *  and its socket, accepted; why it gave up; or null once `unwanted()` (the lend recalled, the
 *  upgrade ended), a socket it brings then closed. `dials` counts the tries. */
export async function redial<Answer extends DialAnswer>(
  dial: () => Promise<Answer>,
  unwanted: () => boolean,
  deadlineMs: number,
): Promise<
  { socket: WebSocket; answer: Answer; dials: number } | { gaveUp: string; dials: number } | null
> {
  const deadline = Date.now() + deadlineMs;
  let wait = 250;
  for (let dials = 1; ; dials += 1) {
    if (unwanted()) return null;
    const tried = await dialOnce(dial, deadline, deadlineMs);
    if ("socket" in tried) {
      if (!unwanted()) return { ...tried, dials };
      closeAbandoned(tried.socket);
      return null;
    }
    if (tried.final || Date.now() + wait >= deadline)
      return unwanted() ? null : { gaveUp: tried.failure, dials };
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, 8_000);
  }
}

/** One dial, raced against the deadline: its socket, accepted; or why it failed, `final` when
 *  trying again cannot help (a refusal, the deadline). */
async function dialOnce<Answer extends DialAnswer>(
  dial: () => Promise<Answer>,
  deadline: number,
  deadlineMs: number,
): Promise<{ socket: WebSocket; answer: Answer } | { failure: string; final: boolean }> {
  // a dial that throws before its promise is a failed try too, not a rejection of the re-dial
  const dialing = Promise.resolve().then(dial);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: Answer | null;
  try {
    answer = await Promise.race([
      dialing,
      new Promise<null>(
        (resolve) => (timer = setTimeout(() => resolve(null), deadline - Date.now())),
      ),
    ]);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), final: false };
  } finally {
    clearTimeout(timer);
  }
  if (!answer) {
    void dialing.then(
      (late) => late.webSocket && closeAbandoned(late.webSocket, true),
      () => {},
    );
    return { failure: `no answer within ${deadlineMs / 1000} s of the drop`, final: true };
  }
  if (answer.status === 101 && answer.webSocket) {
    answer.webSocket.accept();
    return { socket: answer.webSocket, answer };
  }
  await answer.body?.cancel();
  return { failure: `the context answered ${answer.status}`, final: answer.status < 500 };
}

/** A socket no one wants any more, closed as meant (one that arrived late accepted first). */
function closeAbandoned(socket: WebSocket, late = false): void {
  try {
    if (late) socket.accept();
    socket.close(1000, "re-dial abandoned");
  } catch {
    /* already closing */
  }
}
