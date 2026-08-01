import { fileURLToPath } from "node:url";
import {
  productionDeviceProofUsage,
  proveProductionGrokFromDevice,
} from "./prove-production-grok-from-device.ts";

/*
 * Retain the reviewed Stick command as a compatibility entrypoint. The
 * no-argument defaults still select the same physical Stick; orchestration now
 * lives in the catalog-backed runner that StackChan uses as well.
 */
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(productionDeviceProofUsage);
} else {
  try {
    const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
    const result = await proveProductionGrokFromDevice(
      process.argv.slice(2),
      process.env,
      packageDirectory,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => {
      process.exit(result.passed ? 0 : 1);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`, () => process.exit(1));
  }
}
