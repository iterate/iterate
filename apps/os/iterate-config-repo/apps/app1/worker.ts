export default {
  async fetch(request: Request) {
    if (request.headers.get("x-iterate-app-slug") !== "app1") return;
    return new Response("hello from app one");
  },
};
