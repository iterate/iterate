export default {
  async fetch(request) {
    if (request.headers.get("x-iterate-app-slug") !== "app1") return;
    return new Response("hello from app one");
  },
};
