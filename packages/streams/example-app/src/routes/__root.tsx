/// <reference types="vite/client" />
import { createRootRoute } from "@tanstack/react-router";
import appCss from "../styles/app.css?url";
import { RootComponent } from "./-root-document.tsx";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Stream Staging Area" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});
