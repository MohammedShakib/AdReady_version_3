# Supabase Migration Setup

This repository is prepared for Supabase migration-based schema management.

## What auto-runs
- Supabase auto-runs SQL files inside `supabase/migrations/`.
- Root `schema.sql` does NOT auto-run.

## Current baseline migration
- `supabase/migrations/20260414000100_init_schema.sql` (copied from root `schema.sql`).

## Recommended flow
1. Install Supabase CLI.
2. Run:
   - `supabase login`
   - `supabase link --project-ref <project_ref>`
   - `supabase db push`
3. For future schema changes:
   - `supabase migration new <name>`
   - Add SQL in the new file
   - `supabase db push`

## Optional direct connection string usage
- `supabase db push --db-url "postgres://..."`

## Prevent seed auto-run
After running `supabase init`, set in `supabase/config.toml`:

```toml
[db.seed]
enabled = false
```
