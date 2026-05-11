import getPort from "get-port";

/**
 * Return an available TCP port.
 *
 * This intentionally stays tiny and just wraps `get-port`. It does not try to
 * hold the port open or reserve it across later process startup.
 */
export async function getFreePort(options?: Parameters<typeof getPort>[0]) {
  return await getPort(options);
}
