const test = require("node:test");
const assert = require("node:assert/strict");
const {
  splitRecords,
  detectGame,
  detectStatus,
  removeDuplicates,
  analyzeFile,
} = require("../src/parser");

test("splits one-record-per-line files", () => {
  assert.deepEqual(splitRecords("record 1\nrecord 2\nrecord 3"), [
    "record 1",
    "record 2",
    "record 3",
  ]);
});

test("preserves blank-line record blocks", () => {
  assert.deepEqual(splitRecords("Account: one\nStatus: VALID\n\nAccount: two\nStatus: FAIL"), [
    "Account: one\nStatus: VALID",
    "Account: two\nStatus: FAIL",
  ]);
});

test("detects games with score indicators", () => {
  assert.equal(detectGame("Call of Duty Mobile / Garena"), "CODM");
  assert.equal(detectGame("MLBB / Moonton"), "MLBB");
  assert.equal(detectGame("CODM and Mobile Legends"), "CODM + MLBB");
  assert.equal(detectGame("unrelated text"), "UNKNOWN");
});

test("invalid takes priority over valid", () => {
  assert.equal(detectStatus("Status: VALID"), "VALID");
  assert.equal(detectStatus("Status: INVALID"), "INVALID");
  assert.equal(detectStatus("VALID then FAILED"), "INVALID");
  assert.equal(detectStatus("no status"), "UNKNOWN");
});

test("removes duplicate records without changing the first copy", () => {
  const result = removeDuplicates(["One", " one ", "Two"]);
  assert.deepEqual(result.records, ["One", "Two"]);
  assert.equal(result.duplicatesRemoved, 1);
});

test("analyzes records and reports safe counts", () => {
  const result = analyzeFile(
    "CODM\nStatus: VALID\n\nCODM\nStatus: VALID\n\nMLBB\nStatus: FAIL\n\nno status",
  );
  assert.equal(result.game, "CODM + MLBB");
  assert.equal(result.total, 3);
  assert.equal(result.validCount, 1);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.duplicatesRemoved, 1);
});