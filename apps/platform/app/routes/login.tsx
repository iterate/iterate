import type { Route } from "./+types/login";
import { LoginPrompt } from "../components/login-prompt";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Login - Iterate" },
    { name: "description", content: "Sign in to your Iterate account" },
  ];
}

export default function Login() {
  return <LoginPrompt />;
}
