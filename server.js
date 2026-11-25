// Dodie — lokal ishga tushirish: npm start  ->  http://localhost:3000
// (Vercel'da esa api/index.js ishlaydi.)
import { config } from "./src/env.js"; // birinchi bo'lib .env yuklanadi
import http from "node:http";
import { handle } from "./src/app.js";
import { startPolling } from "./src/bot.js";
import { flushFile, kvKind } from "./src/kv.js";

const server = http.createServer(handle);

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
  console.log(`  AI: ${config.aiProviderLabel} · ${config.aiModel}${config.aiKey ? "" : "  (AI_API_KEY yo'q!)"}`);
  console.log(`  Saqlash: ${kvKind === "redis" ? "Upstash Redis" : "data/state.json"}\n`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.panelPassword) {
    console.warn("  ⚠  Panel tashqaridan ochiq, lekin PANEL_PASSWORD o'rnatilmagan!\n");
  }
});

startPolling();

function shutdown() {
  flushFile();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
