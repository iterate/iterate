import { Link } from "@tanstack/react-router";

export function DefaultNotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4">
      <p className="text-lg font-medium text-foreground">Page not found</p>
      <Link to="/" className="text-primary underline underline-offset-4 hover:text-primary/90">
        Go home
      </Link>
    </div>
  );
}
