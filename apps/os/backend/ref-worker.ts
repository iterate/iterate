export * from "./ref-object-exports.ts";
export default {
  fetch() {
    return new Response(`I am a Ref Worker`, { status: 418 /* I'm a teapot */ });
  },
};
