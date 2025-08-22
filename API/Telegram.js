import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import OpenAI from "openai";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN missing");
if (!OPENAI_API_KEY) console.warn("OPENAI_API_KEY missing (wird für Bildanalyse benötigt)");

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Format: minimalistisch + Bewertung ---
function formatResult({ kcal, protein_g, carbs_g, fat_g, rating }) {
  return `${Math.round(kcal)} kcal | P${Math.round(protein_g)} / C${Math.round(carbs_g)} / F${Math.round(fat_g)} | Bewertung: ${rating}`;
}

async function analyzeImageUrl(imageUrl) {
  // Systeminstruktion: NUR JSON zurückgeben
  const system = [
    "Du bist 'CleanEat', ein strenger, nüchterner Ernährungsanalyst.",
    "Gib ausschließlich JSON im Format:",
    "{ \"kcal\": number, \"protein_g\": number, \"carbs_g\": number, \"fat_g\": number, \"rating\": \"Passt\"|\"Grenzwertig\"|\"Vermeiden\" }",
    "Bewerte für typisches Defizit + hohen Protein-Fokus. Keine Freitexterklärungen."
  ].join(" ");

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: "Erkenne Lebensmittel, schätze Portionen, gib kcal & Makros + Bewertung minimalistisch." },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() ?? "{}";
  let data = {};
  try { data = JSON.parse(raw); } catch { data = {}; }
  const { kcal = 0, protein_g = 0, carbs_g = 0, fat_g = 0, rating = "Grenzwertig" } = data;
  return { kcal, protein_g, carbs_g, fat_g, rating };
}

// /start
bot.start((ctx) =>
  ctx.reply('Sende ein Foto deiner Mahlzeit. Antwort-Format: "kcal | P/C/F | Bewertung".')
);

// Foto-Handler
bot.on("photo", async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    const file = await ctx.telegram.getFile(best.file_id);
    const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    if (!OPENAI_API_KEY) {
      await ctx.reply("OPENAI_API_KEY fehlt. Bitte zuerst Env-Variable setzen.");
      return;
    }

    const result = await analyzeImageUrl(imageUrl);
    await ctx.reply(formatResult(result));
  } catch (e) {
    console.error("photo error:", e);
    await ctx.reply("Fehler bei der Analyse. Bitte ein klares Foto senden.");
  }
});

// Healthcheck
bot.command("ping", (ctx) => ctx.reply("pong"));

// --- Vercel Serverless Handler (Webhook-Einstieg) ---
export default async function handler(req, res) {
  if (req.method === "GET") {
    // Webhook bequem setzen: GET ?setWebhook=1
    if (req.query.setWebhook) {
      const host =
        req.headers["x-forwarded-host"] ||
        req.headers.host;
      const base = `https://${host}`;
      const webhookUrl = `${base}/api/telegram`;
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
      const r = await fetch(url).then(r => r.json());
      return res.status(200).json(r);
    }
    return res.status(200).send("OK");
  }

  if (req.method === "POST") {
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).end();
    } catch (e) {
      console.error("handleUpdate error:", e);
      return res.status(200).end();
    }
  }

  return res.status(200).send("OK");
}
