// Telegram bot: long polling (webhook va domen shart emas).
import { config } from "./env.js";
import * as store from "./store.js";
import { askDodie, userMessageFor, ownerHintFor } from "./ai.js";
import { toTelegramHtml, splitMessage } from "./format.js";

export const botStatus = {
  state: "starting", // starting | online | offline | no_token | bad_token | conflict
  username: null,
  name: null,
  error: null,
  lastError: null, // oxirgi AI xatosi (panel uchun)
};

function setStatus(patch) {
  Object.assign(botStatus, patch);
  store.events.emit("status", { ...botStatus });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Telegram API ----------
async function tg(method, params = {}, timeoutMs = 15_000) {
  let res;
  try {
    res = await fetch(`${config.telegramApi}/bot${config.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Tokenni logga chiqarmaslik uchun URL'siz xabar
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
      // HTML formatlash buzilgan bo'lsa — oddiy matn sifatida yuboramiz
      await tg("sendMessage", { ...params, text: chunk });
    }
  }
}

/** "yozmoqda..." ko'rsatkichini javob tayyor bo'lguncha ushlab turish. */
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

/** Foydalanuvchi xabarini saqlaydi, AI dan javob oladi, natijani saqlaydi. */
export async function generateReply(chatId, chatMeta, text, fromName) {
  store.upsertChat(chatId, chatMeta);
  const userMsg = store.addMessage(chatId, { role: "user", text, from: fromName });
  try {
    const result = await askDodie({
      persona: store.getSettings().persona,
      history: store.contextFor(chatId),
    });
    store.addMessage(chatId, { role: "assistant", text: result.text });
    store.addStats({ replies: 1, ...result.usage });
    if (botStatus.lastError) setStatus({ lastError: null });
    return { ok: true, text: result.text };
  } catch (err) {
    store.markSkipped(userMsg); // muvaffaqiyatsiz savol keyingi kontekstga kirmasin
    const hint = ownerHintFor(err);
    console.error(`[ai] ${err.kind ?? "xato"}: ${err.message}`);
    store.addMessage(chatId, { role: "note", text: hint, error: true });
    store.addStats({ errors: 1 });
    setStatus({ lastError: { hint, at: Date.now() } });
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

async function handleMessage(msg) {
  const chat = msg.chat;
  const isPrivate = chat.type === "private";
  const me = botStatus.username ?? "";
  let text = msg.text ?? "";

  // Faqat ruxsat berilgan foydalanuvchilar (ALLOWED_USER_IDS bo'sh bo'lsa — hamma)
  if (config.allowedUserIds.size && !config.allowedUserIds.has(msg.from?.id)) {
    if (isPrivate) {
      await tg("sendMessage", {
        chat_id: chat.id,
        text: `Kechirasiz, bu bot yopiq. Sizning Telegram ID: ${msg.from?.id}`,
      }).catch(() => {});
    }
    return;
  }

  // Buyruqlar: /start, /help, /reset (guruhda /reset@dodie_bot ko'rinishida ham)
  const cmd = text.match(/^\/(\w+)(?:@(\w+))?/);
  if (cmd) {
    if (cmd[2] && cmd[2].toLowerCase() !== me.toLowerCase()) return; // boshqa botga
    const name = cmd[1].toLowerCase();
    if (name === "start" || name === "help") {
      await tg("sendMessage", { chat_id: chat.id, text: HELP, parse_mode: "HTML" });
      return;
    }
    if (name === "reset" || name === "yangi") {
      store.upsertChat(chat.id, chatMetaOf(chat));
      store.resetContext(chat.id);
      await tg("sendMessage", { chat_id: chat.id, text: "🧹 Suhbat yangilandi. Qani, yangi savol bering!" });
      return;
    }
  }

  if (!text.trim()) {
    if (isPrivate && !msg.new_chat_members && !msg.left_chat_member) {
      await tg("sendMessage", { chat_id: chat.id, text: "Hozircha faqat matnli xabarlarga javob bera olaman 🙂" });
    }
    return;
  }

  // Guruhda faqat murojaat qilinganda javob beramiz: @mention, reply yoki "Dodie" so'zi
  if (!isPrivate) {
    const mentioned = me && text.toLowerCase().includes(`@${me.toLowerCase()}`);
    const repliedToMe = msg.reply_to_message?.from?.username === me;
    const calledByName = /(^|[^\p{L}])dodie([^\p{L}]|$)/iu.test(text);
    if (!mentioned && !repliedToMe && !calledByName) return;
    if (me) text = text.replace(new RegExp(`@${me}`, "ig"), "").trim() || "Salom!";
  }

  if (!store.getSettings().enabled) {
    if (isPrivate) await tg("sendMessage", { chat_id: chat.id, text: "Dodie hozir dam olyapti 😴 Keyinroq yozing." });
    return;
  }

  enqueue(String(chat.id), async () => {
    const stopTyping = keepTyping(chat.id);
    try {
      const reply = await generateReply(chat.id, chatMetaOf(chat), text, displayName(msg.from));
      await sendReply(chat.id, reply.text, isPrivate ? null : msg.message_id);
    } finally {
      stopTyping();
    }
  });
}

// ---------- Ishga tushirish ----------
export async function startBot() {
  if (!config.telegramToken) {
    setStatus({ state: "no_token", error: ".env faylida TELEGRAM_BOT_TOKEN yo'q" });
    console.warn("[bot] TELEGRAM_BOT_TOKEN yo'q — faqat panel ishlaydi.");
    return;
  }

  // getMe — token to'g'riligini tekshirish
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

  await tg("deleteWebhook").catch(() => {});
  await tg("setMyCommands", {
    commands: [
      { command: "reset", description: "Suhbatni yangidan boshlash" },
      { command: "help", description: "Yordam" },
    ],
  }).catch(() => {});

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
        setStatus({ state: "conflict", error: "Bu bot boshqa joyda ham ishga tushirilgan. Ikkinchi nusxani to'xtating." });
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
