# Supabase Setup (AdReady)

## 1) Apply schema via migrations

```bash
supabase login
supabase link --project-ref <project_ref>
supabase db push
```

If needed, direct connection string:

```bash
supabase db push --db-url "postgres://..."
```

## 2) Keep root schema.sql from auto-running

- Use `supabase/migrations/*` for DB changes.
- Do not add deploy scripts that run `schema.sql`.
- In `supabase/config.toml`:

```toml
[db.seed]
enabled = false
```

## 3) Server env (minimum)

```env
DATABASE_URL=postgres://...
PGSSLMODE=true
DB_AUTO_DDL=false
JWT_SECRET=...
DEFAULT_ADMIN_PASSWORD=...
DEFAULT_SADMIN_PASSWORD=...
OPENAI_API_KEY=...
```

## 4) Notes

- `DB_AUTO_DDL=false` means app startup table-create queries are skipped.
- `/api/health` is available for Railway healthchecks.
