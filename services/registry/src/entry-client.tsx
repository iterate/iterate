import { RouterClient } from "@tanstack/react-router/ssr/client";
import { hydrateRoot } from "react-dom/client";
import { createRouter } from "./router.tsx";
import "./styles.css";

function getInitialAppCssHrefs() {
  const links = document.querySelectorAll<HTMLLinkElement>("link[data-app-css]");
  return Array.from(links)
    .map((link) => {
      try {
        return new URL(link.href).pathname;
      } catch {
        return null;
      }
    })
    .filter((href): href is string => href !== null);
}

const router = createRouter({
  appCssHrefs: getInitialAppCssHrefs(),
});

hydrateRoot(document, <RouterClient router={router} />);
