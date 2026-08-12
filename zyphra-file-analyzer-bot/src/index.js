const { start } = require("./bot");
const logger = require("./logger");

start().catch((error) => {
  logger.error("Bot could not start", { reason: error.message });
  process.exitCode = 1;
});