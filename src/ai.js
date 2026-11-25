// AI bilan gaplashish: OpenAI-formatidagi /chat/completions (Gemini, Groq, OpenRouter).
import { config } from "./env.js";

const FORMAT_RULES = `Javoblaring Telegram chatida ko'rsatiladi. Oddiy Markdown ishlat: **qalin**, _kursiv_, \`kod\`, \`\`\`kod bloki\`\`\`, ro'yxat uchun "- ". Jadval va # sarlavhalar ishlatma.
Guruh chatlarida xabarlar "[Ism]: matn" ko'rinishida keladi — javobingda bu formatni takrorlama.`;

function todayLine() {
  const date = new Intl.DateTimeFormat("uz-UZ", {
    timeZone: "Asia/Tashkent",
    dateStyle: "full",
  }).format(new Date());
  return `Bugungi sana (Toshkent vaqti): ${date}.`;
}

export class AiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // "no_key" | "auth" | "rate" | "model" | "bad_request" | "server" | "network" | "empty"
    this.status = status;
  }
}

/** Foydalanuvchiga ko'rsatiladigan qisqa xabar. */
export function userMessageFor(err) {
  switch (err?.kind) {
    case "rate":
      return "Hozir juda ko'p so'rov bo'ldi 😅 Bir daqiqadan keyin qayta yozib ko'ring.";
    case "empty":
      return "Bu savolga javob bera olmadim. Boshqacharoq so'rab ko'ring.";
    case "network":
    case "server":
      return "AI xizmatiga ulanib bo'lmadi. Birozdan keyin qayta urinib ko'ring.";
    default:
      return "Kechirasiz, hozir javob bera olmayapman. Bot egasi sozlamalarni tekshirishi kerak.";
  }
}

/** Panel uchun egaga tushunarli izoh. */
export function ownerHintFor(err) {
  switch (err?.kind) {
    case "no_key":
      return `.env faylida AI_API_KEY yo'q. Bepul kalit: ${config.aiKeyUrl}`;
    case "auth":
      return `AI_API_KEY noto'g'ri yoki bloklangan (${config.aiProviderLabel}). Yangi kalit: ${config.aiKeyUrl}`;
    case "rate":
      return "Bepul limit tugadi yoki daqiqalik limitdan oshildi. Biroz kuting yoki boshqa provayderni sinang.";
    case "model":
      return `"${config.aiModel}" modeli topilmadi. .env da AI_MODEL ni o'zgartiring.`;
    default:
      return err?.message ?? String(err);
  }
}

/**
 * @param {{ persona: string, history: {role:string, content:string}[] }} p
 * @returns {Promise<{ text: string, usage: {promptTokens:number, completionTokens:number}, model: string }>}
 */
export async function askDodie({ persona, history }) {
  if (!config.aiKey) throw new AiError("no_key", "AI_API_KEY berilmagan");

  const body = {
    model: config.aiModel,
    messages: [{ role: "system", content: `${persona}\n\n${FORMAT_RULES}\n${todayLine()}` }, ...history],
    max_tokens: 8192,
    temperature: 0.7,
  };
  // Gemini "o'ylaydigan" model: chat uchun o'ylashni kamaytiramiz — tezroq va limit tejaladi.
  if (config.aiProvider === "gemini") body.reasoning_effort = "low";

  let res;
  try {
    res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.aiKey}`,
        "x-title": "Dodie Telegram bot", // OpenRouter uchun ixtiyoriy
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new AiError("network", `Tarmoq xatosi: ${err.cause?.code ?? err.message}`);
  }

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* JSON emas */
  }
  // Gemini xatoni ba'zan massiv ichida qaytaradi: [{ error: {...} }]
  const apiError = (Array.isArray(data) ? data[0]?.error : data?.error) ?? null;

  if (!res.ok) {
    const msg = apiError?.message ?? raw.slice(0, 300) ?? `HTTP ${res.status}`;
    const s = res.status;
    if (s === 401 || s === 403) throw new AiError("auth", msg, s);
    if (s === 429) throw new AiError("rate", msg, s);
    if (s === 404) throw new AiError("model", msg, s);
    if (s === 400 && /api[_ ]?key/i.test(msg)) throw new AiError("auth", msg, s);
    if (s >= 500) throw new AiError("server", msg, s);
    throw new AiError("bad_request", msg, s);
  }

  const choice = data?.choices?.[0];
  let text = choice?.message?.content;
  if (Array.isArray(text)) text = text.map((p) => p.text ?? "").join("");
  text = (text ?? "").trim();
  if (!text) throw new AiError("empty", `Bo'sh javob (finish_reason: ${choice?.finish_reason ?? "?"})`);
  if (choice?.finish_reason === "length") text += "…";

  return {
    text,
    model: data.model ?? config.aiModel,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
