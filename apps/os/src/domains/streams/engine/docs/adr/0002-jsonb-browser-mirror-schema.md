# JSONB browser mirror schema

The browser mirror stores each event once as SQLite JSONB (`raw_jsonb`) and uses generated scalar columns for queryable event fields, while `local_index` remains the ordinary primary key used by TanStack Virtual. Inserts preserve replay safety with a documented trigger: identical replay rows are ignored so `inserted_at` remains the first local storage time, conflicting duplicate offsets abort, and offset gaps abort. This keeps the raw event payload as the source of truth while allowing future JSON-field indexing through SQLite JSON functions.
