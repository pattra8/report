"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  commitGroupVerification,
  RECEIPT_COUNTER_PATH,
} = require("../domains/payments/receipt-repository");

/**
 * Firestore double holding several payment rows plus the receipt counter.
 * @param {Array<Object>} rows Payment docs, month order.
 * @param {number} counterValue Current receipt sequence.
 * @return {Object} db double, its refs, and the writes it collected.
 */
function groupDouble(rows, counterValue) {
  const refs = rows.map((_, i) => ({
    id: `pay-${i}`, path: `pattra_payments/pay-${i}`,
  }));
  const counterRef = {path: RECEIPT_COUNTER_PATH};
  const updates = [];
  const sets = [];
  const tx = {
    get: async (ref) => {
      if (ref === counterRef) {
        return {exists: true, data: () => ({value: counterValue})};
      }
      const index = refs.indexOf(ref);
      const row = rows[index];
      return {exists: row !== undefined, data: () => row};
    },
    set: (ref, data, options) => sets.push({ref, data, options}),
    update: (ref, data) => updates.push({id: ref.id, data}),
  };
  const db = {
    doc: (path) => (path === RECEIPT_COUNTER_PATH ? counterRef : {path}),
    runTransaction: async (fn) => fn(tx),
  };
  return {db, refs, updates, sets};
}

const options = {
  payerName: "นาย วาทิต ส",
  email: "watit@example.com",
  verifiedAtMs: 1758000000000,
  serverTimestamp: () => "SERVER_TS",
  renderReceipt: (r) => `<html>${r.receiptNo}:${r.amount}</html>`,
};

const month = (period, amount) => ({
  houseNo: 38, feeType: "parking", period, year: 2026, amount,
  status: "pending",
});

const sixMonths = () => [
  month("2026-07", 600.38),
  month("2026-08", 600),
  month("2026-09", 600),
  month("2026-10", 600),
  month("2026-11", 600),
  month("2026-12", 600),
];

test("six months yield one receipt for the full amount", async () => {
  const {db, refs, updates, sets} = groupDouble(sixMonths(), 40);
  const issued = await commitGroupVerification(db, refs, options);
  assert.equal(issued.alreadyIssued, false);
  assert.equal(issued.receiptNo, "RC-2026-0041");
  assert.equal(issued.amount, 3600.38);
  assert.equal(updates.length, 6);
  assert.equal(sets.length, 1); // the counter advanced exactly once
  assert.equal(sets[0].data.value, 41);
});

test("only the first row owns the receipt document", async () => {
  const {db, refs, updates} = groupDouble(sixMonths(), 0);
  await commitGroupVerification(db, refs, options);

  const owner = updates[0].data;
  assert.equal(owner.receiptAmount, 3600.38);
  assert.deepEqual(owner.receiptPeriods, [
    "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
  ]);
  assert.ok(owner.receiptHtml.includes("RC-2026-0001"));
  assert.equal(owner.receiptRef, undefined);

  for (const later of updates.slice(1)) {
    assert.equal(later.data.status, "verified");
    assert.equal(later.data.receiptNo, "RC-2026-0001");
    assert.equal(later.data.receiptRef, "pay-0");
    assert.equal(later.data.receiptHtml, undefined);
  }
});

test("every month is verified under the same receipt", async () => {
  const {db, refs, updates} = groupDouble(sixMonths(), 0);
  await commitGroupVerification(db, refs, options);
  assert.ok(updates.every((u) => u.data.status === "verified"));
  assert.equal(new Set(updates.map((u) => u.data.receiptNo)).size, 1);
});

test("an already-issued group does not advance the counter again", async () => {
  const rows = sixMonths();
  rows[0] = {
    ...rows[0],
    status: "verified",
    receiptNo: "RC-2026-0009",
    receiptHtml: "<html/>",
  };
  const {db, refs, updates, sets} = groupDouble(rows, 40);
  const issued = await commitGroupVerification(db, refs, options);

  assert.equal(issued.alreadyIssued, true);
  assert.equal(issued.receiptNo, "RC-2026-0009");
  assert.equal(updates.length, 0);
  assert.equal(sets.length, 0);
});

test("a group with a non-pending month is refused as a conflict", async () => {
  const rows = sixMonths();
  rows[3] = {...rows[3], status: "rejected"};
  const {db, refs} = groupDouble(rows, 0);
  await assert.rejects(
      () => commitGroupVerification(db, refs, options),
      (err) => err.status === 409,
  );
});

test("a month with no usable amount blocks the whole group", async () => {
  const rows = sixMonths();
  rows[2] = {...rows[2], amount: 0};
  const {db, refs} = groupDouble(rows, 0);
  await assert.rejects(
      () => commitGroupVerification(db, refs, options),
      (err) => err.status === 400,
  );
});

test("an empty group is a not-found, never a zero-baht receipt", async () => {
  const {db} = groupDouble([], 0);
  await assert.rejects(
      () => commitGroupVerification(db, [], options),
      (err) => err.status === 404,
  );
});
