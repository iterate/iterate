CREATE TABLE `config`(
  `key` text PRIMARY KEY NOT NULL,
  `value_json` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE TABLE `routes`(
  `host` text PRIMARY KEY NOT NULL,
  `target` text NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `tags_json` text DEFAULT '[]' NOT NULL,
`caddy_directives_json` text DEFAULT '[]' NOT NULL,
`updated_at` text NOT NULL
);
CREATE TABLE `event_stream_subscriptions`(
  `event_stream_path` text NOT NULL,
  `subscription_slug` text NOT NULL,
  `type` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `last_delivered_offset` text,
  `subscription_json` text NOT NULL,
  PRIMARY KEY(`event_stream_path`, `subscription_slug`),
  FOREIGN KEY(`event_stream_path`) REFERENCES `event_streams`(`path`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_event_stream_subscriptions_path` ON `event_stream_subscriptions`(
  `event_stream_path`
);
CREATE INDEX `idx_event_stream_subscriptions_type` ON `event_stream_subscriptions`(
  `type`
);
CREATE TABLE `event_streams`(
  `path` text PRIMARY KEY NOT NULL,
  `created_at` text NOT NULL,
  `event_count` integer NOT NULL,
  `last_event_created_at` text NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL
);
CREATE INDEX `idx_event_streams_last_event_created_at` ON `event_streams`(
  `last_event_created_at`
);
CREATE TABLE `events`(
  `path` text NOT NULL,
  `offset` text NOT NULL,
  `type` text NOT NULL,
  `payload` text NOT NULL,
  `version` text DEFAULT '1' NOT NULL,
  `created_at` text NOT NULL,
  `trace_id` text NOT NULL,
  `span_id` text NOT NULL,
  `parent_span_id` text,
  PRIMARY KEY(`path`, `offset`)
);
CREATE INDEX `idx_events_path_offset` ON `events`(`path`,`offset`);
