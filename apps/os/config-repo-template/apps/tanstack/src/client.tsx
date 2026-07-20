import { hydrateRoot } from "react-dom/client";
import { Todos } from "./app.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
hydrateRoot(root, <Todos />);
