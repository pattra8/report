"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  buildHouseBilling,
  redactInstallmentBalances,
} = require("../domains/payments/house-billing");

test("normal houses keep encoded transfer totals for both half-years", () => {
  const billing = buildHouseBilling({
    houseNo: 43,
    year: 2026,
    baseAmount: 9600,
    plans: [],
    payments: [],
  });
  assert.deepEqual(
      billing.periods.map((card) => ({
        period: card.period,
        status: card.status,
        transferAmount: card.transferAmount,
        installment: card.installment,
      })),
      [
        {
          period: "H1",
          status: "open",
          transferAmount: 9600.43,
          installment: null,
        },
        {
          period: "H2",
          status: "open",
          transferAmount: 9600.43,
          installment: null,
        },
      ],
  );
});

test("active plan returns a running balance without a schedule", () => {
  const billing = buildHouseBilling({
    houseNo: 43,
    year: 2026,
    baseAmount: 21600,
    plans: [{
      id: "plan-43-h2",
      houseNo: 43,
      year: 2026,
      period: "H2",
      totalAmount: 21600,
      paidAmount: 10000,
      status: "active",
    }],
    payments: [],
  });
  const h2 = billing.periods.find((card) => card.period === "H2");
  assert.equal(h2.status, "installment");
  assert.deepEqual(h2.installment, {
    planId: "plan-43-h2",
    totalAmount: 21600,
    paidAmount: 10000,
    remaining: 11600,
    percent: 46,
    awaitingReview: false,
  });
  assert.equal(h2.transferAmount, 0);
});

test("pending installment remains visible after verified payments", () => {
  const billing = buildHouseBilling({
    houseNo: 13,
    year: 2026,
    baseAmount: 9600,
    plans: [{
      id: "plan-13-h2",
      year: 2026,
      period: "H2",
      totalAmount: 9600,
      paidAmount: 5000,
      status: "active",
    }],
    payments: [
      {feeType: "common", period: "H2", year: 2026, status: "verified"},
      {feeType: "common", period: "H2", year: 2026, status: "pending"},
    ],
  });
  const h2 = billing.periods.find((card) => card.period === "H2");
  assert.equal(h2.installment.awaitingReview, true);
});

test("installment amounts are redacted until resident PIN succeeds", () => {
  const billing = buildHouseBilling({
    houseNo: 43,
    year: 2026,
    baseAmount: 9600,
    plans: [{
      id: "plan-43-h2",
      year: 2026,
      period: "H2",
      totalAmount: 9600,
      paidAmount: 4000,
      status: "active",
    }],
    payments: [],
  });
  const protectedBilling = redactInstallmentBalances(billing);
  const h2 = protectedBilling.periods.find((card) => card.period === "H2");
  assert.equal(protectedBilling.requiresPin, true);
  assert.equal(h2.installment, null);
  assert.equal(h2.amountDue, 0);
  assert.equal(h2.transferAmount, 0);
});
