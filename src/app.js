// HTTP marshrutlar — lokal server (server.js) va Vercel (api/index.js) uchun umumiy.
import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "./env.js";
import * as store from "./store.js";
import { FORMAT_LIB_SOURCE } from "./format.js";
import { kv, kvKind } from "./kv.js";
import { botStatus, generateReply, enqueue, handleMessage, IS_VERCEL, webhookSecret, setupWebhook, webhookStatus, ensureWebhook } from "./bot.js";

const PANEL_CHAT = "panel";

function publicUrl(req) {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return host ? `https://${host}` : null;
}

async function publicState(req) {
  const bot = IS_VERCEL ? await webhookStatus(publicUrl(req)) : { ...botStatus };
  bot.lastError = (await kv.get("lastError")) ?? null;
  return {
    mode: IS_VERCEL ? "vercel" : "local",
    storage: kvKind,
    bot,
    ai: { provider: config.aiProviderLabel, model: config.aiModel, keySet: Boolean(config.aiKey), keyUrl: config.aiKeyUrl },
    access: config.allowedUserIds.size ? "restricted" : "everyone",
    settings: await store.getSettings(),
    defaultPersona: store.DEFAULT_PERSONA,
    stats: await store.getStats(),
    chats: await store.listChats(),
  };
}

// ---------- yordamchi funksiyalar ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req) {
  if (req.body !== undefined) {
    // Vercel so'rov tanasini o'zi o'qib qo'ygan bo'lishi mumkin
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString() || "{}") : req.body ?? {};
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error("So'rov juda katta"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("JSON noto'g'ri"), { status: 400 });
  }
}

async function readJson(req) {
  // Boshqa saytlardan so'rov yuborilishining oldini olish: faqat application/json
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type application/json bo'lishi kerak"), { status: 415 });
  }
  return readBody(req);
}

const safeEqual = (a, b) =>
  crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());

