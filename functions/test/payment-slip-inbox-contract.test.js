"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
);

/**
 * Extracts one action block using the next action marker as its boundary.
 * @param {string} action Firebase HTTP action name.
 * @param {string} nextAction Following Firebase HTTP action name.
 * @return {string}
 */
function actionBlock(action, nextAction) {
  const start = source.indexOf(`if (action === "${action}")`);
  const end = source.indexOf(`if (action === "${nextAction}")`, start + 1);
  assert.notEqual(start, -1, `missing ${action} action`);
  assert.notEqual(end, -1, `missing ${nextAction} boundary`);
  return source.slice(start, end);
}

test("public upload writes directly to the verification queue", () => {
  const block = actionBlock("submitCommonSlip", "adminListCommonSlips");
  assert.match(block, /db\.collection\(PP_COLLECTION\)\.doc\(\)/);
  assert.match(block, /feeType:\s*"common"/);
  assert.match(block, /status:\s*"pending"/);
  assert.match(block, /source:\s*"resident_upload"/);
  assert.match(block, /pattra-slips/);
});

test("new public upload emails the admin after the payment is saved", () => {
  const block = actionBlock("submitCommonSlip", "adminListCommonSlips");
  const writeAt = block.indexOf("await ref.set(payload)");
  const notifyAt = block.indexOf("await ppSendEmail(");
  const responseAt = block.indexOf("res.status(200).json", notifyAt);
  assert.ok(writeAt >= 0, "payment must be stored");
  assert.ok(notifyAt > writeAt, "notification must follow the durable write");
  assert.ok(
      responseAt > notifyAt,
      "request must await the notification attempt",
  );
  assert.match(block, /PP_ADMIN_NOTIFICATION_EMAIL/);
  assert.match(block, /adminNotificationStatus/);
});

test("duplicate check covers active payments and legacy inbox", () => {
  const block = actionBlock("submitCommonSlip", "adminListCommonSlips");
  assert.match(block, /PP_COLLECTION/);
  assert.match(block, /PP_SLIP_INBOX_COLLECTION/);
  assert.match(block, /data\.status === "pending"/);
  assert.match(block, /data\.status === "verified"/);
});

test("slip inbox admin listing verifies committee access", () => {
  const block = actionBlock("adminListCommonSlips", "submitPayment");
  const authAt = block.indexOf("await verifyAdminResidentAccess(body)");
  const readAt = block.indexOf("db.collection(PP_SLIP_INBOX_COLLECTION)");
  assert.ok(authAt >= 0, "admin access verification is required");
  assert.ok(readAt > authAt, "verification must happen before inbox read");
});

test("legacy inbox deletion preserves the payment and Storage object", () => {
  const block = actionBlock("adminDeleteLegacyCommonSlip", "submitPayment");
  const authAt = block.indexOf("await verifyAdminResidentAccess(body)");
  const paymentReadAt = block.indexOf("db.collection(PP_COLLECTION)");
  const deleteAt = block.indexOf("await inboxRef.delete()");
  assert.ok(authAt >= 0, "admin access verification is required");
  assert.ok(
      paymentReadAt > authAt,
      "payment lookup must follow authentication",
  );
  assert.ok(
      deleteAt > paymentReadAt,
      "inbox deletion must follow payment lookup",
  );
  assert.doesNotMatch(block, /\.file\(.*\)\.delete/);
  assert.doesNotMatch(block, /payment\.ref\.delete/);
  assert.match(block, /data\.status === "pending"/);
  assert.match(block, /data\.status === "verified"/);
});

test("admin listing migrates legacy inbox before reading the queue", () => {
  const block = actionBlock("adminList", "adminImportPayments");
  const authAt = block.indexOf("await verifyAdminResidentAccess(body)");
  const migrateAt = block.indexOf("await ppMigrateLegacySlipInbox()");
  const readAt = block.indexOf("db.collection(PP_COLLECTION)");
  assert.ok(authAt >= 0, "admin access verification is required");
  assert.ok(
      migrateAt > authAt,
      "legacy migration must run after authentication",
  );
  assert.ok(readAt > migrateAt, "queue must be read after migration");
});

test("legacy migration is idempotent and marks inbox processed", () => {
  const start = source.indexOf("async function ppMigrateLegacySlipInbox()");
  const end = source.indexOf("exports.pattraPay", start);
  assert.ok(
      start >= 0 && end > start,
      "missing legacy inbox migration helper",
  );
  const block = source.slice(start, end);
  assert.match(block, /doc\(`inbox_\$\{doc\.id\}`\)/);
  assert.match(block, /status:\s*"pending"/);
  assert.match(block, /source:\s*"resident_upload"/);
  assert.match(block, /status:\s*"processed"/);
  assert.match(block, /paymentId:\s*paymentRef\.id/);
  assert.match(block, /payment\.status === "pending"/);
  assert.match(block, /payment\.status === "verified"/);
});
