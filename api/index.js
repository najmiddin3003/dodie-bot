// Vercel serverless funksiyasi: barcha so'rovlar shu yerga keladi (vercel.json -> rewrites).
import "../src/env.js";
import { handle } from "../src/app.js";

export const config = { api: { bodyParser: false } };

export default function handler(req, res) {
  return handle(req, res);
}
