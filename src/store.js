// Suhbatlar, sozlamalar va statistika (kv.js orqali: fayl yoki Upstash Redis).
import { EventEmitter } from "node:events";
import { config } from "./env.js";
import { kv } from "./kv.js";

const MAX_STORED = 200; // panelda ko'rsatish uchun har bir chatda saqlanadigan xabarlar

export const DEFAULT_PERSONA = `Sening isming Dodie. Sen Telegram'dagi samimiy, quvnoq va aqlli yordamchisan.
- Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob ber (ko'pincha o'zbekcha).
- Javoblaring qisqa va aniq bo'lsin; foydalanuvchi so'rasa batafsil tushuntir.
- Bilmagan narsangni to'qib chiqarma — bilmasligingni ochiq ayt.
- Kimligingni so'rashsa: "Men Dodie — sun'iy intellekt yordamchisiman" de.`;

// Faqat lokal rejimda (SSE orqali panelga jonli yuborish uchun)
export const events = new EventEmitter();
events.setMaxListeners(100);

// ---------- sozlamalar ----------
export async function getSettings() {
  return { persona: DEFAULT_PERSONA, enabled: true, ...(await kv.get("settings")) };
}

export async function updateSettings(patch) {
  const s = await getSettings();
  if (typeof patch.persona === "string") s.persona = patch.persona.trim().slice(0, 8000) || DEFAULT_PERSONA;
  if (typeof patch.enabled === "boolean") s.enabled = patch.enabled;
  await kv.set("settings", s);
  events.emit("settings", s);
  return s;
}

// ---------- statistika ----------
export async function getStats() {
  const h = await kv.hgetall("stats");
  return {
    replies: h.replies ?? 0,
    errors: h.errors ?? 0,
    promptTokens: h.promptTokens ?? 0,
    completionTokens: h.completionTokens ?? 0,
    chats: await kv.zcard("chats"),
  };
}

export async function addStats(fields) {
  await kv.incr("stats", fields);
  events.emit("stats", await getStats());
}

// ---------- suhbatlar ----------
// chat = { id, title, type, messages: [...], ctxStart, updatedAt }
// message = { role: "user"|"assistant"|"note", text, from?, at, skip?, error? }

async function loadChat(id) {
  return kv.get(`chat:${id}`);
}

async function saveChat(chat) {
  await kv.set(`chat:${chat.id}`, chat);
  await kv.zadd("chats", chat.updatedAt, chat.id);
}

/** Xabar qo'shadi (chat bo'lmasa yaratadi). Saqlangan xabarni qaytaradi. */
export async function addMessage(chatId, meta, message) {
  const id = String(chatId);
  const chat = (await loadChat(id)) ?? { id, messages: [], ctxStart: 0, updatedAt: 0 };
  if (meta?.title) chat.title = meta.title;
  if (meta?.type) chat.type = meta.type;

  const msg = { ...message, at: Date.now() };
  chat.messages.push(msg);

  // AI ga yuboriladigan kontekst HISTORY_LIMIT dan oshsa, yarmigacha qisqartiramiz.
  const limit = config.historyLimit;
  if (chat.messages.length - chat.ctxStart > limit) {
    chat.ctxStart = chat.messages.length - Math.ceil(limit / 2);
  }
  if (chat.messages.length > MAX_STORED) {
    const drop = chat.messages.length - MAX_STORED;
    chat.messages.splice(0, drop);
    chat.ctxStart = Math.max(0, chat.ctxStart - drop);
  }
  chat.updatedAt = msg.at;
  await saveChat(chat);
  events.emit("message", { chatId: id, message: msg, chat: summarize(chat) });
  return msg;
}

/** Xabarni AI kontekstidan chiqarish (masalan, xatolik bo'lganda). */
export async function markSkipped(chatId, at) {
  const chat = await loadChat(String(chatId));
  const m = chat?.messages.findLast((x) => x.at === at && x.role === "user");
  if (!m) return;
  m.skip = true;
  await saveChat(chat);
}

export async function resetContext(chatId, meta) {
  await addMessage(chatId, meta, { role: "note", text: "Suhbat yangilandi — Dodie oldingi xabarlarni unutdi" });
  const chat = await loadChat(String(chatId));
  chat.ctxStart = chat.messages.length;
  await saveChat(chat);
}

/** AI uchun xabarlar ro'yxati (OpenAI formatida). */
export async function contextFor(chatId) {
  const chat = await loadChat(String(chatId));
  if (!chat) return [];
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const out = [];
  for (const m of chat.messages.slice(chat.ctxStart)) {
    if (m.skip || m.error || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = m.role === "user" && isGroup && m.from ? `[${m.from}]: ${m.text}` : m.text;
    out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function summarize(chat) {
  const last = [...chat.messages].reverse().find((m) => m.role !== "note");
  return {
    id: chat.id,
    title: chat.title,
    type: chat.type,
    updatedAt: chat.updatedAt,
    count: chat.messages.filter((m) => m.role !== "note").length,
    last: last ? { role: last.role, text: last.text.slice(0, 120), error: !!last.error } : null,
  };
}

export async function listChats(limit = 100) {
  const ids = await kv.zrevrange("chats", limit);
  const chats = await Promise.all(ids.map(loadChat));
  return chats.filter(Boolean).map(summarize);
}

export async function getChat(chatId) {
  const chat = await loadChat(String(chatId));
  if (!chat) return null;
  return { ...summarize(chat), messages: chat.messages, ctxStart: chat.ctxStart };
}
