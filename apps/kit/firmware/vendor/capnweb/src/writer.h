// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#ifndef CAPNWEB_WRITER_H
#define CAPNWEB_WRITER_H

#include "capnweb/capnweb.h"

struct capnweb_writer {
  capnweb_send_text_fn send;
  void *context;
  char *buffer;
  size_t capacity;
  size_t length;
  enum capnweb_status status;
};

enum capnweb_status capnweb_writer_begin(
    struct capnweb_writer *writer,
    capnweb_send_text_fn send,
    void *context,
    char *buffer,
    size_t capacity);
void capnweb_writer_write(
    struct capnweb_writer *writer, const char *data, size_t length);
void capnweb_writer_write_c_string(
    struct capnweb_writer *writer, const char *value);
void capnweb_writer_write_quoted(
    struct capnweb_writer *writer, const char *value);
void capnweb_writer_write_quoted_span(
    struct capnweb_writer *writer, const char *value, size_t length);
void capnweb_writer_write_base64(
    struct capnweb_writer *writer, const uint8_t *data, size_t length);
enum capnweb_status capnweb_writer_finish(struct capnweb_writer *writer);

#endif
