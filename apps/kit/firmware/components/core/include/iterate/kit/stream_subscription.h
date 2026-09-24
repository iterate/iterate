#ifndef ITERATE_KIT_STREAM_SUBSCRIPTION_H
#define ITERATE_KIT_STREAM_SUBSCRIPTION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Caller-owned, zero-initialized storage for independent handles on an
 * already-open Cap'n Web session. Neither opens, authenticates, nor owns it.
 * Do not copy or reset these objects while an RPC or callback retains them. */
enum iterate_kit_stream_state {
  ITERATE_KIT_STREAM_FREE = 0,
  ITERATE_KIT_STREAM_GETTING,
  ITERATE_KIT_STREAM_READY,
  ITERATE_KIT_STREAM_FAILED,
  ITERATE_KIT_STREAM_CLOSED,
};

enum iterate_kit_subscription_state {
  ITERATE_KIT_SUBSCRIPTION_FREE = 0,
  ITERATE_KIT_SUBSCRIPTION_OPENING,
  ITERATE_KIT_SUBSCRIPTION_OPEN,
  ITERATE_KIT_SUBSCRIPTION_CLOSING,
  ITERATE_KIT_SUBSCRIPTION_FAILED,
  ITERATE_KIT_SUBSCRIPTION_CLOSED,
};

enum iterate_kit_subscription_kind {
  ITERATE_KIT_SUBSCRIPTION_STREAM = 0,
  ITERATE_KIT_SUBSCRIPTION_LIVE_STATE,
};

struct iterate_kit_stream {
  enum iterate_kit_stream_state state;
  enum capnweb_status status;
  uint32_t epoch;
  struct capnweb_session *session;
  struct capnweb_remote_capability capability;
  bool has_capability;
  struct iterate_kit_stream_request {
    bool pending;
    uint32_t epoch;
    struct iterate_kit_stream *stream;
    struct capnweb_session *session;
  } get;
};

/* Receives a remote callback's arguments, borrowed only for this call.
 *
 * TWO POSITIONAL ARGUMENTS, NOT ONE OBJECT. The OS calls a lent subscription
 * stub as a BARE FUNCTION with `(events, range)`: `update` is argument 0 — for
 * a stream subscription, the events array itself — and `range` is argument 1,
 * `{after, through}`, or NULL when the callee passed none (live state does).
 *
 * THE DELIVERY CONTRACT, STATED ONCE HERE. Delivery is fire-and-forget: nothing
 * is awaited, nothing is retried, a push past the server's in-flight budget is
 * dropped, and `readEvents` never returns an ephemeral — so a speaker frame
 * lost in flight cannot be read back and is simply gone. The range is the only
 * way a client learns that a delivery it never saw existed.
 *
 * `owner_epoch` lets callers reject a callback after they have repurposed their
 * own higher-level call storage. */
typedef void (*iterate_kit_subscription_update_fn)(
    void *owner,
    uint32_t owner_epoch,
    const struct capnweb_value *update,
    const struct capnweb_value *range);

struct iterate_kit_stream_subscription {
  enum iterate_kit_subscription_state state;
  enum iterate_kit_subscription_kind kind;
  enum capnweb_status status;
  uint32_t epoch;
  struct capnweb_session *session;
  struct capnweb_remote_capability handle;
  bool has_handle;
  struct capnweb_local_capability callback;
  /** Our local hold; the server can retain the callback after this is false. */
  bool has_callback;
  /** Set only once Cap'n Web has released every hold on the callback. */
  bool callback_disposed;
  iterate_kit_subscription_update_fn on_update;
  void *owner;
  uint32_t owner_epoch;
  struct iterate_kit_subscription_request {
    bool pending;
    uint32_t epoch;
    struct iterate_kit_stream_subscription *subscription;
    struct capnweb_session *session;
  } open;
};

/** Begin `itx.cd(path)` on a context — pure addressing, since a context IS its
 * stream. The borrowed context capability and session must outlive the
 * returned completion. */
enum capnweb_status iterate_kit_stream_get(
    struct iterate_kit_stream *stream,
    struct capnweb_session *session,
    struct capnweb_remote_capability project,
    const char *path);

/** Oneway append on a ready logical stream. */
enum capnweb_status iterate_kit_stream_append(
    const struct iterate_kit_stream *stream,
    const char *events_json,
    size_t events_json_length);

/** Release the child stream capability. A pending get is allowed to finish;
 * its stale result is released and cannot repopulate this object. */
enum capnweb_status iterate_kit_stream_close(struct iterate_kit_stream *stream);
bool iterate_kit_stream_reclaimable(const struct iterate_kit_stream *stream);

/**
 * Open a context's `subscribe({name, consumes, target})` subscription.
 * `subscription_name` must be unique among simultaneously open subscriptions —
 * the same name REPLACES the row. Deliveries arriving before the open reply are
 * delivered to this subscription's callback context.
 *
 * THERE IS NO DELIVERY BOUND TO ASK FOR. `openConnection` took
 * maxDeliveryEvents/maxDeliveryBytes and the device sized its inbox slot to
 * match; the OS has no such knob — commits landing behind an in-flight
 * delivery fold into one call. The device's protection is the sender appending
 * one speaker frame per append, plus its own bounded inbox, which drops and
 * counts what will not fit.
 */
enum capnweb_status iterate_kit_stream_subscription_open(
    struct iterate_kit_stream_subscription *subscription,
    struct iterate_kit_stream *stream,
    const char *subscription_name,
    const char *const *consumed_event_types,
    size_t consumed_event_type_count,
    iterate_kit_subscription_update_fn on_update,
    void *owner,
    uint32_t owner_epoch);

/** Open a standard `liveState.subscribe(callback)` subscription against any
 * borrowed remote capability. Updates use the same per-subscription export
 * and close rule as stream subscriptions. */
enum capnweb_status iterate_kit_live_state_subscription_open(
    struct iterate_kit_stream_subscription *subscription,
    struct capnweb_session *session,
    struct capnweb_remote_capability target,
    iterate_kit_subscription_update_fn on_update,
    void *owner,
    uint32_t owner_epoch);

/** Releases the remote handle then the local callback hold. A stream
 * subscription handle has no `close()` — a Cap'n Web release IS its disposal,
 * which un-does the row — so only live state still calls `unsubscribe`.
 * Storage remains
 * unreusable until a pending open completion and the server callback release
 * have both occurred; call `reclaimable()` before assigning it to another
 * logical subscription. */
enum capnweb_status iterate_kit_stream_subscription_close(
    struct iterate_kit_stream_subscription *subscription);

bool iterate_kit_stream_subscription_reclaimable(
    const struct iterate_kit_stream_subscription *subscription);

/** Call after the permanent owner's capnweb_session_close has notified pending
 * completions and disposed exports, before reinitializing the shared session.
 * This forgets invalid remote handles without sending on the lost socket. */
void iterate_kit_stream_session_ended(struct iterate_kit_stream *stream);
void iterate_kit_stream_subscription_session_ended(
    struct iterate_kit_stream_subscription *subscription);

#ifdef __cplusplus
}
#endif

#endif
