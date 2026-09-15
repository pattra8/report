"use strict";

const RECEIPT_COUNTER_PATH = "pattra_counters/receipts";

/**
 * Atomically verifies the payment and allocates the next receipt sequence.
 * Missing payments do not advance the counter.
 *
 * @param {*} db Firestore instance.
 * @param {*} paymentRef Payment DocumentReference.
 * @return {Promise<{payment: Object, sequence: number}>}
 */
async function allocateReceiptSequence(db, paymentRef) {
  return db.runTransaction(async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) {
      const err = new Error("ไม่พบรายการ");
      err.status = 404;
      throw err;
    }

    const counterRef = db.doc(RECEIPT_COUNTER_PATH);
    const counterSnap = await tx.get(counterRef);
    const current = counterSnap.exists ? counterSnap.data().value : 0;
    const sequence = (Number(current) || 0) + 1;
    tx.set(counterRef, {value: sequence}, {merge: true});
    return {
      payment: paymentSnap.data() || {},
      sequence,
    };
  });
}

/**
 * Atomically verifies a payment, allocates its receipt number, and applies it
 * to an installment balance when present. Email delivery intentionally runs
 * after this transaction; an email outage must never leave the money credited
 * without the payment itself being verified.
 *
 * @param {*} db Firestore instance.
 * @param {*} paymentRef Payment DocumentReference.
 * @param {Object} options Verification dependencies and selected identity.
 * @return {Promise<Object>} Issued receipt and installment result.
 */
async function commitPaymentVerification(db, paymentRef, options) {
  return db.runTransaction(async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) {
      const err = new Error("ไม่พบรายการ");
      err.status = 404;
      throw err;
    }

    const payment = paymentSnap.data() || {};
    if (payment.status === "verified" && payment.receiptNo) {
      return {
        alreadyIssued: true,
        payment,
        receiptNo: payment.receiptNo,
        receiptHtml: payment.receiptHtml || "",
        installment: payment.installmentTotal ? {
          totalAmount: Number(payment.installmentTotal),
          paidAmount: Number(payment.installmentPaid || 0),
          remaining: Number(payment.installmentRemaining || 0),
        } : null,
      };
    }
    if (payment.status !== "pending" && payment.status !== "verified") {
      const err = new Error("รายการนี้ไม่อยู่ในสถานะรอตรวจ");
      err.status = 409;
      throw err;
    }

    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error("กรุณาตรวจและกรอกยอดเงินก่อนยืนยัน");
      err.status = 400;
      throw err;
    }

    const counterRef = db.doc(RECEIPT_COUNTER_PATH);
    const counterSnap = await tx.get(counterRef);
    let planRef = null;
    let planSnap = null;
    if (payment.planId) {
      planRef = db.collection(options.planCollection).doc(payment.planId);
      planSnap = await tx.get(planRef);
      if (!planSnap.exists) {
        const err = new Error("ไม่พบแผนผ่อนของรายการนี้");
        err.status = 409;
        throw err;
      }
    }

    const current = counterSnap.exists ? counterSnap.data().value : 0;
    const sequence = (Number(current) || 0) + 1;
    const receiptNo = `RC-${payment.year}-${String(sequence).padStart(4, "0")}`;
    let installment = null;
    let planPatch = null;
    if (planSnap) {
      const rawPlan = planSnap.data() || {};
      const applied = options.applyPaymentToPlan({
        id: planSnap.id,
        ...rawPlan,
      }, {id: paymentRef.id, amount});
      installment = {
        totalAmount: Number(rawPlan.totalAmount || 0),
        paidAmount: applied.paidAmount,
        remaining: applied.remaining,
        planStatus: applied.status,
      };
      planPatch = {
        paidAmount: applied.paidAmount,
        appliedPaymentIds: applied.appliedPaymentIds,
        status: applied.status,
        updatedAt: options.serverTimestamp(),
      };
    }

    const verifiedAtMs = options.verifiedAtMs || Date.now();
    const receiptRecord = {
      houseNo: payment.houseNo,
      feeType: payment.feeType,
      period: payment.period,
      year: payment.year,
      amount,
      payerName: options.payerName || payment.payerName || "",
      email: options.email || payment.email || "",
      receiptNo,
      verifiedAt: verifiedAtMs,
      installmentPaid: installment ? installment.paidAmount : null,
      installmentTotal: installment ? installment.totalAmount : null,
      installmentRemaining: installment ? installment.remaining : null,
    };
    const receiptHtml = options.renderReceipt(receiptRecord);
    const paymentPatch = {
      status: "verified",
      payerName: receiptRecord.payerName,
      email: receiptRecord.email,
      receiptNo,
      receiptHtml,
      verifiedAt: options.serverTimestamp(),
      emailStatus: "pending",
    };
    if (installment) {
      paymentPatch.installmentPaid = installment.paidAmount;
      paymentPatch.installmentTotal = installment.totalAmount;
      paymentPatch.installmentRemaining = installment.remaining;
    }

    tx.set(counterRef, {value: sequence}, {merge: true});
    if (planRef && planPatch) tx.update(planRef, planPatch);
    tx.update(paymentRef, paymentPatch);

    return {
      alreadyIssued: false,
      payment: {...payment, ...paymentPatch},
      receiptNo,
      receiptHtml,
      receiptRecord,
      installment,
    };
  });
}


