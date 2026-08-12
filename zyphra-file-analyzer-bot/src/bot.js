const { Telegraf } = require("telegraf");
const http = require("node:http");
const initSqlJs = require("sql.js");
const { config, requireBotToken } = require("./config");
const databaseApi = require("./database");
const { registerHandlers } = require("./handlers");
const logger = require("./logger");

async function start() {
  const bot = new Telegraf(requireBotToken());
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
  });
  const db = await databaseApi.createDatabase(SQL, config.databasePath);
  const database = { ...databaseApi, db };

  registerHandlers(bot, database);

  bot.catch((error, ctx) => {
    logger.error("Unhandled Telegram update", {
      updateType: ctx.updateType,
      reason: error.message,
    });
  });

  const stop = (signal) => {
    logger.info("Stopping bot", { signal });
    try {
      bot.stop(signal);
    } catch (error) {
      logger.warn("Bot stop warning", { reason: error.message });
    }
    if (server) {
      server.close();
    }
    databaseApi.closeDatabase(db);
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  let server = null;

  if (config.webhookDomain) {
    const webhookUrl = `https://${config.webhookDomain}${config.webhookPath}`;
    const webhookHandler = bot.webhookCallback(config.webhookPath, {
      secretToken: config.webhookSecret || undefined,
    });

    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          service: "zyphra-file-analyzer-bot",
          telegram: "webhook",
        }));
        return;
      }

      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("Zyphra Telegram Bot is online.");
        return;
      }

      if (req.url === config.webhookPath) {
        webhookHandler(req, res);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "0.0.0.0", resolve);
    });

    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: false,
      ...(config.webhookSecret
        ? { secret_token: config.webhookSecret }
        : {}),
    });

    logger.info("Bot started with Telegram webhook", {
      environment: config.environment,
      webhookUrl,
      port: config.port,
    });
  } else {
    await bot.launch({ dropPendingUpdates: false });
    logger.info("Bot started with long polling", {
      environment: config.environment,
    });
  }

  logger.info("Database connected");
}

module.exports = { start };