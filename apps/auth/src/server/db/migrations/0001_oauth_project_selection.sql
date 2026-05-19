create table "oauthProjectSelection" (
  session_id TEXT not null,
  client_id TEXT not null,
  user_id TEXT not null,
  project_ids TEXT not null,
  created_at INTEGER not null,
  updated_at INTEGER not null,
  primary key (session_id, client_id),
  foreign key (session_id) references session(id) on delete cascade,
  foreign key (client_id) references oauthClient(clientId) on delete cascade,
  foreign key (user_id) references user(id) on delete cascade
);

create index "oauthProjectSelection_userId_idx" on "oauthProjectSelection"(user_id);
