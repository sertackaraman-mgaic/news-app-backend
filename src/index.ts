import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  // Password the dashboard (via its frontend Worker) sends to /agent as a Bearer token.
  AGENT_PASSWORD?: string;
  // Bearer token external systems send to POST /trigger.
  AGENT_TRIGGER_TOKEN?: string;
  // Signing secret from a Slack app, enables POST /slack for a slash command.
  SLACK_SIGNING_SECRET?: string;
  // Background runs go through a queue: waitUntil work is cut off 30s after a response.
  AGENT_QUEUE: Queue<AgentJob>;
}

interface AgentJob {
  source: "trigger" | "slack";
  responseUrl?: string;
}

const TOPICS = [
  "AI & capital markets",
  "Venture capital into AI in finance",
  "AI in high-speed trading",
];

const MODEL = "claude-opus-5-5";
const ARTICLES_PER_TOPIC = 5;
const MAX_ARTICLES_PER_TOPIC = 20;
const SCHEDULE_TIMEZONE = "America/New_York";
const SCHEDULE_HOUR = 7;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

interface FoundArticle {
  headline: string;
  source: string;
  published_at: string;
  url: string;
  summary: string;
  relevance_score: number;
}

interface TopicResult {
  topic: string;
  returned: number;
  inserted: number;
  skipped: number;
  removed: number;
  error?: string;
}

// ---------- /agent pipeline ----------

