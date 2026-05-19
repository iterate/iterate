declare module "captun/client" {
  interface Fetcher {
    fetch(request: Request): Response | Promise<Response>;
  }

  export interface CaptunClientCreateTunnelOptions extends Fetcher {
    url: string | URL;
    headers?: Record<string, string>;
  }

  export function createCaptunTunnel(options: CaptunClientCreateTunnelOptions): Promise<Disposable>;
}
