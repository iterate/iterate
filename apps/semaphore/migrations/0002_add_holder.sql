-- Mirror the lease holder (e.g. `pr-1592`, `manual-jonas`) into D1 so
-- operators and the preview CLI can see who holds each resource.
ALTER TABLE resources ADD COLUMN holder TEXT;
