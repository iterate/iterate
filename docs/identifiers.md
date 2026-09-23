slug: subdomain-safe
id: always with a type prefix (`prj_<hex>`, `org_<hex>`)
key: arbitrary string that uniquely identifies a value
path: url-style path (with leading /)

name in _general_ is a user-facing string, a display name. Durable Objects are an exception and we should call them durableObjectName so we don't confuse ourselves. Our DO names will often be composed of an id, and some other identifiers. Or, often better, mint a prefixed id for the durable object name, and store it in an external record (e.g. D1 or a parent DO).
