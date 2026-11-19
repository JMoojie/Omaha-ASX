/**
 * Omaha ASX — Cloudflare Worker (free tier)
 *
 * - Serves the game from /public (static assets are free and unlimited).
 * - /api/state   GET/PUT  your saved game (protected by APP_PIN)
 * - /api/prices  GET      latest prices collected by the scheduler
 * - /api/sync    POST     run one fetch batch now (protected by APP_PIN)
 * - scheduled()           cron batches on weekday evenings after the ASX closes
 *
 * Free data sources, used together:
 *   Alpha Vantage free key  — 25 requests/day, ~5/minute   (symbol format CBA.AX)
 *   EODHD free key          — 20 requests/day               (symbol format CBA.AU, index AXJO.INDX)
 * We stay one under each cap to leave headroom.
 */
import { json, sydneyDay, authed, loadPrices, runBatch } from "./core.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    if (url.pathname === "/api/prices" && req.method === "GET") {
      const p = await loadPrices(env);
      delete p.fail;
      p.today = sydneyDay();
      return json(p);
    }

    if (!env.APP_PIN) return json({ error: "APP_PIN secret is not set on the server." }, 500);
    if (!authed(req, env)) return json({ error: "Wrong or missing PIN." }, 401);

    if (url.pathname === "/api/state") {
      if (req.method === "GET") {
        const raw = await env.KV.get("state");
        return json(raw ? JSON.parse(raw) : {});
      }
      if (req.method === "PUT") {
        const body = await req.text();
        if (body.length > 5_000_000) return json({ error: "Save too large." }, 413);
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { return json({ error: "Bad JSON." }, 400); }
        if (typeof parsed.state !== "string") return json({ error: "Missing state." }, 400);
        await env.KV.put("state", JSON.stringify({ state: parsed.state, updatedAt: parsed.updatedAt || Date.now() }));
        return json({ ok: true });
      }
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      return json(await runBatch(env, { manual: true }));
    }

    return json({ error: "Not found." }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBatch(env));
  },
};

