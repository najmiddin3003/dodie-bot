// Suhbatlar, sozlamalar va statistikani saqlash (data/state.json).
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ROOT, config } from "./env.js";

const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const MAX_STORED = 200; // panelda ko'rsatish uchun har bir chatda saqlanadigan xabarlar

export const DEFAULT_PERSONA = `Sening isming Dodie. Sen Telegram'dagi samimiy, quvnoq va aqlli yordamchisan.
- Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob ber (ko'pincha o'zbekcha).
- Javoblaring qisqa va aniq bo'lsin; foydalanuvchi so'rasa batafsil tushuntir.
- Bilmagan narsangni to'qib chiqarma — bilmasligingni ochiq ayt.
- Kimligingni so'rashsa: "Men Dodie — sun'iy intellekt yordamchisiman" de.`;

export const events = new EventEmitter();
events.setMaxListeners(100);

const state = load();

function load() {
  const empty = {
    settings: { persona: DEFAULT_PERSONA, enabled: true },
    stats: { replies: 0, errors: 0, promptTokens: 0, completionTokens: 0 },
    chats: {},
  };
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      settings: { ...empty.settings, ...saved.settings },
      stats: { ...empty.stats, ...saved.stats },
      chats: saved.chats ?? {},
    };
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[store] state.json o'qilmadi, yangidan boshlanadi:", err.message);
    return empty;
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1000);
}

export function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    try {
      fs.renameSync(tmp, STATE_FILE);
    } catch {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    }
  } catch (err) {
    console.error("[store] saqlashda xato:", err.message);
  }
}

// ---------- sozlamalar ----------
export function getSettings() {
  return { ...state.settings };
}

export function updateSettings(patch) {
  if (typeof patch.persona === "string") {
    state.settings.persona = patch.persona.trim().slice(0, 8000) || DEFAULT_PERSONA;
  }
  if (typeof patch.enabled === "boolean") state.settings.enabled = patch.enabled;
  scheduleSave();
  events.emit("settings", getSettings());
  return getSettings();
}

// ---------- statistika ----------
export function getStats() {
  return { ...state.stats, chats: Object.keys(state.chats).length };
}

export function addStats({ replies = 0, errors = 0, promptTokens = 0, completionTokens = 0 }) {
  const s = state.stats;
  s.replies += replies;
  s.errors += errors;
  s.promptTokens += promptTokens;
  s.completionTokens += completionTokens;
  scheduleSave();
  events.emit("stats", getStats());
}

// ---------- suhbatlar ----------
// chat = { id, title, type, messages: [...], ctxStart, updatedAt }
// message = { role: "user"|"assistant"|"note", text, from?, at, skip?, error? }

export function upsertChat(id, { title, type }) {
  const key = String(id);
  let chat = state.chats[key];
  if (!chat) {
    chat = state.chats[key] = { id: key, title, type, messages: [], ctxStart: 0, updatedAt: Date.now() };
  } else {
    if (title) chat.title = title;
    if (type) chat.type = type;
  }
  return chat;
}

export function addMessage(chatId, message) {
  const chat = state.chats[String(chatId)];
  const msg = { ...message, at: Date.now() };
  chat.messages.push(msg);

  // AI ga yuboriladigan kontekst HISTORY_LIMIT dan oshsa, yarmigacha qisqartiramiz
  // (bo'lib-bo'lib qisqartirish — har xabarda emas).
  const limit = config.historyLimit;
  if (chat.messages.length - chat.ctxStart > limit) {
    chat.ctxStart = chat.messages.length - Math.ceil(limit / 2);
  }
  // Panel uchun saqlanadigan xabarlar sonini cheklash
  if (chat.messages.length > MAX_STORED) {
    const drop = chat.messages.length - MAX_STORED;
    chat.messages.splice(0, drop);
    chat.ctxStart = Math.max(0, chat.ctxStart - drop);
  }
  chat.updatedAt = msg.at;
  scheduleSave();
  events.emit("message", { chatId: chat.id, message: msg, chat: summarize(chat) });
  return msg;
}

/** Xabarni AI kontekstidan chiqarib tashlash (masalan, xatolik bo'lganda). */
export function markSkipped(msg) {
  msg.skip = true;
  scheduleSave();
}

export function resetContext(chatId) {
  const chat = state.chats[String(chatId)];
  if (!chat) return;
  addMessage(chatId, { role: "note", text: "Suhbat yangilandi — Dodie oldingi xabarlarni unutdi" });
  chat.ctxStart = chat.messages.length;
  scheduleSave();
}

/** AI uchun xabarlar ro'yxati (OpenAI formatida). */
export function contextFor(chatId) {
  const chat = state.chats[String(chatId)];
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

export function listChats() {
  return Object.values(state.chats)
    .map(summarize)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getChat(chatId) {
  const chat = state.chats[String(chatId)];
  if (!chat) return null;
  return { ...summarize(chat), messages: chat.messages, ctxStart: chat.ctxStart };
}
