const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { Markup } = require("telegraf");
const {
  analyzeFile,
} = require("./parser");
const {
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
} = require("./utils");
const logger = require("./logger");
const { config } = require("./config");

const awaitingFile = new Set();
const requestTimes = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

function telegramId(ctx) {
  return String(ctx.from.id);
}

function isAdmin(ctx) {
  return telegramId(ctx) === config.adminId;
}

function startText(ctx) {
  const username = ctx.from.first_name || ctx.from.username || "there";
  return [
    "✨ ZYPHRA FILE ANALYZER",
    "",
    `Welcome, ${username}! 👋`,
    "",
    "🎮 Analyze TXT files",
    "🔎 Detect CODM / MLBB from file text",
    "🟢 Separate VALID records",
    "🔴 Separate INVALID records",
    "⚪ Separate UNKNOWN records",
    "🧹 Remove duplicates",
    "📊 View statistics",
    "",
    "⭐ PREMIUM",
    "⚡ Faster processing",
    "📦 Larger files",
    "♾️ Unlimited checks",
    "🧰 Premium tools",
  ].join("\n");
}

function maintenanceText() {
  return [
    "🔧 MAINTENANCE MODE",
    "",
    "The analyzer is temporarily unavailable.",
    "Please try again later.",
  ].join("\n");
}

function tooLargeText(isPremium) {
  const maxMb = isPremium ? config.vipMaxMb : config.freeMaxMb;
  return [
    "❌ FILE TOO LARGE",
    "",
    `Your plan allows files up to ${maxMb} MB.`,
    isPremium ? "" : "⭐ Premium users can upload larger files.",
  ]
    .filter(Boolean)
    .join("\n");
}

function limitText(result) {
  return [
    "⛔ DAILY LIMIT REACHED",
    "",
    `You have used all ${result.limit} free checks today.`,
    "⭐ Upgrade to Premium for unlimited checks.",
    "Your limit resets at UTC midnight.",
  ].join("\n");
}

function userAllowed(ctx, db) {
  const user = db.getUser(db.db, telegramId(ctx));
  if (user?.is_banned) {
    return false;
  }

  if (db.getSetting(db.db, "maintenance") === "1" && !isAdmin(ctx)) {
    return false;
  }

  return true;
}

async function safeEdit(ctx, messageId, text) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text);
  } catch (error) {
    // Telegram can reject an edit when the message is unchanged or too old.
    logger.warn("Could not update progress message", { reason: error.message });
  }
}

