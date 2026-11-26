// Telegram bot logikasi: lokalda long polling, Vercel'da webhook.
import crypto from "node:crypto";
import { config } from "./env.js";
import * as store from "./store.js";
import { kv } from "./kv.js";
import { askDodie, userMessageFor, ownerHintFor } from "./ai.js";
import { toTelegramHtml, splitMessage } from "./format.js";

export const IS_VERCEL = Boolean(process.env.VERCEL);

/** Webhook so'rovlari haqiqatan Telegram'dan kelganini tekshirish uchun maxfiy kalit (tokendan hosil qilinadi). */
export const webhookSecret = config.telegramToken
  ? crypto.createHash("sha256").update("dodie-webhook:" + config.telegramToken).digest("hex").slice(0, 48)
  : "";

// Lokal rejim holati (Vercel'da getWebhookInfo ishlatiladi)
export const botStatus = {
  state: "starting", // starting | online | offline | no_token | bad_token | conflict | webhook_active
  username: null,
  name: null,
  error: null,
  lastError: null,
};

function setStatus(patch) {
  Object.assign(botStatus, patch);
  store.events.emit("status", { ...botStatus });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Telegram API ----------
export async function tg(method, params = {}, timeoutMs = 15_000) {
  let res;
  try {
    res = await fetch(`${config.telegramApi}/bot${config.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Token URL ichida — xabarda URL ko'rsatilmaydi
    const e = new Error(`Telegram'ga ulanib bo'lmadi (${err.cause?.code ?? err.name})`);
    e.network = true;
    throw e;
  }
  const data = await res.json().catch(() => ({ ok: false, error_code: res.status, description: `HTTP ${res.status}` }));
  if (!data.ok) {
    const e = new Error(data.description ?? `Telegram ${method} xatosi`);
    e.code = data.error_code;
    e.retryAfter = data.parameters?.retry_after;
    throw e;
  }
  return data.result;
}

async function sendReply(chatId, text, replyTo) {
  const extra = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
  for (const [i, chunk] of splitMessage(text).entries()) {
    const params = { chat_id: chatId, ...(i === 0 ? extra : {}), link_preview_options: { is_disabled: true } };
    try {
      await tg("sendMessage", { ...params, text: toTelegramHtml(chunk), parse_mode: "HTML" });
    } catch (err) {
      if (err.code !== 400) throw err;
      await tg("sendMessage", { ...params, text: chunk }); // HTML buzilgan bo'lsa — oddiy matn
    }
  }
}

function keepTyping(chatId) {
  const ping = () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  const t = setInterval(ping, 4500);
  return () => clearInterval(t);
}

// ---------- Javob yaratish (Telegram va panel uchun umumiy) ----------
const queues = new Map();

/** Bitta chatdagi xabarlar navbat bilan qayta ishlanadi — tarix tartibi buzilmasin. */
export function enqueue(chatId, task) {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => console.error("[bot] navbatda xato:", err.message));
  queues.set(chatId, next);
  next.finally(() => queues.get(chatId) === next && queues.delete(chatId));
  return next;
}

export async function generateReply(chatId, chatMeta, text, fromName) {
  const userMsg = await store.addMessage(chatId, chatMeta, { role: "user", text, from: fromName });
  try {
    const result = await askDodie({
      persona: (await store.getSettings()).persona,
      history: await store.contextFor(chatId),
    });
    await store.addMessage(chatId, null, { role: "assistant", text: result.text });
    await store.addStats({ replies: 1, ...result.usage });
    if (botStatus.lastError || IS_VERCEL) {
      setStatus({ lastError: null });
      await kv.set("lastError", null);
    }
    return { ok: true, text: result.text };
  } catch (err) {
    await store.markSkipped(chatId, userMsg.at); // muvaffaqiyatsiz savol keyingi kontekstga kirmasin
    const hint = ownerHintFor(err);
    console.error(`[ai] ${err.kind ?? "xato"}: ${err.message}`);
    await store.addMessage(chatId, null, { role: "note", text: hint, error: true });
    await store.addStats({ errors: 1 });
    setStatus({ lastError: { hint, at: Date.now() } });
    await kv.set("lastError", botStatus.lastError);
    return { ok: false, text: userMessageFor(err), hint };
  }
}

// ---------- Kiruvchi xabarlarni qayta ishlash ----------
const HELP = `Men <b>Dodie</b> — sun'iy intellekt yordamchisiman 🤖

Menga istalgan savolni yozing, javob beraman.

/reset — suhbatni yangidan boshlash
/help — yordam`;

function displayName(user) {
  if (!user) return "Noma'lum";
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
}

function chatMetaOf(chat) {
  const title = chat.type === "private" ? displayName(chat) + (chat.username ? ` (@${chat.username})` : "") : chat.title;
  return { title, type: chat.type };
}

let meCache = null;
async function myUsername() {
  if (botStatus.username) return botStatus.username;
  meCache ??= tg("getMe").then((me) => me.username).catch(() => { meCache = null; return ""; });
  return meCache;
}

/** Bitta Telegram xabarini qayta ishlaydi; javob yuborilgunicha kutadi. */
export async function handleMessage(msg) {
  const chat = msg.chat;
  const isPrivate = chat.type === "private";
  let text = msg.text ?? "";

  if (config.allowedUserIds.size && !config.allowedUserIds.has(msg.from?.id)) {
    if (isPrivate) {
      await tg("sendMessage", { chat_id: chat.id, text: `Kechirasiz, bu bot yopiq. Sizning Telegram ID: ${msg.from?.id}` }).catch(() => {});
    }
    return;
  }

  const me = await myUsername();
  const cmd = text.match(/^\/(\w+)(?:@(\w+))?/);
  if (cmd) {
    if (cmd[2] && cmd[2].toLowerCase() !== me.toLowerCase()) return; // boshqa botga
    const name = cmd[1].toLowerCase();
    if (name === "start" || name === "help") {
      await tg("sendMessage", { chat_id: chat.id, text: HELP, parse_mode: "HTML" });
      return;
    }
    if (name === "reset" || name === "yangi") {
      await store.resetContext(chat.id, chatMetaOf(chat));
      await tg("sendMessage", { chat_id: chat.id, text: "🧹 Suhbat yangilandi. Qani, yangi savol bering!" });
      return;
    }
  }

  if (!text.trim()) {
    if (isPrivate) await tg("sendMessage", { chat_id: chat.id, text: "Hozircha faqat matnli xabarlarga javob bera olaman 🙂" });
    return;
  }

  // Guruhda faqat murojaat qilinganda: @mention, reply yoki "Dodie" so'zi
  if (!isPrivate) {
    const mentioned = me && text.toLowerCase().includes(`@${me.toLowerCase()}`);
    const repliedToMe = me && msg.reply_to_message?.from?.username === me;
    const calledByName = /(^|[^\p{L}])dodie([^\p{L}]|$)/iu.test(text);
    if (!mentioned && !repliedToMe && !calledByName) return;
    if (me) text = text.replace(new RegExp(`@${me}`, "ig"), "").trim() || "Salom!";
  }

  if (!(await store.getSettings()).enabled) {
    if (isPrivate) await tg("sendMessage", { chat_id: chat.id, text: "Dodie hozir dam olyapti 😴 Keyinroq yozing." });
    return;
  }

  await enqueue(String(chat.id), async () => {
    const stopTyping = keepTyping(chat.id);
    try {
      const reply = await generateReply(chat.id, chatMetaOf(chat), text, displayName(msg.from));
      await sendReply(chat.id, reply.text, isPrivate ? null : msg.message_id);
    } finally {
      stopTyping();
    }
  });
}

// ---------- Webhook (Vercel) ----------
const COMMANDS = [
  { command: "reset", description: "Suhbatni yangidan boshlash" },
  { command: "help", description: "Yordam" },
];

export async function setupWebhook(publicUrl) {
  const url = hookUrl(publicUrl);
  await tg("setWebhook", { url, secret_token: webhookSecret, allowed_updates: ["message"], drop_pending_updates: false });
  await tg("setMyCommands", { commands: COMMANDS }).catch(() => {});
  return url;
}

const hookUrl = (publicUrl) => `${publicUrl.replace(/\/+$/, "")}/api/telegram`;

/**
 * Webhook doim ulangan bo'lishini ta'minlaydi: manzil noto'g'ri, yo'q yoki Telegram
 * maxfiy kalit/manzil xatosini (401/403/404) qaytarayotgan bo'lsa — qayta ulaydi.
 * Panel ochilganda, har bir yangi Vercel nusxasida va kunlik cron'da chaqiriladi.
 */
export async function ensureWebhook(publicUrl) {
  if (!config.telegramToken || !publicUrl) return null;
  const expected = hookUrl(publicUrl);
  let info = await tg("getWebhookInfo");
  const recentErr = info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600 ? info.last_error_message : "";
  const authErr = /\b(401|403|404)\b/.test(recentErr ?? "");
  if (info.url !== expected || authErr) {
    console.log(`[webhook] qayta ulanmoqda: ${info.url || "(yo'q)"} -> ${expected}`);
    await setupWebhook(publicUrl);
    info = await tg("getWebhookInfo");
    info.reconnected = true;
  }
  return info;
}

/** Vercel rejimidagi holat (panel uchun). Webhook uzilgan bo'lsa, o'zi qayta ulaydi. */
export async function webhookStatus(publicUrl) {
  if (!config.telegramToken) return { state: "no_token", error: "Vercel sozlamalarida TELEGRAM_BOT_TOKEN yo'q" };
  try {
    const me = await tg("getMe");
    const info = (await ensureWebhook(publicUrl)) ?? (await tg("getWebhookInfo"));
    const connected = Boolean(info.url) && info.url.endsWith("/api/telegram");
    const lastErr =
      !info.reconnected && info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600 ? info.last_error_message : null;
    return {
      state: connected ? (lastErr ? "offline" : "online") : "no_webhook",
      username: me.username,
      name: me.first_name,
      webhookUrl: info.url || null,
      pending: info.pending_update_count,
      error: connected ? (lastErr ? `Telegram webhook xatosi: ${lastErr}` : null) : "Webhook ulanmagan — panelda «Webhookni ulash» tugmasini bosing.",
    };
  } catch (err) {
    if (err.code === 401 || err.code === 404) return { state: "bad_token", error: "TELEGRAM_BOT_TOKEN noto'g'ri." };
    return { state: "offline", error: err.message };
  }
}

// ---------- Long polling (lokal) ----------
export async function startPolling() {
  if (!config.telegramToken) {
    setStatus({ state: "no_token", error: ".env faylida TELEGRAM_BOT_TOKEN yo'q" });
    console.warn("[bot] TELEGRAM_BOT_TOKEN yo'q — faqat panel ishlaydi.");
    return;
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const me = await tg("getMe");
      setStatus({ username: me.username, name: me.first_name, error: null });
      console.log(`[bot] @${me.username} ulandi`);
      break;
    } catch (err) {
      if (err.code === 401 || err.code === 404) {
        setStatus({ state: "bad_token", error: "TELEGRAM_BOT_TOKEN noto'g'ri. BotFather'dan tokenni qayta nusxalang." });
        console.error("[bot] Telegram token noto'g'ri.");
        return;
      }
      setStatus({ state: "offline", error: err.message });
      await sleep(Math.min(30_000, 2000 * 2 ** attempt));
    }
  }

  // Vercel'da webhook ulangan bo'lsa, uni o'chirmaymiz (aks holda Vercel'dagi bot uziladi).
  // Kompyuterda majburan ishlatish kerak bo'lsa: .env da FORCE_POLLING=1.
  const hook = await tg("getWebhookInfo").catch(() => null);
  if (hook?.url && !config.forcePolling) {
    setStatus({
      state: "webhook_active",
      error: `Bot Vercel'da ishlayapti (${hook.url}). Webhook uzilmasligi uchun kompyuterda polling ishga tushirilmadi. Kompyuterda ishlatish kerak bo'lsa, .env ga FORCE_POLLING=1 yozing.`,
    });
    console.warn("[bot] Vercel webhook ulangan — lokal polling o'tkazib yuborildi (FORCE_POLLING=1 bilan majburlash mumkin).");
    return;
  }
  await tg("deleteWebhook").catch(() => {});
  await tg("setMyCommands", { commands: COMMANDS }).catch(() => {});

  let offset = 0;
  let failures = 0;
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, 45_000);
      if (botStatus.state !== "online") setStatus({ state: "online", error: null });
      failures = 0;
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) handleMessage(u.message).catch((err) => console.error("[bot] xabarda xato:", err.message));
      }
    } catch (err) {
      failures++;
      if (err.code === 409) {
        setStatus({ state: "conflict", error: "Bu bot boshqa joyda ham ishga tushirilgan (yoki Vercel webhook ulangan). Ikkinchi nusxani to'xtating." });
      } else if (err.code === 401) {
        setStatus({ state: "bad_token", error: "TELEGRAM_BOT_TOKEN noto'g'ri." });
        return;
      } else {
        setStatus({ state: "offline", error: err.message });
      }
      await sleep(err.retryAfter ? err.retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
}
