# SQL migrations

Plain SQL migrations applied in lexicographic order.

## Apply

```bash
psql "$DATABASE_URL" -f infra/sql/0001_init.sql
```

## Notes

- `pgcrypto` must be installable — Render's managed Postgres includes it by default.
- `citext` is used for the optional `admins.email` column. On Render add the
  `citext` extension via `CREATE EXTENSION IF NOT EXISTS citext;` in a superuser
  session, or drop that column from the migration.
- All tables are `CREATE TABLE IF NOT EXISTS`, so re-running is safe.
- Add new migrations as `000N_<name>.sql`. Never edit applied migrations in-place.
