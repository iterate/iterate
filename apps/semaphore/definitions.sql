create table resources (
  type text not null,
  slug text not null,
  data text not null,
  -- Durable Objects remain authoritative for lease coordination. These columns mirror the
  -- current lease view into D1 so operators can inspect inventory and likely timeout data
  -- with a single SQL query without turning D1 into a second source of truth.
  lease_state text not null default 'available',
  leased_until integer,
  last_acquired_at integer,
  last_released_at integer,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  primary key (type, slug)
);

create index idx_resources_type_created_at on resources (type, created_at, slug);
