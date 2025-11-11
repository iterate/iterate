import { createServer } from "node:http";
import { createContext, Script } from "node:vm";

const PORT = Number.parseInt(process.env.PORT ?? "7001", 10);

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    try {
      const sandbox = createContext({
        console,
        Promise,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        fetch,
      });
      const { status, json } = await Promise.resolve()
        .then(() => new Script(body).runInContext(sandbox, { timeout: 60_000 }))
        .then((result) => ({ status: 200, json: result }))
        .catch((error) => ({ status: 400, json: { error: { message: String(error) } } }));

      const data = JSON.stringify(json);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data);
    } catch (error) {
      console.error("Error handling eval request:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Internal server error" } }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Eval server listening on http://localhost:${PORT}`);
});
