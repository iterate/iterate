-- Add 'failed' to machine state enum.
-- Drizzle uses text columns with CHECK constraints inferred from the schema,
-- but the machine table uses a plain text column with enum values defined
-- at the application level (no DB-level CHECK), so no DDL is needed.
-- This migration exists as a placeholder to document the schema change.
SELECT 1;