function checkAuth(req) {
  if (!config.panelPassword) return true;
  const [scheme, encoded] = String(req.headers.authorization ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
  return safeEqual(pass, config.panelPassword);
}

// Vercel fayllarni to'g'ri ko'chirishi uchun yo'llar statik (new URL(..., import.meta.url)) yozilgan
const PANEL_HTML = new URL("../panel/index.html", import.meta.url);
const STATIC = {
  "/": { file: PANEL_HTML, type: "text/html; charset=utf-8" },
  "/index.html": { file: PANEL_HTML, type: "text/html; charset=utf-8" },
};

// ---------- SSE (faqat lokal rejimda) ----------
const clients = new Set();
if (!IS_VERCEL) {
  for (const ev of ["message", "status", "stats", "settings"]) {
    store.events.on(ev, (d) => {
      const payload = `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
      for (const res of clients) res.write(payload);
    });
  }
  setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000).unref();
}

// ---------- marshrutlar ----------
let webhookChecked = null;
async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  // Vercel rewrite asl yo'lni ?__path= orqali uzatadi (vercel.json)
  const p = url.searchParams.get("__path") || url.pathname;

  // Telegram webhook (parolsiz, lekin maxfiy kalit bilan tekshiriladi)
  if (p === "/api/telegram") {
    if (req.method !== "POST") return send(res, 405, { error: "POST kerak" });
    if (!webhookSecret || !safeEqual(req.headers["x-telegram-bot-api-secret-token"] ?? "", webhookSecret)) {
      return send(res, 401, { error: "Ruxsat yo'q" });
    }
    const update = await readBody(req);
    // Telegram javobni kutmasa qayta yuborishi mumkin — takrorini o'tkazib yuboramiz
    if (update?.message && (await kv.once(`upd:${update.update_id}`, 3600))) {
      await handleMessage(update.message).catch((err) => console.error("[webhook] xato:", err.message));
    }
    return send(res, 200, { ok: true });
  }

  // Kunlik Vercel Cron (vercel.json): webhook uzilib qolgan bo'lsa qayta ulaydi
  if (p === "/api/cron") {
    if (process.env.CRON_SECRET && !safeEqual(req.headers.authorization ?? "", `Bearer ${process.env.CRON_SECRET}`)) {
      return send(res, 401, { error: "Ruxsat yo'q" });
    }
    if (!IS_VERCEL) return send(res, 200, { ok: true, skipped: "local" });
    const info = await ensureWebhook(publicUrl(req));
    return send(res, 200, { ok: true, url: info?.url ?? null, reconnected: Boolean(info?.reconnected) });
  }

  // Har bir yangi Vercel nusxasi (deploy'dan keyin ham) birinchi so'rovda webhookni tekshiradi
  if (IS_VERCEL && !webhookChecked) {
    webhookChecked = ensureWebhook(publicUrl(req)).catch((err) => {
      webhookChecked = null;
      console.error("[webhook] tekshiruv xatosi:", err.message);
    });
    await webhookChecked;
  }

  if (req.method === "GET" && STATIC[p]) {
    const { file, type } = STATIC[p];
    let body = fs.readFileSync(file, "utf8");
    if (file === PANEL_HTML) {
      // format.js ni sahifaning o'ziga joylaymiz — alohida so'rov kerak bo'lmasin
      body = body.replace('import { toTelegramHtml, escapeHtml } from "/lib/format.js";', FORMAT_LIB_SOURCE);
    }
    return send(res, 200, body, { "content-type": type });
  }

  if (!p.startsWith("/api/")) return send(res, 404, { error: "Topilmadi" });

  // Vercel'da panel internetga ochiq — parolsiz ishlatishga yo'l qo'ymaymiz
  if (IS_VERCEL && !config.panelPassword) {
    return send(res, 503, { error: "Vercel sozlamalarida PANEL_PASSWORD o'rnatilmagan. Uni qo'shing va qayta deploy qiling." });
  }
  if (!checkAuth(req)) {
    return send(res, 401, { error: "Parol kerak" }, { "www-authenticate": 'Basic realm="Dodie panel", charset="UTF-8"' });
  }

  if (req.method === "GET" && p === "/api/state") return send(res, 200, await publicState(req));

  if (req.method === "GET" && p === "/api/events") {
    if (IS_VERCEL) return send(res, 204, "");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && p === "/api/webhook") {
    await readJson(req);
    const base = publicUrl(req);
    if (!IS_VERCEL || !base) return send(res, 400, { error: "Webhook faqat Vercel'da kerak" });
    const hook = await setupWebhook(base);
    return send(res, 200, { ok: true, url: hook });
  }

  const chatMatch = p.match(/^\/api\/chats\/([^/]+)(\/reset)?$/);
  if (chatMatch) {
    const id = decodeURIComponent(chatMatch[1]);
    if (req.method === "GET" && !chatMatch[2]) {
      const chat = await store.getChat(id);
      return chat ? send(res, 200, chat) : send(res, 404, { error: "Chat topilmadi" });
    }
    if (req.method === "POST" && chatMatch[2]) {
      await readJson(req);
      await store.resetContext(id);
      return send(res, 200, { ok: true });
    }
  }

  if (req.method === "POST" && p === "/api/settings") {
    return send(res, 200, await store.updateSettings(await readJson(req)));
  }

  if (req.method === "POST" && p === "/api/test") {
    const { text } = await readJson(req);
    const clean = String(text ?? "").trim().slice(0, 4000);
    if (!clean) return send(res, 400, { error: "Xabar bo'sh" });
    let reply;
    await enqueue(PANEL_CHAT, async () => {
      reply = await generateReply(PANEL_CHAT, { title: "Sinov (panel)", type: "panel" }, clean, "Siz");
    });
    return send(res, 200, reply);
  }

  send(res, 404, { error: "Topilmadi" });
}

export async function handle(req, res) {
  try {
    await route(req, res);
  } catch (err) {
    console.error("[app]", err.message);
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
    else res.end();
  }
}
