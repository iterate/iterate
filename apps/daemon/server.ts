import { startServer } from "./server/start.ts";

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);

startServer({ port, hostname });
