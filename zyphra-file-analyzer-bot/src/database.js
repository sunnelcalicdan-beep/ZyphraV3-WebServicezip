const fs = require("node:fs");
const path = require("node:path");

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function now() {
  return new Date().toISOString();
}

function rows(state, query, params = []) {
  const statement = state.sqlite.prepare(query);
  statement.bind(params);
  const result = [];

  while (statement.step()) {
    result.push(statement.getAsObject());
  }

  statement.free();
  return result;
}

function firstRow(state, query, params = []) {
  return rows(state, query, params)[0];
}

function persist(state) {
  const bytes = state.sqlite.export();
  fs.writeFileSync(state.databasePath, Buffer.from(bytes));
}

async function createDatabase(SQL, databasePath) {
  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const existing = fs.existsSync(resolvedPath)
    ? new Uint8Array(fs.readFileSync(resolvedPath))
    : undefined;
  const state = {
    sqlite: existing ? new SQL.Database(existing) : new SQL.Database(),
    databasePath: resolvedPath,
  };

  state.sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      is_premium INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      checks_today INTEGER NOT NULL DEFAULT 0,
      last_check_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      game TEXT NOT NULL,
      total INTEGER NOT NULL,
      valid_count INTEGER NOT NULL,
      invalid_count INTEGER NOT NULL,
      unknown_count INTEGER NOT NULL,
      duplicates_removed INTEGER NOT NULL,
      processing_time REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      referral_code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(telegram_id, referral_code)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  state.sqlite.run(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
    ["maintenance", "0", now()],
  );
  persist(state);
  return state;
}

function closeDatabase(state) {
  persist(state);
  state.sqlite.close();
}

function upsertUser(state, telegramUser, referralCode) {
  const timestamp = now();
  const telegramId = String(telegramUser.id);
  state.sqlite.run(
    `
      INSERT INTO users (telegram_id, username, first_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        updated_at = excluded.updated_at
    `,
    [
      telegramId,
      telegramUser.username || null,
      telegramUser.first_name || null,
      timestamp,
      timestamp,
    ],
  );

  if (referralCode) {
    state.sqlite.run(
      `
        INSERT OR IGNORE INTO referrals (telegram_id, referral_code, created_at)
        VALUES (?, ?, ?)
      `,
      [telegramId, referralCode.slice(0, 120), timestamp],
    );
  }

  persist(state);
  return getUser(state, telegramId);
}

function getUser(state, telegramId) {
  return firstRow(state, "SELECT * FROM users WHERE telegram_id = ?", [
    String(telegramId),
  ]);
}

function isPremium(state, telegramId) {
  return Boolean(getUser(state, telegramId)?.is_premium);
}

function isBanned(state, telegramId) {
  return Boolean(getUser(state, telegramId)?.is_banned);
}

function getUsage(state, telegramId) {
  const user = getUser(state, telegramId);
  if (!user) {
    return { checksToday: 0, lastCheckDate: utcDate() };
  }

  const today = utcDate();
  if (user.last_check_date !== today) {
    state.sqlite.run(
      `
        UPDATE users
        SET checks_today = 0, last_check_date = ?, updated_at = ?
        WHERE telegram_id = ?
      `,
      [today, now(), String(telegramId)],
    );
    persist(state);
    return { checksToday: 0, lastCheckDate: today };
  }

  return {
    checksToday: Number(user.checks_today),
    lastCheckDate: user.last_check_date,
  };
}

function checkUserLimit(state, telegramId, config) {
  const user = getUser(state, telegramId);
  if (!user) {
    return { allowed: false, reason: "unknown_user" };
  }

  if (user.is_banned) {
    return { allowed: false, reason: "banned" };
  }

  const usage = getUsage(state, telegramId);
  const limit = user.is_premium ? config.vipLimit : config.freeLimit;
  return {
    allowed: limit === 0 || usage.checksToday < limit,
    checksToday: usage.checksToday,
    limit,
    isPremium: Boolean(user.is_premium),
  };
}

function incrementCheckUsage(state, telegramId) {
  const today = utcDate();
  state.sqlite.run(
    `
      UPDATE users
      SET checks_today = CASE
        WHEN last_check_date = ? THEN checks_today + 1
        ELSE 1
      END,
      last_check_date = ?,
      updated_at = ?
      WHERE telegram_id = ?
    `,
    [today, today, now(), String(telegramId)],
  );
  persist(state);
}

