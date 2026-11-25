# Dodie — AI Telegram bot

Telegram botga yozilgan xabarlarga sun'iy intellekt (bepul Gemini kaliti) javob beradi.
Boshqaruv uchun HTML panel bor: holat, Dodie xarakteri, jonli suhbatlar va sinov chati.

Tashqi paket kerak emas — faqat Node.js 20.12+ (`npm install` shart emas).

## Ishga tushirish

1. **Bepul AI kalit oling:** https://aistudio.google.com/apikey → *Create API key*.
2. **`.env` faylini to'ldiring:**
   ```
   TELEGRAM_BOT_TOKEN=123456789:AAH...   # BotFather bergan token
   AI_API_KEY=AIza...                     # Gemini kaliti
   ```
3. **Ishga tushiring:**
   ```
   npm start
   ```
4. Brauzerda oching: **http://localhost:3000**
5. Telegram'da botingizga yozing — Dodie javob beradi, suhbat panelda jonli ko'rinadi.

## Bot buyruqlari
- `/start`, `/help` — salomlashish va yordam
- `/reset` — suhbatni yangidan boshlash (Dodie oldingi xabarlarni unutadi)

## Guruhda
Dodie guruhda faqat unga murojaat qilinganda javob beradi: `@bot_username`, uning xabariga *reply*
yoki matnda "Dodie" so'zi bo'lsa. Oddiy xabarlarni ham ko'rishi uchun BotFather'da
`/setprivacy` → *Disable* qiling.

## Boshqa bepul provayderlar
`.env` da:
| AI_PROVIDER | Kalit olish | Standart model |
|---|---|---|
| `gemini` (standart) | https://aistudio.google.com/apikey | `gemini-2.5-flash` |
| `groq` | https://console.groq.com/keys | `llama-3.3-70b-versatile` |
| `openrouter` | https://openrouter.ai/keys | `meta-llama/llama-3.3-70b-instruct:free` |

Model topilmasa (404), `AI_MODEL=` ga provayder saytidagi aniq nomni yozing.

## Foydali sozlamalar
- `ALLOWED_USER_IDS=111,222` — faqat shu odamlar ishlata oladi (ID ni bilish uchun: shu sozlama
  yoqilganda botga yozing — bot ID'ingizni aytadi).
- `HISTORY_LIMIT=30` — AI eslab qoladigan oxirgi xabarlar soni.
- Serverga (VPS) qo'yganda: `HOST=0.0.0.0` va albatta `PANEL_PASSWORD=...` qo'ying.

Suhbatlar va sozlamalar `data/state.json` da saqlanadi. `.env` va `data/` git'ga tushmaydi.
