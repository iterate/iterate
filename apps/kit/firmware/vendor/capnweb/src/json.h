// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#ifndef CAPNWEB_JSON_H
#define CAPNWEB_JSON_H

#include "capnweb/capnweb.h"

#define CAPNWEB_NO_TOKEN SIZE_MAX

struct capnweb_json_document {
  const char *json;
  size_t length;
  struct capnweb_json_token *tokens;
  size_t capacity;
  size_t count;
};

enum capnweb_status capnweb_json_parse(
    struct capnweb_json_document *document);
enum capnweb_status capnweb_json_validate(
    const char *json, size_t length);
bool capnweb_json_token_get_int64(
    const char *json,
    const struct capnweb_json_token *token,
    int64_t *result);

#endif
