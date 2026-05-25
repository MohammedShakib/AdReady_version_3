# Supabase Setup (AdReady)

This repository uses Supabase as a PostgreSQL host. The app talks to the database through `DATABASE_URL`; it does not require `@supabase/supabase-js` unless you add client-side Supabase features later.

## Migration target

For the Supabase project you shared, use the session pooler endpoint from `supabase.txt`:

```text
aws-1-ap-northeast-2.pooler.supabase.com:6543
```

Database URL format:

```text
postgresql://postgres.olqillgkejhqynfsobfu:<password>@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres
```

Do not commit the password, service role key, or anon key.

## Apply schema

If this is a fresh Supabase database, push the migrations:

```bash
supabase login
supabase link --project-ref <project_ref>
supabase db push
```

If you want to target the database directly:

```bash
supabase db push --db-url "postgresql://postgres.<project-ref>:<password>@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres"
```

## Required server env

Set these for the new Supabase project:

```env
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres
PGSSLMODE=true
DB_AUTO_DDL=false
JWT_SECRET=...
DEFAULT_ADMIN_PASSWORD=...
DEFAULT_SADMIN_PASSWORD=...
OPENAI_API_KEY=...
```

## Vercel env

If the app is deployed on Vercel, put the same server env values in the Vercel project settings. The important ones are:

- `DATABASE_URL`
- `PGSSLMODE=true`
- `DB_AUTO_DDL=false`
- `JWT_SECRET`
- `DEFAULT_ADMIN_PASSWORD`
- `DEFAULT_SADMIN_PASSWORD`

## Notes

- `DB_AUTO_DDL=false` disables runtime table-creation bootstrap queries.
- Keep schema changes in `supabase/migrations/`.
- If you are moving data from the old Supabase project, export it from the old database first, then import it into the new project after the schema is pushed.