function recordCheck(state, telegramId, metadata) {
  state.sqlite.run(
    `
      INSERT INTO checks (
        telegram_id, filename, game, total, valid_count, invalid_count,
        unknown_count, duplicates_removed, processing_time, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      String(telegramId),
      metadata.filename,
      metadata.game,
      metadata.total,
      metadata.validCount,
      metadata.invalidCount,
      metadata.unknownCount,
      metadata.duplicatesRemoved,
      metadata.processingTime,
      now(),
    ],
  );
  persist(state);
}

function getUserStats(state, telegramId) {
  const summary = firstRow(
    state,
    `
      SELECT
        COUNT(*) AS total_checks,
        COALESCE(SUM(total), 0) AS total_records,
        COALESCE(SUM(valid_count), 0) AS valid_count,
        COALESCE(SUM(invalid_count), 0) AS invalid_count,
        COALESCE(SUM(unknown_count), 0) AS unknown_count,
        COALESCE(SUM(duplicates_removed), 0) AS duplicates_removed
      FROM checks
      WHERE telegram_id = ?
    `,
    [String(telegramId)],
  );
  const user = getUser(state, telegramId);
  const usage = getUsage(state, telegramId);

  return {
    ...summary,
    isPremium: Boolean(user?.is_premium),
    checksToday: usage.checksToday,
  };
}

function getGlobalStats(state) {
  const totals = firstRow(
    state,
    `
      SELECT
        COUNT(*) AS total_checks,
        COALESCE(SUM(total), 0) AS total_records,
        COALESCE(SUM(valid_count), 0) AS valid_count,
        COALESCE(SUM(invalid_count), 0) AS invalid_count,
        COALESCE(SUM(unknown_count), 0) AS unknown_count,
        COALESCE(SUM(duplicates_removed), 0) AS duplicates_removed
      FROM checks
    `,
  );
  const counts = firstRow(
    state,
    `
      SELECT
        COUNT(*) AS users,
        COALESCE(SUM(is_premium), 0) AS premium_users,
        COALESCE(SUM(is_banned), 0) AS banned_users
      FROM users
    `,
  );

  return {
    ...counts,
    ...totals,
    maintenance: getSetting(state, "maintenance") === "1",
  };
}

function listUsers(state, filter = "") {
  let query = "SELECT * FROM users ORDER BY created_at DESC";
  if (filter === "premium") {
    query = "SELECT * FROM users WHERE is_premium = 1 ORDER BY created_at DESC";
  }
  if (filter === "banned") {
    query = "SELECT * FROM users WHERE is_banned = 1 ORDER BY created_at DESC";
  }
  return rows(state, query);
}

function allUserIds(state) {
  return rows(state, "SELECT telegram_id FROM users ORDER BY id ASC").map(
    (row) => row.telegram_id,
  );
}

function setPremium(state, telegramId, enabled) {
  state.sqlite.run(
    "UPDATE users SET is_premium = ?, updated_at = ? WHERE telegram_id = ?",
    [enabled ? 1 : 0, now(), String(telegramId)],
  );
  persist(state);
  return getUser(state, telegramId);
}

function setBanned(state, telegramId, enabled) {
  state.sqlite.run(
    "UPDATE users SET is_banned = ?, updated_at = ? WHERE telegram_id = ?",
    [enabled ? 1 : 0, now(), String(telegramId)],
  );
  persist(state);
  return getUser(state, telegramId);
}

function getSetting(state, key) {
  return firstRow(state, "SELECT value FROM settings WHERE key = ?", [key])?.value;
}

function setSetting(state, key, value) {
  state.sqlite.run(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    [key, String(value), now()],
  );
  persist(state);
}

module.exports = {
  createDatabase,
  closeDatabase,
  upsertUser,
  getUser,
  isPremium,
  isBanned,
  checkUserLimit,
  incrementCheckUsage,
  recordCheck,
  getUserStats,
  getGlobalStats,
  listUsers,
  allUserIds,
  setPremium,
  setBanned,
  getSetting,
  setSetting,
};