// Holding a capnweb context stub in React: a page opens `api.user`, `api.organizations.get(id)` or
// `api.projects.get(id)` and keeps it while it is mounted. Every open stub is a subscription row and
// a pinned Durable Object on the platform, so it is disposed on unmount and on every re-open — also
// when it arrives after the component has already moved on.
import { useEffect, useState, type DependencyList } from "react";
import { z } from "zod";
import { useLiveState, type IterateContextHandle } from "iterate/react";

type ContextStubState<S> = { stub?: S; error?: string; pending: boolean };

/** Opens a stub with `open()` and holds it until `deps` change or the component unmounts; `open`
 *  null opens nothing (a session that may not). `pending` while an open is in flight; `error` the
 *  refusal. A dep change clears the previous stub before the next one lands. */
export function useContextStub<S extends Disposable>(
  open: (() => PromiseLike<S>) | null,
  deps: DependencyList,
): ContextStubState<S> {
  const [state, setState] = useState<ContextStubState<S>>(() => ({ pending: Boolean(open) }));
  useEffect(() => {
    if (!open) {
      setState({ pending: false });
      return;
    }
    setState((previous) => (previous.pending && !previous.stub ? previous : { pending: true }));
    let disposed = false;
    let held: S | undefined;
    // The stub is held inside an object: a capnweb stub is a callable proxy, and handed to a state
    // setter directly React would take it for an updater and CALL it.
    open().then(
      (stub) => {
        if (disposed) return stub[Symbol.dispose]();
        held = stub;
        setState({ stub, pending: false });
      },
      (caught: unknown) =>
        !disposed &&
        setState({
          error: caught instanceof Error ? caught.message : String(caught),
          pending: false,
        }),
    );
    return () => {
      disposed = true;
      held?.[Symbol.dispose]();
    };
    // `open` is a fresh closure every render; the caller's `deps` are what it closes over
  }, deps);
  return state;
}

/** A hosted facet's live state on a held context: its `liveSnapshot()` seeds `useLiveState`. */
export function useFacetLiveState(stub: IterateContextHandle | undefined, facet: string) {
  return useLiveState<unknown>(stub, {
    key: facet,
    readSeed: async () =>
      z
        .object({ rev: z.number(), state: z.unknown() })
        .parse(await stub!.invoke(`itx.facets.get('${facet}').liveSnapshot()`)),
  });
}
