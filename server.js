// Dodie — Telegram AI bot + HTML boshqaruv paneli.
// Ishga tushirish: npm start  ->  http://localhost:3000
import { config, ROOT } from "./src/env.js"; // birinchi bo'lib .env yuklanadi
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as store from "./src/store.js";
import { botStatus, startBot, generateReply, enqueue } from "./src/bot.js";

const PANEL_CHAT = "panel";

function publicState() {
  return {
    bot: { ...botStatus },
    ai: {
      provider: config.aiProviderLabel,
      model: config.aiModel,
      keySet: Boolean(config.aiKey),
      keyUrl: config.aiKeyUrl,
    },
    access: config.allowedUserIds.size ? "restricted" : "everyone",
    settings: store.getSettings(),
    defaultPersona: store.DEFAULT_PERSONA,
    stats: store.getStats(),
    chats: store.listChats(),
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

async function readJson(req) {
  // Boshqa saytlardan so'rov yuborilishining oldini olish: faqat application/json qabul qilinadi
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type application/json bo'lishi kerak"), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error("So'rov juda katta"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("JSON noto'g'ri"), { status: 400 });
  }
}

function checkAuth(req) {
  if (!config.panelPassword) return true;
  const [scheme, encoded] = String(req.headers.authorization ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
  const a = crypto.createHash("sha256").update(pass).digest();
  const b = crypto.createHash("sha256").update(config.panelPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

const STATIC = {
  "/": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/lib/format.js": { file: "src/format.js", type: "text/javascript; charset=utf-8" },
};

// ---------- SSE (jonli yangilanishlar) ----------
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
for (const ev of ["message", "status", "stats", "settings"]) store.events.on(ev, (d) => broadcast(ev, d));
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();

// ---------- marshrutlar ----------
async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (!checkAuth(req)) {
    return send(res, 401, "Parol kerak", { "www-authenticate": 'Basic realm="Dodie panel", charset="UTF-8"' });
  }

  if (req.method === "GET" && STATIC[p]) {
    const { file, type } = STATIC[p];
    return send(res, 200, fs.readFileSync(path.join(ROOT, file)), { "content-type": type });
  }

  if (req.method === "GET" && p === "/api/state") return send(res, 200, publicState());

  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const chatMatch = p.match(/^\/api\/chats\/([^/]+)(\/reset)?$/);
  if (chatMatch) {
    const id = decodeURIComponent(chatMatch[1]);
    if (req.method === "GET" && !chatMatch[2]) {
      const chat = store.getChat(id);
      return chat ? send(res, 200, chat) : send(res, 404, { error: "Chat topilmadi" });
    }
    if (req.method === "POST" && chatMatch[2]) {
      await readJson(req);
      store.resetContext(id);
      return send(res, 200, { ok: true });
    }
  }

  if (req.method === "POST" && p === "/api/settings") {
    const body = await readJson(req);
    return send(res, 200, store.updateSettings(body));
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

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
    else res.end();
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[panel] ${config.port}-port band. .env da PORT ni o'zgartiring yoki eski jarayonni to'xtating.`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  const shown = config.host === "0.0.0.0" ? "localhost" : config.host;
  console.log(`\n  🤖 Dodie paneli:  http://${shown}:${config.port}`);
  console.log(`  AI: ${config.aiProviderLabel} · ${config.aiModel}${config.aiKey ? "" : "  (AI_API_KEY yo'q!)"}\n`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.panelPassword) {
    console.warn("  ⚠  Panel tashqaridan ochiq, lekin PANEL_PASSWORD o'rnatilmagan!\n");
  }
});

startBot();

function shutdown() {
  store.saveNow();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
