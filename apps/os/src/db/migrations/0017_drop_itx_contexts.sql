-- Context ids are gone: a context's identity IS its stream coordinate
-- (`<namespace>:<path>`, itx/coordinates.ts), so there is nothing left to
-- look up — the directory dies with the ids.
drop table itx_contexts;
