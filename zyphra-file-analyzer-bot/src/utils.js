const fs = require("node:fs/promises");
const path = require("node:path");
const { Markup } = require("telegraf");

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || "upload.txt"));
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return safe || "upload.txt";
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function formatUser(user) {
  if (!user) {
    return "User not found.";
  }

  const name = user.first_name || user.username || "Unnamed user";
  return [
    `👤 ${name}`,
    `🆔 ${user.telegram_id}`,
    `🔗 Username: ${user.username ? `@${user.username}` : "not set"}`,
    `⭐ Premium: ${user.is_premium ? "Yes" : "No"}`,
    `🚫 Banned: ${user.is_banned ? "Yes" : "No"}`,
    `📊 Checks today: ${user.checks_today}`,
    `📅 Joined: ${user.created_at}`,
  ].join("\n");
}

function formatUserStats(stats, config) {
  const plan = stats.isPremium ? "⭐ PREMIUM" : "FREE";
  const dailyLimit = stats.isPremium
    ? config.vipLimit === 0
      ? "Unlimited"
      : config.vipLimit
    : config.freeLimit;

  return [
    "📊 MY STATS",
    "",
    `📁 Total checks: ${stats.total_checks}`,
    `📦 Total records processed: ${stats.total_records}`,
    `🟢 VALID: ${stats.valid_count}`,
    `🔴 INVALID: ${stats.invalid_count}`,
    `⚪ UNKNOWN: ${stats.unknown_count}`,
    `🧹 Duplicates removed: ${stats.duplicates_removed}`,
    "",
    `💳 Current plan: ${plan}`,
    `⏱ Today's usage: ${stats.checksToday}/${dailyLimit}`,
    `♾️ Lifetime usage: ${stats.total_records}`,
  ].join("\n");
}

function formatGlobalStats(stats) {
  return [
    "📊 ZYPHRA STATISTICS",
    "",
    `👥 Users: ${stats.users}`,
    `⭐ Premium users: ${stats.premium_users}`,
    `🚫 Banned users: ${stats.banned_users}`,
    `📁 Total checks: ${stats.total_checks}`,
    `📦 Total records: ${stats.total_records}`,
    `🟢 VALID: ${stats.valid_count}`,
    `🔴 INVALID: ${stats.invalid_count}`,
    `⚪ UNKNOWN: ${stats.unknown_count}`,
    `🧹 Duplicates removed: ${stats.duplicates_removed}`,
    `⚙️ Maintenance: ${stats.maintenance ? "ON" : "OFF"}`,
  ].join("\n");
}

function mainKeyboard() {
  return Markup.keyboard([
    ["📄 CHECK TXT", "⭐ PREMIUM"],
    ["🧰 TOOLS", "📊 MY STATS"],
    ["🎁 REFERRAL", "❓ HELP"],
  ]).resize();
}

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👥 USERS", "admin:users")],
    [Markup.button.callback("⭐ PREMIUM", "admin:premium")],
    [Markup.button.callback("📊 STATISTICS", "admin:statistics")],
    [Markup.button.callback("🚫 BANNED", "admin:banned")],
    [Markup.button.callback("⚙️ MAINTENANCE", "admin:maintenance")],
    [Markup.button.callback("📢 BROADCAST", "admin:broadcast")],
  ]);
}

async function createResultFiles(analysis, resultsRoot) {
  await fs.mkdir(resultsRoot, { recursive: true });
  const resultDirectory = await fs.mkdtemp(path.join(resultsRoot, "check-"));
  const definitions = [
    ["valid.txt", "VALID", analysis.valid],
    ["invalid.txt", "INVALID", analysis.invalid],
    ["unknown.txt", "UNKNOWN", analysis.unknown],
  ];
  const files = [];

  for (const [filename, label, records] of definitions) {
    const content =
      records.length > 0
        ? `${records.join("\n\n")}\n`
        : `No ${label} records found.\n`;
    const filePath = path.join(resultDirectory, filename);
    await fs.writeFile(filePath, content, "utf8");
    files.push({ path: filePath, filename });
  }

  return { directory: resultDirectory, files };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseUserId(value) {
  const userId = String(value || "").trim();
  return /^\d{1,30}$/.test(userId) ? userId : null;
}

module.exports = {
  sanitizeFilename,
  formatSeconds,
  formatUser,
  formatUserStats,
  formatGlobalStats,
  mainKeyboard,
  adminKeyboard,
  createResultFiles,
  sleep,
  parseUserId,
};