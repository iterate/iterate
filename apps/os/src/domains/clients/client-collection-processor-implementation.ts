import { StreamProcessor, type ReduceArgs, type StreamEvent } from "iterate/processors";
import { ConnectionOpenerDescriptor } from "../streams/core-processor-contract.ts";
import {
  CLIENT_COLLECTION_SUBSCRIPTION_NAME,
  ClientCollectionProcessorContract,
} from "./client-collection-processor-contract.ts";

/**
 * The project's client roster, reduced from copied client-stream facts.
 *
 * Every project has ONE client collection stream at `/clients`. Each client
 * stream (`/clients/<name>`, or any caller-chosen path) copies its
 * `client/created` and `stream/connection-opened` / `connection-closed`
 * events into it — `projects.connect` configures that deliberately narrow
 * push subscription in the same idempotent birth batch that appends
 * `client/created`. `reduce` projects the copies into `state.clients`, keyed
 * by the source stream path.
 *
 * Connection facts need one discrimination: ANY session watcher (a
 * stream-viewer tab) opening the client stream also produces
 * `connection-opened`. Only openers whose descriptor carries the `client`
 * marker (stamped by `projects.connect`) count as client presence; everything
 * else is silently ignored — it is normal traffic, not an error.
 *
 * Close reasons matter: `idle` is deliberately NOT a departure (the
 * subscriber is parked on its hibernatable wake socket), so an idle close
 * marks the connection dormant and the wake re-dial's fresh
 * `connection-opened` clears it. Every other reason removes the connection.
 *
 * Every timestamp comes from the SOURCE hop
 * (`event.source.copiedFrom.at(-1)`), never from the copy's commit time. A
 * malformed committed copy is skipped and logged rather than wedging the
 * cursor.
 *
 * A pure projector: no `processEvent`, no side effects, no obligations. The
 * reduced roster is last-known presence — the paired opened/closed facts are
 * best-effort, so capability dispatch reads the client stream's live runtime
 * table, never this state.
 */
export class ClientCollectionStreamProcessor extends StreamProcessor<ClientCollectionProcessorContract> {
  readonly contract = ClientCollectionProcessorContract;

  protected override reduce(args: ReduceArgs<ClientCollectionProcessorContract>) {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/client-collection/created": {
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload };
      }
      case "events.iterate.com/client/created": {
        const source = receivedClientSource(event);
        if (source === null) return state;
        if (state.clients[source.path] !== undefined) return state;
        return {
          ...state,
          clients: {
            ...state.clients,
            [source.path]: {
              path: source.path,
              createdAt: source.createdAt,
              connections: {},
            },
          },
        };
      }
      case "events.iterate.com/stream/connection-opened": {
        const source = receivedClientSource(event);
        if (source === null) return state;
        const parsed = ConnectionOpenerDescriptor.safeParse(event.payload.openedBy ?? {});
        if (!parsed.success) return state;
        const opener = parsed.data;
        const client = opener.client;
        if (client === undefined) return state;
        const record = state.clients[source.path];
        if (record === undefined) {
          console.error(
            `client collection skipped ${event.type} for ${source.path}: client/created has not been reduced`,
          );
          return state;
        }
        return {
          ...state,
          clients: {
            ...state.clients,
            [source.path]: {
              ...record,
              ...(opener.description === undefined ? {} : { description: opener.description }),
              connections: {
                ...record.connections,
                [event.payload.connectionKey]: {
                  openedAt: source.createdAt,
                  ...(opener.description === undefined ? {} : { description: opener.description }),
                  ...(opener.user === undefined ? {} : { user: opener.user }),
                  hasCapabilities: client.capabilities === true,
                },
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/connection-closed": {
        const source = receivedClientSource(event);
        if (source === null) return state;
        const record = state.clients[source.path];
        const connection = record?.connections[event.payload.connectionKey];
        if (record === undefined || connection === undefined) return state;
        if (event.payload.reason === "idle") {
          return {
            ...state,
            clients: {
              ...state.clients,
              [source.path]: {
                ...record,
                connections: {
                  ...record.connections,
                  [event.payload.connectionKey]: { ...connection, dormant: true },
                },
              },
            },
          };
        }
        const connections = { ...record.connections };
        delete connections[event.payload.connectionKey];
        return {
          ...state,
          clients: {
            ...state.clients,
            [source.path]: { ...record, connections, lastDisconnectedAt: source.createdAt },
          },
        };
      }
      default:
        return state;
    }
  }
}

/**
 * The last copy hop of a copied client-stream fact: which client stream it
 * came from and the fact's ORIGINAL coordinates on the source stream. Reduced
 * roster timestamps read these, never the copy's own commit time. An
 * unattributable committed fact is logged and skipped so it cannot wedge the
 * cursor.
 */
function receivedClientSource(event: Pick<StreamEvent, "type" | "source">): {
  path: string;
  createdAt: string;
} | null {
  const source = event.source?.copiedFrom?.at(-1);
  if (source === undefined) {
    console.error(`client collection skipped ${event.type}: missing source-stream coordinates`);
    return null;
  }
  if (source.name !== CLIENT_COLLECTION_SUBSCRIPTION_NAME) {
    console.error(
      `client collection skipped ${event.type}: unexpected subscription "${source.name}"`,
    );
    return null;
  }
  return { path: source.path, createdAt: source.createdAt };
}
