// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#ifndef CAPNWEB_SESSION_INTERNAL_H
#define CAPNWEB_SESSION_INTERNAL_H

#include "capnweb/capnweb.h"
#include "writer.h"

typedef void (*capnweb_prepare_arguments_fn)(
    struct capnweb_session *session, void *context);
typedef void (*capnweb_write_arguments_fn)(
    struct capnweb_writer *writer, void *context);

enum capnweb_status capnweb_session_start_message(
    struct capnweb_session *session, struct capnweb_writer *writer);
enum capnweb_status capnweb_session_finish_message(
    struct capnweb_session *session, struct capnweb_writer *writer);

bool capnweb_format_id(
    int64_t id, char buffer[32], size_t *length);

struct capnweb_pending_call *capnweb_session_find_pending(
    struct capnweb_session *session, int64_t id);
struct capnweb_export *capnweb_session_find_export(
    struct capnweb_session *session, int64_t id);
struct capnweb_import *capnweb_session_allocate_import(
    struct capnweb_session *session,
    capnweb_completion_fn completion,
    void *context);

enum capnweb_status capnweb_session_adopt_reply(
    struct capnweb_session *session,
    struct capnweb_pending_call *pending);
enum capnweb_status capnweb_session_send_pending_resolution(
    struct capnweb_session *session,
    struct capnweb_pending_call *pending);
enum capnweb_status capnweb_session_send_release(
    struct capnweb_session *session, int64_t id);
enum capnweb_status capnweb_session_call_encoded(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    capnweb_completion_fn completion,
    void *completion_context,
    capnweb_prepare_arguments_fn prepare_arguments,
    capnweb_write_arguments_fn write_arguments,
    void *arguments_context);

#endif
