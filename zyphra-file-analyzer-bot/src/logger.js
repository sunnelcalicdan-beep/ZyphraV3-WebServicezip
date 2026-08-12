function safeDetails(details) {
  if (!details || typeof details !== "object") {
    return "";
  }

  return ` ${JSON.stringify(details)}`;
}

function info(message, details) {
  console.log(`[INFO] ${message}${safeDetails(details)}`);
}

function check(details) {
  console.log(`[CHECK] ${JSON.stringify(details)}`);
}

function warn(message, details) {
  console.warn(`[WARN] ${message}${safeDetails(details)}`);
}

function error(message, details) {
  console.error(`[ERROR] ${message}${safeDetails(details)}`);
}

module.exports = { info, check, warn, error };