// .env faylini o'qiydi va sozlamalarni bitta joyga yig'adi.
// Bu modul boshqa modullardan OLDIN import qilinishi kerak.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  console.warn("[env] .env fayli topilmadi — .env.example dan nusxa olib, kalitlarni yozing.");
}

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;

// Bepul kalit beradigan provayderlar (hammasi OpenAI-formatidagi API).
export const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    keyUrl: "https://openrouter.ai/keys",
  },
};

const providerName = env("AI_PROVIDER", "gemini").toLowerCase();
const provider = PROVIDERS[providerName] ?? PROVIDERS.gemini;
if (!PROVIDERS[providerName]) {
  console.warn(`[env] AI_PROVIDER="${providerName}" noma'lum — gemini ishlatiladi.`);
}

export const config = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  telegramApi: env("TELEGRAM_API_URL", "https://api.telegram.org").replace(/\/+$/, ""),

  aiProvider: PROVIDERS[providerName] ? providerName : "gemini",
  aiProviderLabel: provider.label,
  aiKey: env("AI_API_KEY"),
  aiKeyUrl: provider.keyUrl,
  aiModel: env("AI_MODEL", provider.model),
  aiBaseUrl: env("AI_BASE_URL", provider.baseUrl).replace(/\/+$/, ""),

  port: Number(env("PORT", "3000")) || 3000,
  host: env("HOST", "127.0.0.1"),
  panelPassword: env("PANEL_PASSWORD"),

  allowedUserIds: new Set(
    env("ALLOWED_USER_IDS")
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite),
  ),
  historyLimit: Math.max(4, Number(env("HISTORY_LIMIT", "30")) || 30),
};
