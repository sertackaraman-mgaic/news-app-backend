# news-app-backend

Cloudflare Worker + D1 backend for a News Intelligence App covering AI & capital markets, venture capital into AI in finance, and AI in high-speed trading.

## Endpoints

- `GET /health` — service status and current timestamp
- `GET /agent` — runs the pipeline: Claude with web search finds the 5 most significant articles from the past 7 days per topic, stores new ones (deduped by URL), and keeps each topic capped at 20 articles. Also runs daily at 7 AM US Eastern.
- `GET /articles` — query stored articles. Optional params: `topic`, `from`, `to` (YYYY-MM-DD), `source`, `min_score`, `limit` (default 50, max 200)

All responses include CORS headers.

## Setup

```bash
npm install
npx wrangler d1 migrations apply news-db --remote
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Secrets live in `.env` locally (gitignored) and as Worker secrets in Cloudflare; none are committed.
