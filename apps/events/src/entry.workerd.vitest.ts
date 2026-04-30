import { StreamDurableObject } from "~/durable-objects/stream.ts";

export default {
  fetch() {
    return new Response("ok");
  },
};

export { StreamDurableObject };
