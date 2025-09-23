import "./globals.css";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { PostHogProvider } from "./components/PostHogProvider.tsx";
import { Toaster } from "./components/ui/toaster.tsx";
import ogImage from "./assets/og-image.png?url";
import favicon from "./assets/favicon.ico?url";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Iterate</title>
        <link rel="shortcut icon" href={favicon} />
        <meta
          name="description"
          content="Automate operational tasks for your business with Iterate's AI-powered platform"
        />
        <meta property="og:url" content="https://iterate.com/" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Iterate" />
        <meta
          property="og:description"
          content="Automate operational tasks for your business with Iterate's AI-powered platform"
        />
        <meta property="og:image" content={ogImage} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Iterate" />
        <meta
          name="twitter:description"
          content="Automate operational tasks for your business with Iterate's AI-powered platform"
        />
        <meta name="twitter:image" content={ogImage} />
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-T9SJZX3ECG" />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Needs to be there for GA
          dangerouslySetInnerHTML={{
            __html: `
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-T9SJZX3ECG');
        `,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body
        suppressHydrationWarning
        className="min-h-screen font-mono text-slate-900 bg-white overflow-x-hidden"
      >
        <div className="min-h-screen bg-white">{children}</div>
        <Toaster />
        <script
          defer
          src="https://cloud.umami.is/script.js"
          data-website-id="8c8f7279-caa9-47b4-a0d2-b826f24ec084"
        />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <PostHogProvider>
      <Outlet />
    </PostHogProvider>
  );
}
