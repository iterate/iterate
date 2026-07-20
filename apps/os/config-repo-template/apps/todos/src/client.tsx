import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Todos } from "./app.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

createRoot(root).render(
  <Switch>
    <Route path="/" component={Todos} />
    <Route>
      <main style={{ padding: 48, fontFamily: "system-ui, sans-serif" }}>
        <p>Not found.</p>
      </main>
    </Route>
  </Switch>,
);
