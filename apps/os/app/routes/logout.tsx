import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/logout")({
  component: LogoutPage,
});

function LogoutPage() {
  useEffect(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/iterate-auth/logout";
    document.body.appendChild(form);
    form.submit();
  }, []);

  return null;
}
