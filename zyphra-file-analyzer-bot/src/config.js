const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const config = {
  botToken: process.env.BOT_TOKEN || "",
  adminId: String(process.env.ADMIN_ID || "7842341917"),
  freeLimit: numberFromEnv("FREE_LIMIT", 5),
  freeMaxMb: numberFromEnv("FREE_MAX_MB", 10),
  vipMaxMb: numberFromEnv("VIP_MAX_MB", 50),
  vipLimit: numberFromEnv("VIP_LIMIT", 0),
  referralUrl:
    process.env.REFERRAL_URL ||
    "https://t.me/CatAcccountGeneratorBot?start=ref_7842341917",
  databasePath: process.env.DATABASE_PATH || "./data/bot.db",
  environment: process.env.ENVIRONMENT || "development",
  port: Number(process.env.PORT || 10000),
  webhookDomain: String(
    process.env.WEBHOOK_DOMAIN ||
      process.env.RENDER_EXTERNAL_URL ||
      "",
  .replace(/^https?:\/\//, "").replace(/\/$/, ""),
  webhookPath: process.env.WEBHOOK_PATH || "/telegram/webhook",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
};

config.freeMaxBytes = Math.floor(config.freeMaxMb * 1024 * 1024);
config.vipMaxBytes = Math.floor(config.vipMaxMb * 1024 * 1024);

function requireBotToken() {
  if (!config.botToken) {
    throw new Error(
      "BOT_TOKEN is not configured. Copy .env.example to .env and add your Telegram bot token.",
    );
  }

  return config.botToken;
}

module.exports = { config, requireBotToken };
