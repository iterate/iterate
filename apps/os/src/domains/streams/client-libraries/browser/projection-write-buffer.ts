// The server-feed prototype and the existing browser mirror share one write
// buffer implementation. The browser path remains active while ownership is
// still an open architecture decision.
export { ProjectionWriteBuffer as BrowserProjectionWriteBuffer } from "../../feed/projection-write-buffer.ts";
