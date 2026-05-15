slug: subdomain-safe
id: typeid, always with prefix
key: arbitrary string that uniquely identifies a value
path: url-style path (with leading /)

name in *general* is a user-facing string, a display name. Durable Objects are an exception and we should to call them durableObjectName so we don't confuse ourselves. Our DO names will often be composed of an id, and some other idenifiers. Or, often better, generate a typeid for the durable object name, and store it in an external record (e.g. D1 or a parent DO).
