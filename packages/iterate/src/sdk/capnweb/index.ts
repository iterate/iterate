// `iterate/sdk/capnweb` — the project-independent Cap'n Web SDK surface.
// Re-exporting the transport primitives and LiveState from one entry keeps a
// consuming app on the exact Cap'n Web class identity used inside Iterate.
export * from "capnweb";
export * from "./live-state/index.ts";
