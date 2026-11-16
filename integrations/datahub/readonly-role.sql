-- Run with psql as a development DB administrator, connected to the intended DB.
-- A new dedicated role only: no table SELECT grants, memberships or pg_read_all_data.
\set ON_ERROR_STOP on
CREATE ROLE civicloop_catalog LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
SELECT format('GRANT CONNECT ON DATABASE %I TO civicloop_catalog', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO civicloop_catalog;
ALTER ROLE civicloop_catalog SET default_transaction_read_only = on;
ALTER ROLE civicloop_catalog SET statement_timeout = '15s';
-- psql prompts without echoing the password or putting it in command history.
\password civicloop_catalog
-- PostgreSQL's catalogs expose the required schema without SELECT on app tables.
-- If your DB grants table privileges to PUBLIC, remove them in your disposable
-- development database before using this role. The ingestion preflight rejects them.
