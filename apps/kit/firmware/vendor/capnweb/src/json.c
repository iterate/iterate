// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "json.h"

#include <limits.h>
#include <string.h>

#define CAPNWEB_MAX_JSON_DEPTH 32U

struct parser {
  struct capnweb_json_document *document;
  size_t position;
};

static void skip_whitespace(struct parser *parser) {
  const char *json = parser->document->json;
  while (parser->position < parser->document->length) {
    char c = json[parser->position];
    if (c != ' ' && c != '\t' && c != '\r' && c != '\n') {
      return;
    }
    ++parser->position;
  }
}

static size_t allocate_token(
    struct parser *parser,
    enum capnweb_json_type type,
    size_t start) {
  struct capnweb_json_document *document = parser->document;
  struct capnweb_json_token *token;

  if (document->tokens == NULL) {
    return 0U;
  }
  if (document->count >= document->capacity) {
    return CAPNWEB_NO_TOKEN;
  }

  token = &document->tokens[document->count];
  token->type = type;
  token->start = start;
  token->end = start;
  token->child = CAPNWEB_NO_TOKEN;
  token->next = CAPNWEB_NO_TOKEN;
  token->count = 0U;
  return document->count++;
}

static bool is_hex(char c) {
  return (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'f') ||
      (c >= 'A' && c <= 'F');
}

static enum capnweb_status parse_string(
    struct parser *parser, size_t *token_index) {
  const char *json = parser->document->json;
  size_t start;
  size_t token;

  ++parser->position;
  start = parser->position;
  token = allocate_token(parser, CAPNWEB_JSON_STRING, start);
  if (token == CAPNWEB_NO_TOKEN) {
    return CAPNWEB_E_LIMIT;
  }

  while (parser->position < parser->document->length) {
    char c = json[parser->position++];
    size_t remaining;

    if (c == '"') {
      if (parser->document->tokens != NULL) {
        parser->document->tokens[token].end = parser->position - 1U;
      }
      *token_index = token;
      return CAPNWEB_OK;
    }
    if ((unsigned char)c < 0x20U) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    if (c != '\\') {
      continue;
    }
    if (parser->position >= parser->document->length) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }

    c = json[parser->position++];
    if (c == '"' || c == '\\' || c == '/' ||
        c == 'b' || c == 'f' || c == 'n' || c == 'r' || c == 't') {
      continue;
    }
    if (c != 'u') {
      return CAPNWEB_E_INVALID_MESSAGE;
    }

    remaining = parser->document->length - parser->position;
    if (remaining < 4U ||
        !is_hex(json[parser->position]) ||
        !is_hex(json[parser->position + 1U]) ||
        !is_hex(json[parser->position + 2U]) ||
        !is_hex(json[parser->position + 3U])) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    parser->position += 4U;
  }

  return CAPNWEB_E_INVALID_MESSAGE;
}

static bool consume_literal(struct parser *parser, const char *literal) {
  size_t length = strlen(literal);
  if (length > parser->document->length - parser->position) {
    return false;
  }
  if (memcmp(parser->document->json + parser->position, literal, length) != 0) {
    return false;
  }
  parser->position += length;
  return true;
}

static bool is_digit(char c) {
  return c >= '0' && c <= '9';
}

static enum capnweb_status parse_number(
    struct parser *parser, size_t *token_index) {
  const char *json = parser->document->json;
  size_t start = parser->position;
  size_t token;

  if (json[parser->position] == '-') {
    ++parser->position;
  }
  if (parser->position >= parser->document->length) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }

  if (json[parser->position] == '0') {
    ++parser->position;
  } else {
    if (!is_digit(json[parser->position])) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    while (parser->position < parser->document->length &&
           is_digit(json[parser->position])) {
      ++parser->position;
    }
  }

  if (parser->position < parser->document->length &&
      json[parser->position] == '.') {
    ++parser->position;
    if (parser->position >= parser->document->length ||
        !is_digit(json[parser->position])) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    while (parser->position < parser->document->length &&
           is_digit(json[parser->position])) {
      ++parser->position;
    }
  }

  if (parser->position < parser->document->length &&
      (json[parser->position] == 'e' || json[parser->position] == 'E')) {
    ++parser->position;
    if (parser->position < parser->document->length &&
        (json[parser->position] == '+' || json[parser->position] == '-')) {
      ++parser->position;
    }
    if (parser->position >= parser->document->length ||
        !is_digit(json[parser->position])) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    while (parser->position < parser->document->length &&
           is_digit(json[parser->position])) {
      ++parser->position;
    }
  }

  token = allocate_token(parser, CAPNWEB_JSON_NUMBER, start);
  if (token == CAPNWEB_NO_TOKEN) {
    return CAPNWEB_E_LIMIT;
  }
  if (parser->document->tokens != NULL) {
    parser->document->tokens[token].end = parser->position;
  }
  *token_index = token;
  return CAPNWEB_OK;
}

