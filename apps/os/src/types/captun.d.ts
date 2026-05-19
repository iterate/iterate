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

declare module "captun/server" {
  interface Fetcher {
    fetch(request: Request): Response | Promise<Response>;
  }

  export interface CaptunServerAcceptTunnelOptions {
    onDisconnect?: () => void;
  }

  export interface CaptunServerTunnel extends Fetcher, Disposable {}

  export function acceptCaptunTunnel(options?: CaptunServerAcceptTunnelOptions): {
    response: Response;
    tunnel: CaptunServerTunnel;
  };
}
