import { createServer, type IncomingMessage } from "node:http";

const checkAuth = (req: IncomingMessage) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return false;
  const token = authHeader.split(" ")[1] ?? authHeader;
  console.log({ token, machineAuthToken: process.env.MACHINE_AUTH_TOKEN });
  return token === process.env.MACHINE_AUTH_TOKEN;
};

const server = createServer((req, res) => {
  console.log({ url: req.url, method: req.method });
  if (req.url?.endsWith("/command/ping") && req.method === "POST") {
    if (!checkAuth(req)) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    res.statusCode = 200;
    res.end("pong");
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
});

server.listen(3000, () => {
  console.log("Server is running on port 3000");
});

process.on("SIGINT", () => {
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
