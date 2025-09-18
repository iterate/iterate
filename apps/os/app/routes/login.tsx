import { LoginPrompt } from "../components/login-prompt.tsx";
import type { Route } from "./+types/login";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Login - Iterate" },
    { name: "description", content: "Sign in to your Iterate account" },
  ];
}

export default function Login() {
  return <LoginPrompt />;
}
