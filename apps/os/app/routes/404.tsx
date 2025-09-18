import { Home, AlertTriangle } from "lucide-react";
import { Link } from "react-router";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent } from "../components/ui/card.tsx";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl mx-auto text-center">
        {/* 404 Animation/Illustration */}
        <div className="mb-8 relative">
          <div className="text-8xl md:text-9xl font-bold text-muted-foreground/20 select-none">
            404
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="p-6 rounded-full bg-muted/50 dark:bg-muted/20">
              <AlertTriangle className="h-16 w-16 text-muted-foreground" />
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="space-y-6 mb-8">
          <h1 className="text-4xl md:text-5xl font-bold text-foreground">Page Not Found</h1>
          <p className="text-xl text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Oops! The page you're looking for seems to have wandered off into the digital void.
          </p>
        </div>

        {/* Action Card */}
        <div className="flex justify-center mb-8">
          <Card className="border-dashed border-2 hover:border-solid transition-all duration-200 max-w-md w-full">
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Return to the dashboard and continue your work
              </p>
              <Link to="/">
                <Button className="w-full">
                  <Home className="h-4 w-4 mr-2" />
                  Back to Dashboard
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>

        {/* Help Text */}
        <div className="mt-12 pt-8 border-t border-border">
          <p className="text-xs text-muted-foreground">
            If you believe this is an error, please contact support or try refreshing the page.
          </p>
        </div>
      </div>
    </div>
  );
}
