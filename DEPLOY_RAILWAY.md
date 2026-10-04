# Deploy on Railway

1. Set env: `GEMINI_API_KEY`, `APP_ACCESS_TOKEN` (required in production), optional rate limits and model cascades.
2. Build: `npm run build`
3. Start: `npm start` (runs `tsx server.ts` with static `dist/`).
4. `NODE_ENV=production` without `APP_ACCESS_TOKEN` will exit with error.
