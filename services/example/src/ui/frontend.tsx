import "@vitejs/plugin-react/preamble";
import "@iterate-com/ui/globals.css";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root container");

createRoot(container).render(<App />);
