// Serves the dashboard and proxies POST /api/refresh to the backend's /agent, adding the
// AGENT_PASSWORD secret server-side so it never appears in the page's JavaScript.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/refresh") {
      if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
      const upstream = await env.BACKEND.fetch("https://backend/agent?stream=1", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.AGENT_PASSWORD}` },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
