import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("Missing #root container");
}

const root = createRoot(container);
root.render(<App />);
