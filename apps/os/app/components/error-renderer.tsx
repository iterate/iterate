import { AlertCircle, Home, RotateCcw } from "lucide-react";
import { Link } from "react-router";
import { useEffect } from "react";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";

export function ErrorRenderer({
  message,
  details,
  stack,
}: {
  message: string;
  details: string;
  stack?: string;
}) {
  useEffect(() => {
    console.error({ message, details, stack });
  }, [message, details, stack]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl mx-auto text-center">
        <div className="mb-8 flex justify-center">
          <div className="p-6 rounded-full bg-destructive/10">
            <AlertCircle className="h-16 w-16 text-destructive" />
          </div>
        </div>

        {/* Main Content */}
        <div className="space-y-6 mb-8">
          <h1 className="text-4xl md:text-5xl font-bold text-foreground">{message}</h1>
          <p className="text-xl text-muted-foreground max-w-lg mx-auto leading-relaxed">
            {details}
          </p>
        </div>

        {/* Action Card */}
        <div className="flex justify-center mb-8">
          <Card className="border-dashed border-2 hover:border-solid transition-all duration-200 max-w-md w-full">
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Try refreshing the page or return to the dashboard
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  className="flex-1"
                  variant="outline"
                  onClick={() => window.location.reload()}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Refresh Page
                </Button>
                <Link to="/" className="flex-1">
                  <Button className="w-full">
                    <Home className="h-4 w-4 mr-2" />
                    Back to Dashboard
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Error Details (for debugging) */}
        {stack && (
          <div className="mt-12 pt-8 border-t border-border">
            <details className="text-left">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                Show error details
              </summary>
              <pre className="mt-4 p-4 bg-muted rounded-lg text-xs overflow-auto text-left">
                {stack}
              </pre>
            </details>
          </div>
        )}

        {/* Help Text */}
        <div className="mt-12 pt-8 border-t border-border">
          <p className="text-xs text-muted-foreground">Please contact support for assistance</p>
        </div>
      </div>
    </div>
  );
}
