/**
 * Egress Proxy Service
 *
 * Provides utilities for the mitmproxy egress proxy that intercepts
 * all HTTP/HTTPS traffic from the sandbox and routes it through
 * the worker endpoint.
 *
 * Note: Token injection is handled by the worker, not the sandbox.
 * WebSocket connections pass through directly without going through the worker.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Configuration
const PROXY_PORT = 8888;
const MITMPROXY_DIR = join(homedir(), ".mitmproxy");
const CA_CERT_PATH = join(MITMPROXY_DIR, "mitmproxy-ca-cert.pem");

/**
 * Get the proxy port.
 */
export function getProxyPort(): number {
  return PROXY_PORT;
}

/**
 * Get the CA certificate path for clients to trust.
 */
export function getCACertPath(): string {
  return CA_CERT_PATH;
}

/**
 * Check if the CA certificate exists.
 */
export function caCertExists(): boolean {
  return existsSync(CA_CERT_PATH);
}

/**
 * Install the CA certificate into the system trust store.
 * Works for Debian/Ubuntu systems (apt, curl, most language runtimes).
 */
export async function installCACertToSystem(): Promise<void> {
  if (!existsSync(CA_CERT_PATH)) {
    console.log("[egress-proxy] CA cert not found, will be generated on proxy start");
    return;
  }

  const systemCertDir = "/usr/local/share/ca-certificates/iterate";
  const systemCertPath = join(systemCertDir, "mitmproxy-ca.crt");

  try {
    // Create directory and copy cert
    execSync(`sudo mkdir -p ${systemCertDir}`, { stdio: "pipe" });
    execSync(`sudo cp "${CA_CERT_PATH}" "${systemCertPath}"`, { stdio: "pipe" });
    execSync(`sudo chmod 644 "${systemCertPath}"`, { stdio: "pipe" });

    // Update system CA store
    execSync("sudo update-ca-certificates", { stdio: "pipe" });

    console.log("[egress-proxy] Installed CA cert to system trust store");
  } catch (err) {
    console.error("[egress-proxy] Failed to install CA cert to system:", err);
    // Non-fatal - some clients will still work with explicit cert trust
  }
}

/**
 * Generate environment variables for processes to use the proxy.
 */
export function getProxyEnvVars(): Record<string, string> {
  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    // Some tools need explicit CA cert path
    SSL_CERT_FILE: CA_CERT_PATH,
    REQUESTS_CA_BUNDLE: CA_CERT_PATH, // Python requests
    CURL_CA_BUNDLE: CA_CERT_PATH,
    NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
  };
}

/**
 * Check if mitmproxy is installed.
 */
export function isMitmproxyInstalled(): boolean {
  try {
    execSync("which mitmdump", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install mitmproxy using pip.
 */
export async function installMitmproxy(): Promise<void> {
  console.log("[egress-proxy] Installing mitmproxy...");
  try {
    execSync("pip3 install mitmproxy", { stdio: "inherit" });
    console.log("[egress-proxy] mitmproxy installed successfully");
  } catch (err) {
    throw new Error(`Failed to install mitmproxy: ${err}`);
  }
}

/**
 * Get proxy status information.
 */
export function getProxyStatus(): {
  port: number;
  caCertPath: string;
  caCertExists: boolean;
} {
  return {
    port: PROXY_PORT,
    caCertPath: CA_CERT_PATH,
    caCertExists: caCertExists(),
  };
}
