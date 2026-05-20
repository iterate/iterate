create table events (
  offset integer primary key autoincrement,
  type text not null,
  payload text check (payload is null or json_valid(payload)),
  metadata text check (metadata is null or json_valid(metadata)),
  source text check (source is null or json_valid(source)),
  idempotency_key text unique,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
