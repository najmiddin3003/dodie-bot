// Kichik kalit-qiymat ombori: Upstash Redis (Vercel) yoki lokal fayl (data/state.json).
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.js";

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
export const kvKind = REDIS_URL && REDIS_TOKEN ? "redis" : "file";

const P = "dodie:";

// ---------- Upstash Redis (REST API, paketsiz) ----------
async function redis(commands) {
  const res = await fetch(`${REDIS_URL.replace(/\/+$/, "")}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data)) throw new Error(`Redis xatosi: HTTP ${res.status}`);
  return data.map((r) => {
    if (r.error) throw new Error(`Redis xatosi: ${r.error}`);
    return r.result;
  });
}

const redisKv = {
  async get(key) {
    const [v] = await redis([["GET", P + key]]);
    return v == null ? null : JSON.parse(v);
  },
  async set(key, value) {
    await redis([["SET", P + key, JSON.stringify(value)]]);
  },
  async incr(key, fields) {
    const cmds = Object.entries(fields).filter(([, n]) => n).map(([f, n]) => ["HINCRBY", P + key, f, String(n)]);
    if (cmds.length) await redis(cmds);
  },
  async hgetall(key) {
    const [arr] = await redis([["HGETALL", P + key]]);
    const out = {};
    for (let i = 0; i < (arr ?? []).length; i += 2) out[arr[i]] = Number(arr[i + 1]);
    return out;
  },
  async zadd(key, score, member) {
    await redis([["ZADD", P + key, String(score), member]]);
  },
  async zrevrange(key, count) {
    const [arr] = await redis([["ZRANGE", P + key, "0", String(count - 1), "REV"]]);
    return arr ?? [];
  },
  async zcard(key) {
    const [n] = await redis([["ZCARD", P + key]]);
    return n ?? 0;
  },
  /** true — birinchi marta (takroriy webhook'larni aniqlash uchun). */
  async once(key, ttlSec) {
    const [r] = await redis([["SET", P + key, "1", "NX", "EX", String(ttlSec)]]);
    return r === "OK";
  },
};

// ---------- Lokal fayl ----------
const FILE = path.join(ROOT, "data", "state.json");
let mem = null;
function load() {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[kv] state.json o'qilmadi, yangidan boshlanadi:", err.message);
    mem = {};
  }
  mem.kv ??= {};
  mem.hash ??= {};
  mem.zset ??= {};
  return mem;
}
const onceKeys = new Map();
let timer = null;
function scheduleSave() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushFile();
  }, 1000);
}
export function flushFile() {
  if (kvKind !== "file" || !mem) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(mem));
    try {
      fs.renameSync(tmp, FILE);
    } catch {
      fs.writeFileSync(FILE, JSON.stringify(mem));
    }
  } catch (err) {
    console.error("[kv] saqlashda xato:", err.message);
  }
}

const fileKv = {
  async get(key) {
    const v = load().kv[key];
    return v === undefined ? null : structuredClone(v);
  },
  async set(key, value) {
    load().kv[key] = structuredClone(value);
    scheduleSave();
  },
  async incr(key, fields) {
    const h = (load().hash[key] ??= {});
    for (const [f, n] of Object.entries(fields)) h[f] = (h[f] ?? 0) + (n || 0);
    scheduleSave();
  },
  async hgetall(key) {
    return { ...(load().hash[key] ?? {}) };
  },
  async zadd(key, score, member) {
    (load().zset[key] ??= {})[member] = score;
    scheduleSave();
  },
  async zrevrange(key, count) {
    return Object.entries(load().zset[key] ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([m]) => m);
  },
  async zcard(key) {
    return Object.keys(load().zset[key] ?? {}).length;
  },
  async once(key, ttlSec) {
    const now = Date.now();
    for (const [k, exp] of onceKeys) if (exp < now) onceKeys.delete(k);
    if (onceKeys.has(key)) return false;
    onceKeys.set(key, now + ttlSec * 1000);
    return true;
  },
};

export const kv = kvKind === "redis" ? redisKv : fileKv;
