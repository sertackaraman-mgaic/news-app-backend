# news-app-backend

Cloudflare Worker + D1 backend for a News Intelligence App covering AI & capital markets, venture capital into AI in finance, and AI in high-speed trading.

## Endpoints

- `GET /health` — service status and current timestamp
- `GET /agent` — runs the pipeline: Claude with web search finds the 5 most significant articles from the past 7 days per topic, stores new ones (deduped by URL), and keeps each topic capped at 20 articles. Add `?stream=1` to get live progress as newline-delimited JSON (used by the dashboard). Also runs daily at 7 AM US Eastern.
- `GET /articles` — query stored articles. Optional params: `topic`, `from`, `to` (YYYY-MM-DD), `source`, `min_score`, `limit` (default 50, max 200)

All responses include CORS headers.

## Setup

```bash
npm install
npx wrangler d1 migrations apply news-db --remote
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

The dashboard lives in `frontend/` (static page served by the `news-app-frontend` Worker). Deploy it with `cd frontend && npx wrangler deploy`.

Secrets live in `.env` locally (gitignored) and as Worker secrets in Cloudflare; none are committed.

## Triggering the agent from other systems

`POST /trigger` runs the news agent for any external caller that presents the secret token. It is stored as the Worker secret `AGENT_TRIGGER_TOKEN` (a local copy lives in the gitignored `.env`). Requests without a valid token get `401`.

Background runs are handed to the `news-agent-runs` Cloudflare Queue, so the caller gets an answer immediately and the run (about a minute) is not cut off.

### curl / any HTTP client

```bash
# Start a run and return immediately (202)
curl -X POST https://news-app-backend.sertac-karaman-ef0.workers.dev/trigger \
  -H "Authorization: Bearer $AGENT_TRIGGER_TOKEN"

# Wait for the run to finish (~1 min) and get the summary back
curl -X POST "https://news-app-backend.sertac-karaman-ef0.workers.dev/trigger?wait=1" \
  -H "Authorization: Bearer $AGENT_TRIGGER_TOKEN"
```

### Zapier, Make, n8n, GitHub Actions, or email

Any tool that can send a webhook works. Configure an HTTP request step:

- Method: `POST`
- URL: `https://news-app-backend.sertac-karaman-ef0.workers.dev/trigger`
- Header: `Authorization: Bearer <your token>`

To trigger from email, use the tool's email trigger (e.g. Zapier "Email by Zapier" or a Make mailhook) followed by that HTTP step. Keep the token in the tool's secret or connection settings, not in the email itself.

### Slack slash command

1. Create a Slack app at https://api.slack.com/apps, then add a slash command (for example `/news`) with Request URL `https://news-app-backend.sertac-karaman-ef0.workers.dev/slack`.
2. Copy the app's **Signing Secret** (Basic Information page) and store it on the Worker:
   ```bash
   npx wrangler secret put SLACK_SIGNING_SECRET
   ```
3. Install the app to your workspace and type `/news`. Slack shows "Running the news agent…" right away, and the results are posted to the channel about a minute later.

The Worker checks Slack's request signature and rejects anything unsigned or older than five minutes.

### Rotating the token

```bash
openssl rand -hex 32 | npx wrangler secret put AGENT_TRIGGER_TOKEN
```

Update `.env` and any tools that use the old token.
