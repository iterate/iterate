#ifndef ITERATE_KIT_WAVESHARE_CONVERSATION_STORE_H
#define ITERATE_KIT_WAVESHARE_CONVERSATION_STORE_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The conversation the user last chose, kept across power cycles.
 *
 * The stream path IS the conversation's identity, and the menu's "new
 * conversation" is the user deciding to have a different one. Held only in
 * RAM, that decision lasted until the next power cycle and then silently
 * undid itself: the device came back on the compiled-in default, in a
 * conversation the user had already left, with nothing on screen to say so.
 *
 * This lives in the target rather than components/core because NVS is
 * ESP-IDF's, and core is compiled on the host.
 */

/**
 * The longest path this module will keep, terminator included.
 *
 * Matched to the app's `stream_path` buffer. A path that could never be read
 * back into that buffer is not worth writing, and refusing it at the door is
 * easier to reason about than discovering the truncation a power cycle later.
 */
#define WAVESHARE_CONVERSATION_PATH_CAPACITY 96

/**
 * Load the remembered conversation path into `out`, which must have room for
 * `capacity` bytes including the terminator. Returns false, and leaves `out`
 * an empty string, when there is nothing to load.
 *
 * "Nothing to load" deliberately covers every unhappy case — never stored,
 * flash unreadable, value longer than `capacity`, value that no longer looks
 * like a path. The caller's compiled-in default is always a working
 * conversation, so falling back to it beats any attempt to salvage a value we
 * do not trust. A device that cannot read its own note must still boot into a
 * conversation it can hold.
 */
bool waveshare_conversation_load(char *out, size_t capacity);

/**
 * Remember `path` as the conversation to resume. Returns false if it could not
 * be written; the caller should carry on either way, since the only cost is
 * that the next boot starts from the default.
 *
 * Call this once, at the moment a new conversation is ADOPTED — not when the
 * menu option is pressed, and not on every mount. Flash has an erase budget,
 * and this value changes only when the user starts a new conversation, so
 * anything more frequent spends endurance on writes that say the same thing.
 * Writing on the adoption edge also means a setup that failed never overwrites
 * the conversation the user still has.
 */
bool waveshare_conversation_store(const char *path);

#ifdef __cplusplus
}
#endif

#endif
