# Vercel Setup (AdReady)

This project can run on Vercel as a static client plus Vercel Functions API.

## Build

Use the existing root build command:

```bash
npm run build
```

The client is built into `client/dist`.

## Runtime

- Frontend is served statically from `client/dist`
- API routes are exposed from the `api/` directory
- `/api/auth/login`, `/api/auth/signup`, and the other Express routes are handled by the shared server app

## Notes

- The server entrypoint only starts `listen()` when run directly.
- Vercel should not be used for long-running polling workers.
- Telegram polling should be replaced with webhook mode if you want it fully on Vercel.
- Heavy background rendering is still a candidate for a separate worker if function duration becomes an issue.
