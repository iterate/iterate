insert into reduced_state (singleton, json)
values (1, json(:json))
on conflict (singleton) do update set json = excluded.json;