function buildPrompt(topic: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. Use web search to find the ${ARTICLES_PER_TOPIC} most recent and significant news articles about "${topic}" published in the past 7 days.

For each article give:
- headline: the article's headline
- source: the publication name (e.g. "Reuters", "Bloomberg")
- published_at: publication date as YYYY-MM-DD
- url: the direct URL to the article itself (not a search or index page)
- summary: a 2-3 sentence summary of what the article reports
- relevance_score: an integer from 1 to 10 for how relevant and significant it is to "${topic}"

Only include articles you actually found through search, with real URLs. Respond with only a JSON array of objects with exactly those keys, and no other text.`;
}

function extractArticles(text: string): FoundArticle[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("No JSON array in Claude's response");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Claude's response is not an array");

  return parsed
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .filter((a) => typeof a.url === "string" && /^https?:\/\//.test(a.url) && typeof a.headline === "string")
    .map((a) => ({
      headline: String(a.headline).trim(),
      source: String(a.source ?? "").trim(),
      published_at: String(a.published_at ?? "").slice(0, 10),
      url: String(a.url).trim(),
      summary: String(a.summary ?? "").trim(),
      relevance_score: Math.min(10, Math.max(1, Math.round(Number(a.relevance_score) || 1))),
    }));
}

// Progress events streamed to the dashboard while the agent runs.
type Stage = "starting" | "searching" | "checking" | "selecting" | "writing" | "saving" | "done" | "error";

interface ProgressEvent {
  type: "progress";
  topic: string;
  stage: Stage;
  searches: number;
  sources: number;
  summaries: number;
  query?: string;
  inserted?: number;
  skipped?: number;
  error?: string;
}

type Progress = (event: ProgressEvent) => void;

async function findArticles(client: Anthropic, topic: string, report: (p: Partial<ProgressEvent>) => void): Promise<FoundArticle[]> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: buildPrompt(topic) }];
  const sources = new Set<string>();
  // Claude's source-checking code sometimes re-runs a query, so count distinct queries.
  const queries = new Set<string>();
  let text = "";

  // Web search is a server tool; the API may pause a long turn, so resume until it ends.
  for (let i = 0; i < 5; i++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
      messages,
    });

    // Report each step Claude actually takes: searches, source checks (code it runs over
    // the results), thinking, and the article list as it is written.
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "server_tool_use" && block.name === "web_search") {
          const query = (block.input as { query?: string } | undefined)?.query;
          if (query) queries.add(query.trim().toLowerCase());
          report({ stage: "searching", searches: queries.size, query });
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === "web_search_result") sources.add(r.url);
          report({ stage: "searching", sources: sources.size });
        } else if (block.type === "server_tool_use" && block.name === "code_execution") {
          report({ stage: "checking" });
        } else if (block.type === "thinking") {
          report({ stage: "selecting" });
        } else if (block.type === "text") {
          report({ stage: "writing" });
        }
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        const before = (text.match(/"url"\s*:/g) ?? []).length;
        text += event.delta.text;
        const after = (text.match(/"url"\s*:/g) ?? []).length;
        if (after > before) report({ stage: "writing", summaries: Math.min(after, ARTICLES_PER_TOPIC) });
      }
    }

    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") throw new Error("Claude declined the request");

    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  return extractArticles(text).slice(0, ARTICLES_PER_TOPIC);
}

async function storeArticles(env: Env, topic: string, articles: FoundArticle[]): Promise<TopicResult> {
  let inserted = 0;
  let skipped = 0;

  for (const a of articles) {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO articles (topic, headline, source, published_at, url, ai_summary, relevance_score)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(topic, a.headline, a.source || null, a.published_at || null, a.url, a.summary || null, a.relevance_score)
      .run();
    if (res.meta.changes > 0) inserted++;
    else skipped++;
  }

  // Keep only the newest MAX_ARTICLES_PER_TOPIC per topic.
  const trim = await env.DB.prepare(
    `DELETE FROM articles WHERE topic = ?1 AND id NOT IN (
       SELECT id FROM articles WHERE topic = ?1
       ORDER BY COALESCE(published_at, fetched_at) DESC, fetched_at DESC, id DESC
       LIMIT ?2)`,
  )
    .bind(topic, MAX_ARTICLES_PER_TOPIC)
    .run();

  return { topic, returned: articles.length, inserted, skipped, removed: trim.meta.changes };
}

async function runAgent(env: Env, onProgress: Progress = () => {}) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const startedAt = new Date().toISOString();

  const topics = await Promise.all(
    TOPICS.map(async (topic): Promise<TopicResult> => {
      const state: ProgressEvent = { type: "progress", topic, stage: "starting", searches: 0, sources: 0, summaries: 0 };
      const report = (p: Partial<ProgressEvent>) => {
        Object.assign(state, p);
        onProgress({ ...state });
      };
      report({});
      try {
        const articles = await findArticles(client, topic, report);
        report({ stage: "saving", summaries: articles.length });
        const result = await storeArticles(env, topic, articles);
        report({ stage: "done", inserted: result.inserted, skipped: result.skipped });
        return result;
      } catch (err) {
        console.error(`Agent failed for "${topic}":`, err);
        report({ stage: "error", error: String(err) });
        return { topic, returned: 0, inserted: 0, skipped: 0, removed: 0, error: String(err) };
      }
    }),
  );

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    total_returned: topics.reduce((n, t) => n + t.returned, 0),
    inserted: topics.reduce((n, t) => n + t.inserted, 0),
    skipped: topics.reduce((n, t) => n + t.skipped, 0),
    topics,
  };
  console.log("Agent run", JSON.stringify(summary));
  return summary;
}

// ---------- /articles ----------

async function listArticles(env: Env, params: URLSearchParams) {
  const where: string[] = [];
  const binds: (string | number)[] = [];

  const topic = params.get("topic");
  if (topic) {
    where.push("topic = ?");
    binds.push(topic);
  }
  const from = params.get("from");
  if (from) {
    where.push("published_at >= ?");
    binds.push(from);
  }
  const to = params.get("to");
  if (to) {
    where.push("published_at <= ?");
    binds.push(to);
  }
  const source = params.get("source");
  if (source) {
    where.push("source LIKE ?");
    binds.push(`%${source}%`);
  }
  const minScore = Number(params.get("min_score"));
  if (params.has("min_score") && Number.isFinite(minScore)) {
    where.push("relevance_score >= ?");
    binds.push(minScore);
  }
  const limit = Math.min(200, Math.max(1, Number(params.get("limit")) || 50));

  const sql = `SELECT id, topic, headline, source, published_at, url, ai_summary, relevance_score, fetched_at
     FROM articles ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY published_at DESC, relevance_score DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all();
  return { count: results.length, articles: results };
}

