import { StrictMode, createElement, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

startTransition(() => {
  hydrateRoot(document, createElement(StrictMode, undefined, createElement(StartClient)));
});
