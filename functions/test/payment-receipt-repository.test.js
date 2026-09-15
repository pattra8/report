"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  allocateReceiptSequence,
  commitPaymentVerification,
  RECEIPT_COUNTER_PATH,
} = require("../domains/payments/receipt-repository");
const {
  applyPaymentToPlan,
} = require("../domains/payments/installment-policy");

/**
 * Builds a transaction-aware Firestore double.
 * @param {Object} paymentSnap Payment snapshot.
 * @param {Object} counterSnap Counter snapshot.
 * @return {{db: Object, writes: Array<Object>}}
 */
function firestoreDouble(paymentSnap, counterSnap) {
  const paymentRef = {path: "pattra_payments/payment-1"};
  const counterRef = {path: RECEIPT_COUNTER_PATH};
  const writes = [];
  const tx = {
    get: async (ref) => ref === paymentRef ? paymentSnap : counterSnap,
    set: (ref, data, options) => writes.push({ref, data, options}),
  };
  const db = {
    paymentRef,
    doc: (path) => {
      assert.equal(path, RECEIPT_COUNTER_PATH);
      return counterRef;
    },
    runTransaction: async (work) => work(tx),
  };
  return {db, writes, counterRef};
}

test("missing payment does not advance receipt counter", async () => {
  const {db, writes} = firestoreDouble(
      {exists: false},
      {exists: true, data: () => ({value: 9})},
  );
  await assert.rejects(
      allocateReceiptSequence(db, db.paymentRef),
      (err) => err.status === 404 && err.message === "ไม่พบรายการ",
  );
  assert.deepEqual(writes, []);
});

test("receipt sequence allocation is atomic", async () => {
  const payment = {year: 2026, houseNo: 8};
  const {db, writes, counterRef} = firestoreDouble(
      {exists: true, data: () => payment},
      {exists: true, data: () => ({value: 9})},
  );
  const result = await allocateReceiptSequence(db, db.paymentRef);
  assert.deepEqual(result, {payment, sequence: 10});
  assert.deepEqual(writes, [{
    ref: counterRef,
    data: {value: 10},
    options: {merge: true},
  }]);
});

test("missing receipt counter starts sequence at one", async () => {
  const payment = {year: 2026, houseNo: 8};
  const {db} = firestoreDouble(
      {exists: true, data: () => payment},
      {exists: false},
  );
  const result = await allocateReceiptSequence(db, db.paymentRef);
  assert.equal(result.sequence, 1);
});

/**
 * Firestore transaction double for a payment linked to one plan.
 * @param {Object} payment Payment document data.
 * @param {Object} plan Plan document data.
 * @return {{db: Object, paymentRef: Object, writes: Array<Object>}}
 */
function verificationDouble(payment, plan) {
  const paymentRef = {path: "pattra_payments/payment-1", id: "payment-1"};
  const counterRef = {path: RECEIPT_COUNTER_PATH};
  const planRef = {path: "pattra_installment_plans/plan-1", id: "plan-1"};
  const writes = [];
  const snap = (value, id = "") => ({
    exists: value !== null,
    id,
    data: () => value || {},
  });
  const tx = {
    get: async (ref) => {
      if (ref === paymentRef) return snap(payment, paymentRef.id);
      if (ref === counterRef) return snap({value: 4});
      if (ref === planRef) return snap(plan, planRef.id);
      throw new Error(`unexpected read: ${ref.path}`);
    },
    set: (ref, data, options) => writes.push({kind: "set", ref, data, options}),
    update: (ref, data) => writes.push({kind: "update", ref, data}),
  };
  const db = {
    doc: (path) => {
      assert.equal(path, RECEIPT_COUNTER_PATH);
      return counterRef;
    },
    collection: (name) => {
      assert.equal(name, "pattra_installment_plans");
      return {
        doc: (id) => {
          assert.equal(id, "plan-1");
          return planRef;
        },
      };
    },
    runTransaction: async (work) => work(tx),
  };
  return {db, paymentRef, planRef, writes};
}

/** @return {Object} Stable verification dependencies for transaction tests. */
function verificationOptions() {
  return {
    planCollection: "pattra_installment_plans",
    applyPaymentToPlan,
    payerName: "Resident",
    email: "resident@example.com",
    verifiedAtMs: 1234,
    serverTimestamp: () => "SERVER_TIME",
    renderReceipt: (record) => `receipt:${record.receiptNo}:${record.amount}`,
  };
}

test("verification atomically updates payment and installment", async () => {
  const {db, paymentRef, planRef, writes} = verificationDouble({
    status: "pending",
    planId: "plan-1",
    houseNo: 43,
    feeType: "common",
    period: "H2",
    year: 2026,
    amount: 2000,
  }, {
    totalAmount: 21600,
    paidAmount: 10000,
    status: "active",
    appliedPaymentIds: [],
  });
  const result = await commitPaymentVerification(
      db,
      paymentRef,
      verificationOptions(),
  );
  assert.equal(result.receiptNo, "RC-2026-0005");
  assert.deepEqual(result.installment, {
    totalAmount: 21600,
    paidAmount: 12000,
    remaining: 9600,
    planStatus: "active",
  });
  const planWrite = writes.find((write) => write.ref === planRef);
  const paymentWrite = writes.find((write) => write.ref === paymentRef);
  assert.equal(planWrite.data.paidAmount, 12000);
  assert.deepEqual(planWrite.data.appliedPaymentIds, ["payment-1"]);
  assert.equal(paymentWrite.data.status, "verified");
  assert.equal(paymentWrite.data.installmentRemaining, 9600);
});

test("verification rejects zero OCR amount without writes", async () => {
  const {db, paymentRef, writes} = verificationDouble({
    status: "pending",
    planId: "plan-1",
    year: 2026,
    amount: 0,
  }, {
    totalAmount: 9600,
    paidAmount: 0,
    status: "active",
  });
  await assert.rejects(
      commitPaymentVerification(db, paymentRef, verificationOptions()),
      (err) => err.status === 400,
  );
  assert.deepEqual(writes, []);
});

test("verification is idempotent after a receipt has been issued", async () => {
  const {db, paymentRef, writes} = verificationDouble({
    status: "verified",
    receiptNo: "RC-2026-0004",
    receiptHtml: "saved receipt",
    amount: 2000,
    year: 2026,
  }, null);
  const result = await commitPaymentVerification(
      db,
      paymentRef,
      verificationOptions(),
  );
  assert.equal(result.alreadyIssued, true);
  assert.equal(result.receiptNo, "RC-2026-0004");
  assert.deepEqual(writes, []);
});
