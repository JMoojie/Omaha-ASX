// Price-fetching and storage logic for the Omaha ASX worker.
import { ASX200 } from "./asx200.js";

const CAPS = { av: 24, eod: 19 };          // daily budgets (free tiers: 25 and 20)
const PER_RUN = { av: 2, eod: 3 };         // per cron run — keeps AV under 5/minute and the run well under 50 subrequests
const AV_GAP_MS = 13000;                   // pause between Alpha Vantage calls
const TZ = "Australia/Sydney";

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const sydneyDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD

export function authed(req, env) {
  const pin = req.headers.get("x-omaha-pin") || "";
  return !!env.APP_PIN && pin.length > 0 && pin === env.APP_PIN;
}

export async function loadPrices(env) {
  const raw = await env.KV.get("prices");
  const p = raw ? JSON.parse(raw) : {};
  p.prices = p.prices || {};
  p.usage = p.usage || { day: "", av: 0, eod: 0 };
  p.fail = p.fail || {};
  return p;
}

/** Which codes to fetch next: holdings, then watchlist, then the rest of the ASX 200 — stalest first. */
export async function buildQueue(env, p, day) {
  let held = [], watch = [];
  try {
    const raw = await env.KV.get("state");
    if (raw) {
      const s = JSON.parse(JSON.parse(raw).state);
      held = Object.keys(s.holdings || {});
      watch = Object.keys(s.companies || {});
    }
  } catch (e) { /* no saved game yet */ }
  const age = (c) => (p.prices[c] && p.prices[c].f) || "0000-00-00";
  const stale = (c) => age(c) !== day;
  const rest = ASX200.filter((c) => !held.includes(c) && !watch.includes(c));
  const byAge = (a, b) => age(a).localeCompare(age(b));
  return [...new Set([...held, ...watch.sort(byAge), ...rest.sort(byAge)])].filter(stale);
}

async function fetchAV(code, env) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(code)}.AX&apikey=${env.AV_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.Note || j.Information) return { limited: true, msg: String(j.Note || j.Information).slice(0, 120) };
  const q = j["Global Quote"] || {};
  const price = parseFloat(q["05. price"]);
  if (!(price > 0)) return { empty: true };
  return { price, date: q["07. latest trading day"] || null };
}

async function fetchEOD(symbol, env) {
  const from = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
  const url = `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}?api_token=${env.EODHD_KEY}&fmt=json&order=d&from=${from}`;
  const r = await fetch(url);
  if (r.status === 402 || r.status === 429) return { limited: true, msg: `EODHD ${r.status}` };
  if (!r.ok) return { empty: true };
  const arr = await r.json();
  const row = Array.isArray(arr) ? arr[0] : null;
  const price = row && parseFloat(row.close);
  if (!(price > 0)) return { empty: true };
  return { price, date: row.date };
}

/** One batch: a few Alpha Vantage calls and a few EODHD calls, then one KV write. */
export async function runBatch(env, { manual = false } = {}) {
  const day = sydneyDay();
  const p = await loadPrices(env);
  if (p.usage.day !== day) p.usage = { day, av: 0, eod: 0 };
  const errors = [];
  const now = new Date().toISOString();
  const queue = await buildQueue(env, p, day);
  let got = 0;

  const record = (code, res, src) => {
    p.prices[code] = { p: res.price, d: res.date || day, f: day, t: now, s: src };
    delete p.fail[code];
    got++;
  };

  // 1) ASX 200 index level once a day via EODHD
  if (env.EODHD_KEY && (!p.index || p.index.f !== day) && p.usage.eod < CAPS.eod) {
    p.usage.eod++;
    try {
      const r = await fetchEOD("AXJO.INDX", env);
      if (r.price) p.index = { v: r.price, d: r.date || day, f: day };
      else if (r.limited) errors.push(r.msg);
    } catch (e) { errors.push("EODHD index error"); }
  }

  // 2) Alpha Vantage
  let avLeft = env.AV_KEY ? Math.min(PER_RUN.av, CAPS.av - p.usage.av) : 0;
  const avQueue = queue.filter((c) => !(p.fail[c] && p.fail[c].av === day));
  const done = new Set();
  for (const code of avQueue) {
    if (avLeft <= 0) break;
    avLeft--; p.usage.av++;
    try {
      const r = await fetchAV(code, env);
      if (r.limited) { errors.push(`Alpha Vantage: ${r.msg}`); p.usage.av = CAPS.av; break; }
      if (r.price) { record(code, r, "av"); done.add(code); }
      else p.fail[code] = Object.assign(p.fail[code] || {}, { av: day });   // let EODHD try it instead
    } catch (e) { errors.push(`Alpha Vantage error on ${code}`); }
    if (avLeft > 0) await new Promise((res) => setTimeout(res, env.AV_GAP_MS ? Number(env.AV_GAP_MS) : AV_GAP_MS));
  }

  // 3) EODHD
  let eodLeft = env.EODHD_KEY ? Math.min(PER_RUN.eod, CAPS.eod - p.usage.eod) : 0;
  for (const code of queue) {
    if (eodLeft <= 0) break;
    if (done.has(code) || (p.fail[code] && p.fail[code].eod === day)) continue;
    eodLeft--; p.usage.eod++;
    try {
      const r = await fetchEOD(`${code}.AU`, env);
      if (r.limited) { errors.push(r.msg); p.usage.eod = CAPS.eod; break; }
      if (r.price) record(code, r, "eod");
      else p.fail[code] = Object.assign(p.fail[code] || {}, { eod: day });
    } catch (e) { errors.push(`EODHD error on ${code}`); }
  }

  if (!env.AV_KEY && !env.EODHD_KEY) errors.push("No data keys set — add AV_KEY and/or EODHD_KEY as secrets.");
  p.lastRun = now;
  p.lastErrors = errors.slice(0, 5);
  p.today = day;
  p.caps = CAPS;
  await env.KV.put("prices", JSON.stringify(p));
  const remaining = queue.length - got;
  return { got, remaining, usage: p.usage, errors, summary: `Fetched ${got} price${got === 1 ? "" : "s"}. ${remaining} still waiting. Used today: Alpha Vantage ${p.usage.av}/${CAPS.av}, EODHD ${p.usage.eod}/${CAPS.eod}.` };
}

