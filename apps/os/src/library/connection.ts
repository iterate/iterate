// library/connection.ts — what the three connectors share: the per-connection subclass whose
// prototype carries one method per remote name, and the one spelling of a refused response.

/** A per-connection subclass whose PROTOTYPE carries one method per name — prototype members are what
 *  Workers RPC and capnweb traverse, so `conn.echo({ … })` works held across calls, not only inside
 *  one dotted expression. A name the base already declares (its own methods, `constructor`, whatever
 *  `RpcTarget` adds) stays reachable through the generic door only; so does a name that is not an
 *  identifier, and `then` — a thenable connection would be adopted as a promise by any await and
 *  never settle. */
export function subclassWithMethods<Base extends abstract new (...args: never[]) => object>(
  base: Base,
  names: string[],
  call: (self: InstanceType<Base>, name: string, input: unknown) => unknown,
): Base {
  const Subclass = class extends (base as abstract new (...args: never[]) => object) {};
  for (const name of names) {
    if (name === "then" || name in Subclass.prototype || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    Object.defineProperty(Subclass.prototype, name, {
      value(this: InstanceType<Base>, input?: unknown) {
        return call(this, name, input);
      },
      writable: true,
      configurable: true,
    });
  }
  return Subclass as unknown as Base;
}

/** The error for a response that refused: `<what> returned <status>: <the first 300 characters>`.
 *  The body is read only that far, then CANCELLED — a refusal's snippet must never buffer a whole
 *  error page. */
export async function responseRefusal(response: Response, what: string): Promise<Error> {
  const reader = response.body?.getReader();
  let snippet = "";
  if (reader) {
    const decoder = new TextDecoder();
    try {
      while (snippet.length < 300) {
        const { done, value } = await reader.read();
        if (done) break;
        snippet += decoder.decode(value, { stream: true });
      }
    } catch {
      /* a body that cannot be read adds nothing to the refusal */
    } finally {
      reader.cancel().catch(() => undefined);
    }
    snippet = snippet.slice(0, 300);
  }
  return new Error(`${what} returned ${response.status}${snippet ? `: ${snippet}` : ""}`);
}

/** The response, or the refusal thrown — ONE spelling for every non-2xx the connectors meet. */
export async function refuseUnlessOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  throw await responseRefusal(response, what);
}