static enum capnweb_status parse_value(
    struct parser *parser, size_t depth, size_t *token_index);

static void append_child(
    struct capnweb_json_document *document,
    size_t parent,
    size_t child,
    size_t *previous) {
  struct capnweb_json_token *parent_token;
  if (document->tokens == NULL) {
    return;
  }
  parent_token = &document->tokens[parent];
  if (*previous == CAPNWEB_NO_TOKEN) {
    parent_token->child = child;
  } else {
    document->tokens[*previous].next = child;
  }
  *previous = child;
  ++parent_token->count;
}

static enum capnweb_status parse_array(
    struct parser *parser,
    size_t depth,
    size_t *token_index) {
  size_t token = allocate_token(
      parser, CAPNWEB_JSON_ARRAY, parser->position);
  size_t previous = CAPNWEB_NO_TOKEN;

  if (token == CAPNWEB_NO_TOKEN) {
    return CAPNWEB_E_LIMIT;
  }
  ++parser->position;
  skip_whitespace(parser);
  if (parser->position < parser->document->length &&
      parser->document->json[parser->position] == ']') {
    ++parser->position;
    if (parser->document->tokens != NULL) {
      parser->document->tokens[token].end = parser->position;
    }
    *token_index = token;
    return CAPNWEB_OK;
  }

  for (;;) {
    size_t child;
    enum capnweb_status status = parse_value(parser, depth + 1U, &child);
    if (status != CAPNWEB_OK) {
      return status;
    }
    append_child(parser->document, token, child, &previous);
    skip_whitespace(parser);
    if (parser->position >= parser->document->length) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    if (parser->document->json[parser->position] == ']') {
      ++parser->position;
      if (parser->document->tokens != NULL) {
        parser->document->tokens[token].end = parser->position;
      }
      *token_index = token;
      return CAPNWEB_OK;
    }
    if (parser->document->json[parser->position] != ',') {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    ++parser->position;
    skip_whitespace(parser);
  }
}

static enum capnweb_status parse_object(
    struct parser *parser,
    size_t depth,
    size_t *token_index) {
  size_t token = allocate_token(
      parser, CAPNWEB_JSON_OBJECT, parser->position);
  size_t previous = CAPNWEB_NO_TOKEN;

  if (token == CAPNWEB_NO_TOKEN) {
    return CAPNWEB_E_LIMIT;
  }
  ++parser->position;
  skip_whitespace(parser);
  if (parser->position < parser->document->length &&
      parser->document->json[parser->position] == '}') {
    ++parser->position;
    if (parser->document->tokens != NULL) {
      parser->document->tokens[token].end = parser->position;
    }
    *token_index = token;
    return CAPNWEB_OK;
  }

  for (;;) {
    size_t key;
    size_t value;
    enum capnweb_status status;

    if (parser->position >= parser->document->length ||
        parser->document->json[parser->position] != '"') {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    status = parse_string(parser, &key);
    if (status != CAPNWEB_OK) {
      return status;
    }
    append_child(parser->document, token, key, &previous);
    skip_whitespace(parser);
    if (parser->position >= parser->document->length ||
        parser->document->json[parser->position] != ':') {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    ++parser->position;
    skip_whitespace(parser);
    status = parse_value(parser, depth + 1U, &value);
    if (status != CAPNWEB_OK) {
      return status;
    }
    append_child(parser->document, token, value, &previous);
    skip_whitespace(parser);
    if (parser->position >= parser->document->length) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    if (parser->document->json[parser->position] == '}') {
      ++parser->position;
      if (parser->document->tokens != NULL) {
        parser->document->tokens[token].end = parser->position;
        parser->document->tokens[token].count /= 2U;
      }
      *token_index = token;
      return CAPNWEB_OK;
    }
    if (parser->document->json[parser->position] != ',') {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    ++parser->position;
    skip_whitespace(parser);
  }
}

static enum capnweb_status parse_value(
    struct parser *parser, size_t depth, size_t *token_index) {
  const char *json;
  size_t token;

  if (depth > CAPNWEB_MAX_JSON_DEPTH) {
    return CAPNWEB_E_LIMIT;
  }
  skip_whitespace(parser);
  if (parser->position >= parser->document->length) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }

  json = parser->document->json;
  switch (json[parser->position]) {
    case '"':
      return parse_string(parser, token_index);
    case '[':
      return parse_array(parser, depth, token_index);
    case '{':
      return parse_object(parser, depth, token_index);
    case 'n':
      if (!consume_literal(parser, "null")) {
        return CAPNWEB_E_INVALID_MESSAGE;
      }
      token = allocate_token(parser, CAPNWEB_JSON_NULL, parser->position - 4U);
      break;
    case 't':
      if (!consume_literal(parser, "true")) {
        return CAPNWEB_E_INVALID_MESSAGE;
      }
      token = allocate_token(parser, CAPNWEB_JSON_BOOLEAN, parser->position - 4U);
      break;
    case 'f':
      if (!consume_literal(parser, "false")) {
        return CAPNWEB_E_INVALID_MESSAGE;
      }
      token = allocate_token(parser, CAPNWEB_JSON_BOOLEAN, parser->position - 5U);
      break;
    default:
      return parse_number(parser, token_index);
  }

  if (token == CAPNWEB_NO_TOKEN) {
    return CAPNWEB_E_LIMIT;
  }
  if (parser->document->tokens != NULL) {
    parser->document->tokens[token].end = parser->position;
  }
  *token_index = token;
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_json_parse(
    struct capnweb_json_document *document) {
  struct parser parser;
  size_t root;
  enum capnweb_status status;

  if (document == NULL || document->json == NULL ||
      (document->tokens != NULL && document->capacity == 0U)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  document->count = 0U;
  parser.document = document;
  parser.position = 0U;
  status = parse_value(&parser, 0U, &root);
  if (status != CAPNWEB_OK) {
    return status;
  }
  skip_whitespace(&parser);
  if (root != 0U || parser.position != document->length) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_json_validate(
    const char *json, size_t length) {
  struct capnweb_json_document document;
  if (json == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  document = (struct capnweb_json_document){
    json,
    length,
    NULL,
    0U,
    0U,
  };
  return capnweb_json_parse(&document);
}

bool capnweb_json_token_get_int64(
    const char *json,
    const struct capnweb_json_token *token,
    int64_t *result) {
  size_t position;
  uint64_t magnitude = 0U;
  uint64_t limit;
  bool negative = false;

  if (json == NULL || token == NULL || result == NULL) {
    return false;
  }
  if (token->type != CAPNWEB_JSON_NUMBER ||
      token->start == token->end) {
    return false;
  }

  position = token->start;
  if (json[position] == '-') {
    negative = true;
    ++position;
  }
  limit = negative ? (uint64_t)INT64_MAX + 1U : (uint64_t)INT64_MAX;
  if (position == token->end) {
    return false;
  }
  while (position < token->end) {
    unsigned int digit;
    char c = json[position++];
    if (!is_digit(c)) {
      return false;
    }
    digit = (unsigned int)(c - '0');
    if (magnitude > (limit - digit) / 10U) {
      return false;
    }
    magnitude = magnitude * 10U + digit;
  }

  if (negative && magnitude == (uint64_t)INT64_MAX + 1U) {
    *result = INT64_MIN;
  } else if (negative) {
    *result = -(int64_t)magnitude;
  } else {
    *result = (int64_t)magnitude;
  }
  return true;
}
