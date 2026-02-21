export interface ServiceRouteRegistry {
  get: (path: string, handler: (context: any) => Response | Promise<Response>) => unknown;
}

export const attachDefaultServiceRoutes = (app: ServiceRouteRegistry): void => {
  app.get("/health", (c) => c.json({ status: "ok" }));
};
