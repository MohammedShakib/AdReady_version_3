# Railway Setup (AdReady)

Use these values in Railway service settings.

## Build & Deploy

1. Custom Build Command

```bash
npm ci --prefix server && npm ci --prefix client --include=dev && npm run build --prefix client
```

2. Custom Start Command

```bash
npm run start --prefix server
```

3. Healthcheck Path

```text
/api/health
```

4. Watch Paths (add patterns)
- `/server/**`
- `/client/**`
- `/shared/**`
- `/supabase/migrations/**`

5. Add pre-deploy step
- Leave empty (recommended)

6. Cron Schedule
- Leave empty (unless you have scheduled jobs)

7. Serverless
- Disable for Telegram bot / long-running workers

8. Restart Policy
- `On Failure`
- Max restart retries: `10`

## Required Railway Variables

Minimum:
- `DATABASE_URL`
- `PGSSLMODE=true`
- `DB_AUTO_DDL=false`
- `JWT_SECRET`
- `DEFAULT_ADMIN_PASSWORD`
- `DEFAULT_SADMIN_PASSWORD`
- `OPENAI_API_KEY`

Feature-based:
- Telegram: `TELEGRAM_BOT_TOKEN` (or `BOT_TOKEN`), `TELEGRAM_BOT_USERNAME`, `TELEGRAM_MODE`, `PUBLIC_SERVER_URL` (webhook mode)
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `PAYMENT_REDIRECT_URL`, `CLIENT_BASE_URL`
- SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- Gemini: `GEMINI_API_KEY`

## Notes

- Railway injects `PORT` automatically.
- This project serves frontend from `client/dist` through the Express server.
- Supabase schema should be applied via migrations (`supabase/migrations`), not by running root `schema.sql` in deployment.