// Streams progress as newline-delimited JSON, ending with {"type":"done","summary":...}.
// The run lives in waitUntil while the browser stays connected; if it disconnects, Cloudflare
// allows about 30 more seconds, so topics that finish by then are still saved.
function streamAgent(env: Env, ctx: ExecutionContext): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  const send = (obj: unknown) => {
    if (!open) return;
    writer.write(encoder.encode(JSON.stringify(obj) + "\n")).catch(() => (open = false));
  };

  ctx.waitUntil(
    (async () => {
      try {
        send({ type: "done", summary: await runAgent(env, send) });
      } catch (err) {
        send({ type: "error", error: String(err) });
      } finally {
        if (open) await writer.close().catch(() => {});
      }
    })(),
  );

  return new Response(readable, {
    headers: { ...CORS_HEADERS, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

// ---------- authenticated external triggers ----------

const encoder = new TextEncoder();

// Compares two strings in constant time by hashing both to equal-length digests first.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

// Returns a 401/503 response unless the request carries "Authorization: Bearer <secret>".
async function requireBearer(request: Request, secret: string | undefined): Promise<Response | null> {
  if (!secret) return json({ error: "Endpoint is not configured" }, 503);
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !(await safeEqual(token, secret))) return json({ error: "Unauthorized" }, 401);
  return null;
}

function summaryText(s: Awaited<ReturnType<typeof runAgent>>): string {
  const lines = s.topics.map((t) =>
    t.error ? `• ${t.topic}: failed (${t.error})` : `• ${t.topic}: ${t.inserted} new, ${t.skipped} already stored`,
  );
  return `News agent finished: ${s.inserted} new articles, ${s.skipped} already stored (${s.total_returned} found).\n${lines.join("\n")}`;
}

// POST /trigger with "Authorization: Bearer <AGENT_TRIGGER_TOKEN>".
// Returns 202 right away and runs in the background; add ?wait=1 to get the summary back instead.
async function handleTrigger(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  const denied = await requireBearer(request, env.AGENT_TRIGGER_TOKEN);
  if (denied) return denied;

  if (new URL(request.url).searchParams.get("wait") === "1") {
    const summary = await runAgent(env);
    return json({ status: "completed", text: summaryText(summary), summary });
  }
  await env.AGENT_QUEUE.send({ source: "trigger" });
  return json({ status: "started", message: "News agent is running; results will appear in the dashboard in about a minute." }, 202);
}

// POST /slack: Slack slash command. Verifies Slack's request signature, acknowledges
// within Slack's 3-second limit, then posts the result to the command's response_url.
async function handleSlack(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!env.SLACK_SIGNING_SECRET) return json({ error: "Slack is not configured" }, 503);

  const timestamp = request.headers.get("X-Slack-Request-Timestamp") ?? "";
  const signature = request.headers.get("X-Slack-Signature") ?? "";
  const body = await request.text();
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return json({ error: "Stale or missing timestamp" }, 401);
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.SLACK_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!(await safeEqual(signature, expected))) return json({ error: "Invalid signature" }, 401);

  const responseUrl = new URLSearchParams(body).get("response_url") ?? undefined;
  await env.AGENT_QUEUE.send({ source: "slack", responseUrl });
  return Response.json({ response_type: "ephemeral", text: "Running the news agent… I'll post the results here in about a minute." });
}

// ---------- entry points ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/health":
          return json({ status: "ok", service: "news-app-backend", timestamp: new Date().toISOString() });
        case "/agent": {
          const denied = await requireBearer(request, env.AGENT_PASSWORD);
          if (denied) return denied;
          if (url.searchParams.get("stream") === "1") return streamAgent(env, ctx);
          return json(await runAgent(env));
        }
        case "/trigger":
          return await handleTrigger(request, env, ctx);
        case "/slack":
          return await handleSlack(request, env);
        case "/articles":
          return json(await listArticles(env, url.searchParams));
        default:
          return json({ error: "Not found", endpoints: ["/health", "/agent", "/articles", "/trigger", "/slack"] }, 404);
      }
    } catch (err) {
      console.error(err);
      return json({ error: String(err) }, 500);
    }
  },

  // Runs queued by /trigger and /slack. Queue consumers get up to 15 minutes, enough for a full run.
  async queue(batch: MessageBatch<AgentJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      let text: string;
      try {
        text = summaryText(await runAgent(env));
      } catch (err) {
        text = `News agent failed: ${String(err)}`;
      }
      if (msg.body.responseUrl?.startsWith("https://hooks.slack.com/")) {
        await fetch(msg.body.responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response_type: "in_channel", text }),
        });
      }
      msg.ack();
    }
  },

  // Cron runs in UTC at both 11:00 and 12:00; only the one that is 7 AM New York time does the work,
  // so the run stays at 7 AM local across daylight saving changes.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TIMEZONE, hour: "numeric", hourCycle: "h23" }).format(
        new Date(controller.scheduledTime),
      ),
    );
    if (localHour !== SCHEDULE_HOUR) return;
    // Await directly: cron handlers get up to 15 minutes, but waitUntil work is cut off sooner.
    await runAgent(env);
  },
} satisfies ExportedHandler<Env, AgentJob>;
