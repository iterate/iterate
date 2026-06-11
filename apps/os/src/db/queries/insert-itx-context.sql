insert into itx_contexts (id, project_id, journal_path)
values (:id, :projectId, :journalPath)
on conflict (id) do nothing;
