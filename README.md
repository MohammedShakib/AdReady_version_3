# AdReady

AdReady is a full-stack ad creation platform with a React/Vite frontend and an Express/Node backend. It includes AI-assisted image and video generation, Telegram workflows, Stripe billing, email verification, and PostgreSQL/Supabase-backed persistence.

## What's inside

- `client/` - React app for landing, login, dashboard, and super-admin views
- `server/` - Express API, payment webhooks, Telegram bot logic, and Remotion rendering
- `shared/` - Shared prompt-building helpers used by client/server logic
- `supabase/` - Database migrations and Supabase configuration
- `docs/` - Setup notes for Supabase and Vercel

## Prerequisites

- Node.js 20+
- A PostgreSQL database or Supabase project
- Required API keys and integration credentials from your deployment environment

## Environment

Copy `server/.env.example` to your environment and fill in the values you need.

If you are migrating to Supabase, use `server/.env.supabase.example` as the baseline and set the same database env vars in Vercel project settings.
For a temporary silent admin bypass in your own environment, also set the `ALLOW_DEV_AUTH_BYPASS` and `VITE_ALLOW_DEV_AUTH_BYPASS` flags to `true`.

Minimum commonly used variables:

- `DATABASE_URL`
- `PGSSLMODE=true`
- `DB_AUTO_DDL=false`
- `JWT_SECRET`
- `DEFAULT_ADMIN_PASSWORD`
- `DEFAULT_SADMIN_PASSWORD`
- `OPENAI_API_KEY`

Optional integrations:

- `GEMINI_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `SMTP_HOST`
- `SMTP_USER`
- `SMTP_PASS`

## Install

From the repo root:

```bash
npm ci --prefix server
npm ci --prefix client --include=dev
```

## Development

Run the client and server separately:

```bash
npm run dev --prefix client
npm run dev --prefix server
```

The client uses Vite during development. The server serves the built frontend from `client/dist` locally and from root `dist/` on Vercel.

## Build

```bash
npm run build
```

The root build command installs dependencies in both apps and builds the client bundle.

## Start

```bash
npm start
```

This starts the Express server.

## Deployment notes

- Supabase migration and schema notes: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)
- Vercel build and runtime notes: [docs/VERCEL_SETUP.md](docs/VERCEL_SETUP.md)
- The server exposes `/api/health` for health checks
- Static frontend assets are served from `client/dist` locally and root `dist/` on Vercel

## License

No license file has been added yet.
