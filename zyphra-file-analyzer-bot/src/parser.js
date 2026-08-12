const GAME_INDICATORS = {
  CODM: [
    /\bcodm\b/i,
    /\bcall\s+of\s+duty(?:\s+mobile)?\b/i,
    /\bgarena\b/i,
  ],
  MLBB: [/\bmlbb\b/i, /\bmobile\s+legends\b/i, /\bmoonton\b/i],
};

const VALID_INDICATORS = [/\bvalid\b/i, /\bclean\b/i, /\bsuccess\b/i];
const INVALID_INDICATORS = [/\binvalid\b/i, /\bfailed\b/i, /\bfail\b/i];

function cleanRecord(record) {
  return record.replace(/\r/g, "").trim();
}

/**
 * Supports blank-line blocks and one-record-per-line TXT files.
 * Blank-line blocks win when they are present because they preserve
 * multi-line records such as "Account: ..." and "Status: ...".
 */
function splitRecords(text) {
  if (typeof text !== "string") {
    throw new TypeError("TXT content must be a string");
  }

  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const blocks = normalized
    .split(/\n\s*\n+/)
    .map(cleanRecord)
    .filter(Boolean);

  if (blocks.length > 1) {
    return blocks;
  }

  return normalized
    .split("\n")
    .map(cleanRecord)
    .filter(Boolean);
}

function scoreIndicators(text, indicators) {
  return indicators.reduce(
    (score, indicator) => score + (indicator.test(text) ? 1 : 0),
    0,
  );
}

function detectGame(text) {
  const codmScore = scoreIndicators(text, GAME_INDICATORS.CODM);
  const mlbbScore = scoreIndicators(text, GAME_INDICATORS.MLBB);

  if (codmScore > 0 && mlbbScore > 0) {
    return "CODM + MLBB";
  }

  if (codmScore > 0) {
    return "CODM";
  }

  if (mlbbScore > 0) {
    return "MLBB";
  }

  return "UNKNOWN";
}

function hasAnyIndicator(text, indicators) {
  return indicators.some((indicator) => indicator.test(text));
}

function detectStatus(record) {
  // INVALID must be checked first so a mixed record is always classified safely.
  if (hasAnyIndicator(record, INVALID_INDICATORS)) {
    return "INVALID";
  }

  if (hasAnyIndicator(record, VALID_INDICATORS)) {
    return "VALID";
  }

  return "UNKNOWN";
}

function recordKey(record) {
  return record.toLowerCase().replace(/\s+/g, " ").trim();
}

function removeDuplicates(records) {
  const uniqueRecords = [];
  const seen = new Set();

  for (const record of records) {
    const key = recordKey(record);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueRecords.push(record);
  }

  return {
    records: uniqueRecords,
    duplicatesRemoved: records.length - uniqueRecords.length,
  };
}

function analyzeFile(text) {
  const records = splitRecords(text);
  const deduplicated = removeDuplicates(records);
  const categorized = {
    VALID: [],
    INVALID: [],
    UNKNOWN: [],
  };

  for (const record of deduplicated.records) {
    categorized[detectStatus(record)].push(record);
  }

  return {
    game: detectGame(text),
    total: deduplicated.records.length,
    originalTotal: records.length,
    valid: categorized.VALID,
    invalid: categorized.INVALID,
    unknown: categorized.UNKNOWN,
    validCount: categorized.VALID.length,
    invalidCount: categorized.INVALID.length,
    unknownCount: categorized.UNKNOWN.length,
    duplicatesRemoved: deduplicated.duplicatesRemoved,
  };
}

module.exports = {
  splitRecords,
  detectGame,
  detectStatus,
  removeDuplicates,
  analyzeFile,
};