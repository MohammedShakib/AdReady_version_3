# Vercel Setup (AdReady)

This project can run on Vercel as a static client plus Vercel Functions API.

## Build

Use the existing root build command:

```bash
npm run build
```

The client is built into `client/dist` during build and copied to root `dist/` for Vercel output.

## Runtime

- Frontend is served statically from root `dist/` on Vercel
- API routes are exposed from the `api/` directory
- `/api/auth/login`, `/api/auth/signup`, and the other Express routes are handled by the shared server app

## Supabase env

For the migrated Supabase project, add these environment variables in the Vercel project settings:

- `DATABASE_URL`
- `PGSSLMODE=true`
- `DB_AUTO_DDL=false`
- `JWT_SECRET`
- `DEFAULT_ADMIN_PASSWORD`
- `DEFAULT_SADMIN_PASSWORD`

If you want the temporary silent bypass mode for your own account, also set:

- `ALLOW_DEV_AUTH_BYPASS=true`
- `DEV_AUTH_BYPASS_PASSWORD=admin`
- `DEV_AUTH_BYPASS_TOKEN=dev-auth-bypass`
- `VITE_ALLOW_DEV_AUTH_BYPASS=true`
- `VITE_DEV_AUTH_BYPASS_TOKEN=dev-auth-bypass`
- `VITE_DEV_AUTH_BYPASS_USERNAME=sadmin`

Use the session pooler connection string from `supabase.txt` for `DATABASE_URL`.

## Notes

- The server entrypoint only starts `listen()` when run directly.
- Vercel should not be used for long-running polling workers.
- Telegram polling should be replaced with webhook mode if you want it fully on Vercel.
- Heavy background rendering is still a candidate for a separate worker if function duration becomes an issue.
