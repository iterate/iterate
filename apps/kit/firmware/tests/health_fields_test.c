#include "iterate/kit/capabilities/health.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

int main(void) {
  const struct {
    struct iterate_kit_health_field fields[2];
    size_t count;
    size_t capacity;
    const char *becomes;
    size_t length;
  } cases[] = {
    {{{"a", 0U}}, 1U, 32U, ",\"a\":0", 6U},
    {{{"a", 0U}}, 1U, 7U, ",\"a\":0", 6U},
    {{{"a", 0U}}, 1U, 6U, ",\"a\":", 0U},
    {{{"a", 0U}, {"b", UINT32_MAX}}, 2U, 32U,
     ",\"a\":0,\"b\":4294967295", 21U},
    {{{"a", 0U}, {"b", 1U}}, 2U, 9U, ",\"a\":0,\"", 0U},
    {{{"a", 0U}}, 1U, 0U, "", 0U},
    {{{"a", 0U}}, 0U, 32U, "", 0U},
  };
  for (size_t index = 0U; index < sizeof(cases) / sizeof(cases[0]); index++) {
    char out[32] = {0};
    assert(iterate_kit_health_append_fields(
        out, cases[index].capacity, cases[index].fields, cases[index].count)
        == cases[index].length);
    assert(strcmp(out, cases[index].becomes) == 0);
  }
  return 0;
}
