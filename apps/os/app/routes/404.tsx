import { ErrorRenderer } from "../components/error-renderer.tsx";

export default function NotFound() {
  return (
    <ErrorRenderer message="Page not found" details="The page you're looking for doesn't exist." />
  );
}
