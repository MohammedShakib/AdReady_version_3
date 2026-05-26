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

The temporary silent bypass mode is disabled in code. Users must sign in through
`/api/auth/login`.

Use the session pooler connection string from `supabase.txt` for `DATABASE_URL`.

## Notes

- The server entrypoint only starts `listen()` when run directly.
- Vercel should not be used for long-running polling workers.
- Telegram on Vercel must run in webhook mode (`TELEGRAM_MODE=webhook`).
- Use `TELEGRAM_WEBHOOK_PATH=/api/webhook` on Vercel (not `/webhook`).
- Stripe webhook endpoint on Vercel should be `https://<your-domain>/api/webhook/payment`.
- Heavy background rendering is still a candidate for a separate worker if function duration becomes an issue.
