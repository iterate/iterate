export { Stream } from "./stream/v0/stream.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.STREAM.getByName(url.pathname);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
