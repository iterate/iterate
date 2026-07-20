import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Guestbook } from "./app.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

createRoot(root).render(
  <Switch>
    <Route path="/" component={Guestbook} />
    <Route>
      <main style={{ padding: 48, fontFamily: "system-ui, sans-serif" }}>
        <p>Not found.</p>
      </main>
    </Route>
  </Switch>,
);
