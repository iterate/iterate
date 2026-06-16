import { createHash } from "node:crypto";
import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { slugify } from "../../slugify.ts";
import type {
  InitializeTestRoom,
  InspectorTestRoom,
  ListedRoom,
} from "../test-harness/initialize-fronting-worker.ts";

const APP_NAME = "shared-durable-object-utils-e2e";

const AlchemyEnv = z.object({
  ALCHEMY_LOCAL: z.stringbool().default(false),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .min(1)
          .refine(
            (hostname) => !hostname.includes("/") && !hostname.includes("://"),
            "DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES entries must be hostnames without scheme or path",
          ),
      ),
    ),
  DURABLE_OBJECT_UTILS_E2E_OUTPUT_JSON: z.stringbool().default(false),
});

const env = AlchemyEnv.parse(process.env);
const workerName = makeWorkerName(APP_NAME, env.ALCHEMY_STAGE);

export default Alchemy.Stack(
  APP_NAME,
  {
    providers: Cloudflare.providers() as never,
    state: env.ALCHEMY_LOCAL ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const rooms = Cloudflare.DurableObjectNamespace<InitializeTestRoom>("rooms", {
      className: "InitializeTestRoom",
    });
    const inspectors = Cloudflare.DurableObjectNamespace<InspectorTestRoom>("inspectors", {
      className: "InspectorTestRoom",
    });
    const listedRooms = Cloudflare.DurableObjectNamespace<ListedRoom>("listed-rooms", {
      className: "ListedRoom",
    });
    const catalog = yield* Cloudflare.D1Database("catalog", {
      name: `${workerName}-catalog`,
    }).pipe(adopt(true));

    const worker = yield* Cloudflare.Worker(APP_NAME, {
      name: workerName,
      domain:
        env.DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES.length === 0
          ? undefined
          : env.DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES,
      env: {
        ROOMS: rooms,
        INSPECTORS: inspectors,
        LISTED_ROOMS: listedRooms,
        DO_CATALOG: catalog,
      },
      main: "./src/durable-object-utils/test-harness/initialize-fronting-worker.ts",
    }).pipe(adopt(true));

    const deployment = {
      url: worker.url,
      routes: env.DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES,
    };

    if (env.DURABLE_OBJECT_UTILS_E2E_OUTPUT_JSON) {
      console.log(JSON.stringify(deployment));
    } else {
      console.dir(deployment, { depth: null });
    }

    return deployment;
  }),
);

function makeWorkerName(appName: string, stage: string): string {
  const name = slugify(`${appName}-${stage}`);

  if (name.length <= 63) {
    return name;
  }

  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, 54)}-${hash}`;
}
