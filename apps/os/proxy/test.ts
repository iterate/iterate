import { WebSocket } from "ws";
const ws = new WebSocket("http://localhost:1337/api/pty/ws", {
  headers: {
    "X-Iterate-Machine-Id": "mach_01kgpwc4xye48vhyjw8ww4ky8e",
    "X-Iterate-Port": "3000",
  },
});

ws.on("open", () => {
  console.log("Connected to server");
});

ws.on("message", (message) => {
  console.log("Received message:", message.toString());
});

ws.on("error", (error) => {
  console.error("WebSocket error:", error);
});
