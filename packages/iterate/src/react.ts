// `iterate/react` — the React surface for itx: hooks over the framework-free
// keeper in `iterate/client`, with TanStack Query for reads. Renderer-agnostic:
// the same hooks run under react-dom, @opentui/react, and React Native (see
// ./itx/itx-react.ts). This entry is one-stop — it re-exports the imperative
// keeper surface too, so a component file imports from exactly one place.
export * from "./itx/itx-react.ts";