async function downloadDocument(ctx, fileId, destination, maxBytes) {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link.toString());
  if (!response.ok) {
    throw new Error(`Telegram download returned HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    const error = new Error("FILE_TOO_LARGE");
    error.code = "FILE_TOO_LARGE";
    throw error;
  }

  await fs.writeFile(destination, buffer);
}

async function readUtf8File(filePath) {
  const buffer = await fs.readFile(filePath);
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function summaryText(analysis, processingTime) {
  return [
    "╔════════════════════════╗",
    "       ✦ ZYPHRA RESULT ✦",
    "╚════════════════════════╝",
    "",
    `🎮 GAME: ${analysis.game}`,
    `📦 TOTAL: ${analysis.total}`,
    `🟢 VALID: ${analysis.validCount}`,
    `🔴 INVALID: ${analysis.invalidCount}`,
    `⚪ UNKNOWN: ${analysis.unknownCount}`,
    "",
    `🧹 DUPLICATES REMOVED: ${analysis.duplicatesRemoved}`,
    `⚡ PROCESSING TIME: ${formatSeconds(processingTime)}`,
    "",
    "Only status text already present in the TXT was used.",
  ].join("\n");
}

function registerHandlers(bot, database) {
  const db = database;

  // Keep the in-memory limiter intentionally small; SQLite remains the source
  // of truth for persistent usage limits.
  bot.use(async (ctx, next) => {
    if (!ctx.from) {
      return next();
    }

    const id = telegramId(ctx);
    const now = Date.now();
    const recent = (requestTimes.get(id) || []).filter(
      (timestamp) => now - timestamp < RATE_WINDOW_MS,
    );

    if (recent.length >= RATE_LIMIT && !isAdmin(ctx)) {
      await ctx.reply("⏱ Too many requests. Please wait a moment and try again.");
      return;
    }

    recent.push(now);
    requestTimes.set(id, recent);
    return next();
  });

  bot.start(async (ctx) => {
    const payload = ctx.message.text.split(/\s+/).slice(1).join(" ");
    db.upsertUser(db.db, ctx.from, payload.startsWith("ref_") ? payload : null);
    awaitingFile.delete(telegramId(ctx));

    if (!userAllowed(ctx, db)) {
      await ctx.reply(db.isBanned(db.db, telegramId(ctx)) ? "🚫 You are banned." : maintenanceText());
      return;
    }

    await ctx.reply(startText(ctx), mainKeyboard());
  });

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ Admin access only.");
    }
    db.upsertUser(db.db, ctx.from);
    await ctx.reply("👑 ZYPHRA ADMIN PANEL", adminKeyboard());
  });

  bot.command("users", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    const users = db.listUsers(db.db);
    const lines = users.slice(0, 50).map(
      (user) =>
        `${user.is_premium ? "⭐" : "👤"} ${user.telegram_id} — ${user.username ? `@${user.username}` : user.first_name || "unnamed"}`,
    );
    await ctx.reply(
      `👥 USERS (${users.length})\n\n${lines.join("\n") || "No users yet."}${users.length > 50 ? "\n\nShowing first 50." : ""}`,
    );
  });

  bot.command("userinfo", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    const user = db.getUser(db.db, parseUserId(ctx.message.text.split(/\s+/)[1]));
    await ctx.reply(formatUser(user));
  });

  bot.command("premium_add", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    const userId = parseUserId(ctx.message.text.split(/\s+/)[1]);
    const user = userId && db.setPremium(db.db, userId, true);
    await ctx.reply(user ? `⭐ Premium added.\n\n${formatUser(user)}` : "Usage: /premium_add USER_ID");
  });

  bot.command("premium_remove", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    const userId = parseUserId(ctx.message.text.split(/\s+/)[1]);
    const user = userId && db.setPremium(db.db, userId, false);
    await ctx.reply(user ? `⭐ Premium removed.\n\n${formatUser(user)}` : "Usage: /premium_remove USER_ID");
  });

  bot.command("ban", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    const userId = parseUserId(ctx.message.text.split(/\s+/)[1]);
    const user = userId && db.setBanned(db.db, userId, true);
    await ctx.reply(user ? `🚫 User banned.\n\n${formatUser(user)}` : "Usage: /ban USER_ID");
  });

  bot.command("unban", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    const userId = parseUserId(ctx.message.text.split(/\s+/)[1]);
    const user = userId && db.setBanned(db.db, userId, false);
    await ctx.reply(user ? `✅ User unbanned.\n\n${formatUser(user)}` : "Usage: /unban USER_ID");
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    await ctx.reply(formatGlobalStats(db.getGlobalStats(db.db)));
  });

  bot.command("maintenance_on", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    db.setSetting(db.db, "maintenance", "1");
    await ctx.reply("🔧 Maintenance mode is ON.");
  });

  bot.command("maintenance_off", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    db.setSetting(db.db, "maintenance", "0");
    await ctx.reply("✅ Maintenance mode is OFF.");
  });

  bot.command("broadcast", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Admin access only.");
    const message = ctx.message.text.replace(/^\/broadcast(?:@\w+)?\s*/i, "").trim();
    if (!message) return ctx.reply("Usage: /broadcast MESSAGE");
    return broadcast(ctx, db, message);
  });

  bot.hears("📄 CHECK TXT", async (ctx) => {
    if (!userAllowed(ctx, db)) {
      return ctx.reply(db.isBanned(db.db, telegramId(ctx)) ? "🚫 You are banned." : maintenanceText());
    }
    db.upsertUser(db.db, ctx.from);
    awaitingFile.add(telegramId(ctx));
    await ctx.reply(
      "📄 ZYPHRA TXT ANALYZER\n\nSend your .txt file as a Telegram document.",
      mainKeyboard(),
    );
  });

  bot.hears("📊 MY STATS", async (ctx) => {
    if (!userAllowed(ctx, db)) return ctx.reply(maintenanceText());
    db.upsertUser(db.db, ctx.from);
    await ctx.reply(formatUserStats(db.getUserStats(db.db, telegramId(ctx)), config), mainKeyboard());
  });

  bot.hears("⭐ PREMIUM", async (ctx) => {
    if (!userAllowed(ctx, db)) return ctx.reply(maintenanceText());
    await ctx.reply(
      [
        "⭐ PREMIUM",
        "",
        "⚡ Faster processing",
        "📦 Larger files",
        "♾️ Unlimited checks",
        "🧰 Premium tools",
        "📊 Advanced statistics",
        "",
        "Premium access is granted manually by the admin.",
      ].join("\n"),
      Markup.inlineKeyboard([Markup.button.url("🎁 OPEN REFERRAL", config.referralUrl)]),
    );
  });

  bot.hears("🎁 REFERRAL", async (ctx) => {
    if (!userAllowed(ctx, db)) return ctx.reply(maintenanceText());
    await ctx.reply(
      [
        "🎁 PREMIUM REFERRAL",
        "",
        "Get Premium access through the referral:",
      ].join("\n"),
      Markup.inlineKeyboard([Markup.button.url("OPEN REFERRAL", config.referralUrl)]),
    );
  });

  bot.hears("🧰 TOOLS", async (ctx) => {
    if (!userAllowed(ctx, db)) return ctx.reply(maintenanceText());
    await ctx.reply(
      [
        "🧰 TOOLS",
        "",
        "🔍 TXT analyzer — classify status text already in a file",
        "🧹 Duplicate remover — remove repeated records",
        "📊 File statistics — counts and processing time",
        "🎮 Game detector — CODM / MLBB indicators",
        "📄 TXT formatter — results are returned as simple TXT files",
        "",
        "No login, credential testing, or external game-server checks are used.",
      ].join("\n"),
      mainKeyboard(),
    );
  });

  bot.hears("❓ HELP", async (ctx) => {
    await ctx.reply(
      [
        "❓ HELP",
        "",
        "1. Press 📄 CHECK TXT.",
        "2. Send a .txt document.",
        "3. Wait for the safe local analysis.",
        "4. Download the VALID, INVALID, and UNKNOWN result files.",
        "",
        "Classification uses only status words already inside the TXT. An email, username, UID, or password is never treated as proof that an account works.",
      ].join("\n"),
      mainKeyboard(),
    );
  });

  bot.action(/^admin:(users|premium|statistics|banned|maintenance|broadcast)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Admin access only.");
      return;
    }
    await ctx.answerCbQuery();
    const action = ctx.match[1];

    if (action === "users") {
      const users = db.listUsers(db.db);
      await ctx.reply(`👥 Users: ${users.length}\n\nUse /users for the list.`);
    } else if (action === "premium") {
      const users = db.listUsers(db.db, "premium");
      await ctx.reply(`⭐ Premium users: ${users.length}`);
    } else if (action === "statistics") {
      await ctx.reply(formatGlobalStats(db.getGlobalStats(db.db)));
    } else if (action === "banned") {
      const users = db.listUsers(db.db, "banned");
      await ctx.reply(`🚫 Banned users: ${users.length}`);
    } else if (action === "maintenance") {
      const enabled = db.getSetting(db.db, "maintenance") === "1";
      await ctx.reply(`⚙️ Maintenance is currently ${enabled ? "ON" : "OFF"}.\n\nUse /maintenance_on or /maintenance_off.`);
    } else if (action === "broadcast") {
      await ctx.reply("Use /broadcast MESSAGE to send an announcement.");
    }
  });

  bot.on("document", async (ctx) => {
    await handleDocument(ctx, db);
  });
}

async function handleDocument(ctx, db) {
  const id = telegramId(ctx);
  const user = db.upsertUser(db.db, ctx.from);
  if (!userAllowed(ctx, db)) {
    await ctx.reply(user.is_banned ? "🚫 You are banned." : maintenanceText());
    return;
  }

  const document = ctx.message.document;
  const filename = sanitizeFilename(document.file_name || "upload.txt");
  if (path.extname(filename).toLowerCase() !== ".txt") {
    await ctx.reply("❌ INVALID FILE\n\nOnly .txt documents are accepted.");
    return;
  }

  const isUserPremium = Boolean(user.is_premium);
  const maxBytes = isUserPremium ? config.vipMaxBytes : config.freeMaxBytes;
  if (document.file_size && document.file_size > maxBytes) {
    await ctx.reply(tooLargeText(isUserPremium));
    return;
  }

  const limit = db.checkUserLimit(db.db, id, config);
  if (!limit.allowed) {
    await ctx.reply(limit.reason === "banned" ? "🚫 You are banned." : limitText(limit));
    return;
  }

  awaitingFile.delete(id);
  const progress = await ctx.reply("⏳ Preparing analyzer...");
  const temporaryPath = path.join(os.tmpdir(), `zyphra-${id}-${Date.now()}.txt`);
  let resultDirectory;

  try {
    await safeEdit(ctx, progress.message_id, "🔎 Reading file...");
    await downloadDocument(ctx, document.file_id, temporaryPath, maxBytes);
    const text = await readUtf8File(temporaryPath);
    if (!text.trim()) {
      await safeEdit(ctx, progress.message_id, "❌ EMPTY FILE\n\nPlease send a TXT file with content.");
      return;
    }

    await safeEdit(ctx, progress.message_id, "🎮 Detecting game...");
    const startedAt = Date.now();
    const analysis = analyzeFile(text);
    await safeEdit(ctx, progress.message_id, "🧹 Removing duplicates...");
    await safeEdit(ctx, progress.message_id, "📊 Generating results...");
    const processingTime = Date.now() - startedAt;

    const result = await createResultFiles(analysis, path.resolve("results"));
    resultDirectory = result.directory;
    db.incrementCheckUsage(db.db, id);
    db.recordCheck(db.db, id, {
      filename,
      game: analysis.game,
      total: analysis.total,
      validCount: analysis.validCount,
      invalidCount: analysis.invalidCount,
      unknownCount: analysis.unknownCount,
      duplicatesRemoved: analysis.duplicatesRemoved,
      processingTime: processingTime / 1000,
    });

    logger.check({
      userId: id,
      filename,
      game: analysis.game,
      total: analysis.total,
      valid: analysis.validCount,
      invalid: analysis.invalidCount,
      unknown: analysis.unknownCount,
      duplicatesRemoved: analysis.duplicatesRemoved,
      processingTime: formatSeconds(processingTime),
    });

    await safeEdit(ctx, progress.message_id, "✅ Complete!");
    await ctx.reply(summaryText(analysis, processingTime), mainKeyboard());
    for (const file of result.files) {
      await ctx.replyWithDocument({ source: file.path, filename: file.filename });
    }
  } catch (error) {
    logger.error("File analysis failed", { code: error.code, reason: error.message });
    const message =
      error.code === "FILE_TOO_LARGE"
        ? tooLargeText(isUserPremium)
        : error instanceof TypeError && error.message.includes("decode")
          ? "❌ ENCODING ERROR\n\nPlease send a UTF-8 TXT file."
          : "❌ ANALYSIS ERROR\n\nThe file could not be processed. Please try again.";
    await safeEdit(ctx, progress.message_id, message);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (resultDirectory) {
      await fs.rm(resultDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function broadcast(ctx, db, message) {
  const ids = db.allUserIds(db.db);
  const progress = await ctx.reply(`📢 Broadcasting...\n\nSent: 0\nFailed: 0\nTotal: ${ids.length}`);
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < ids.length; index += 1) {
    try {
      await ctx.telegram.sendMessage(ids[index], message);
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.warn("Broadcast delivery failed", { userId: ids[index], reason: error.message });
    }

    if ((index + 1) % 10 === 0 || index === ids.length - 1) {
      await safeEdit(
        ctx,
        progress.message_id,
        `📢 Broadcasting...\n\nSent: ${sent}\nFailed: ${failed}\nTotal: ${ids.length}`,
      );
    }
    await sleep(50);
  }

  await safeEdit(
    ctx,
    progress.message_id,
    `📢 Broadcast complete.\n\nSent: ${sent}\nFailed: ${failed}\nTotal: ${ids.length}`,
  );
}

module.exports = { registerHandlers };