/**
 * Verifies every row of a multi-month transfer and issues ONE receipt for the
 * whole thing.
 *
 * A parking transfer covering several months is stored as one row per month so
 * the ledger stays monthly, but the resident made a single payment and must
 * get a single receipt. The first row owns the receipt (number, HTML, total);
 * the rest carry the same receipt number plus `receiptRef` pointing at the
 * owner, so nothing double-counts when receipts are listed.
 *
 * @param {*} db Firestore instance.
 * @param {Array} paymentRefs Payment DocumentReferences, in month order.
 * @param {Object} options Verification dependencies and selected identity.
 * @return {Promise<Object>} Issued receipt covering the whole transfer.
 */
async function commitGroupVerification(db, paymentRefs, options) {
  if (!Array.isArray(paymentRefs) || paymentRefs.length === 0) {
    const err = new Error("ไม่พบรายการ");
    err.status = 404;
    throw err;
  }
  return db.runTransaction(async (tx) => {
    const snaps = [];
    for (const ref of paymentRefs) {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const err = new Error("ไม่พบรายการ");
        err.status = 404;
        throw err;
      }
      snaps.push(snap);
    }

    const rows = snaps.map((snap) => snap.data() || {});
    const owner = rows[0];
    if (owner.status === "verified" && owner.receiptNo) {
      return {
        alreadyIssued: true,
        payment: owner,
        receiptNo: owner.receiptNo,
        receiptHtml: owner.receiptHtml || "",
        installment: null,
      };
    }
    if (rows.some((row) => row.status !== "pending")) {
      const err = new Error("มีบางงวดไม่อยู่ในสถานะรอตรวจ");
      err.status = 409;
      throw err;
    }

    // Sum in satang so the receipt total is exactly what was transferred.
    let totalSatang = 0;
    for (const row of rows) {
      const amount = Number(row.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        const err = new Error("กรุณาตรวจและกรอกยอดเงินก่อนยืนยัน");
        err.status = 400;
        throw err;
      }
      totalSatang += Math.round(amount * 100);
    }
    const amount = totalSatang / 100;

    const counterRef = db.doc(RECEIPT_COUNTER_PATH);
    const counterSnap = await tx.get(counterRef);
    const current = counterSnap.exists ? counterSnap.data().value : 0;
    const sequence = (Number(current) || 0) + 1;
    const receiptNo = `RC-${owner.year}-${String(sequence).padStart(4, "0")}`;

    const verifiedAtMs = options.verifiedAtMs || Date.now();
    const receiptRecord = {
      houseNo: owner.houseNo,
      feeType: owner.feeType,
      period: owner.period,
      periodLabel: options.periodLabel || "",
      periods: rows.map((row) => row.period),
      year: owner.year,
      amount,
      payerName: options.payerName || owner.payerName || "",
      email: options.email || owner.email || "",
      receiptNo,
      verifiedAt: verifiedAtMs,
      installmentPaid: null,
      installmentTotal: null,
      installmentRemaining: null,
    };
    const receiptHtml = options.renderReceipt(receiptRecord);

    tx.set(counterRef, {value: sequence}, {merge: true});
    paymentRefs.forEach((ref, index) => {
      const patch = {
        status: "verified",
        payerName: receiptRecord.payerName,
        email: receiptRecord.email,
        receiptNo,
        verifiedAt: options.serverTimestamp(),
      };
      if (index === 0) {
        patch.receiptHtml = receiptHtml;
        patch.receiptAmount = amount;
        patch.receiptPeriods = receiptRecord.periods;
        patch.emailStatus = "pending";
      } else {
        // Not the receipt owner — points at the row that holds the document.
        patch.receiptRef = paymentRefs[0].id;
      }
      tx.update(ref, patch);
    });

    return {
      alreadyIssued: false,
      payment: {...owner, status: "verified", receiptNo},
      receiptNo,
      receiptHtml,
      receiptRecord,
      amount,
      installment: null,
    };
  });
}

module.exports = {
  allocateReceiptSequence,
  commitPaymentVerification,
  commitGroupVerification,
  RECEIPT_COUNTER_PATH,
};
