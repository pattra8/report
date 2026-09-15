"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  applyPaymentToPlan,
  planProgress,
  validatePlanInput,
} = require("../domains/payments/installment-policy");

test("installment progress begins at zero and avoids division by zero", () => {
  assert.deepEqual(planProgress({totalAmount: 9600, paidAmount: 0}), {
    totalAmount: 9600,
    paidAmount: 0,
    remaining: 9600,
    percent: 0,
  });
  assert.deepEqual(planProgress({totalAmount: 0, paidAmount: 0}), {
    totalAmount: 0,
    paidAmount: 0,
    remaining: 0,
    percent: 0,
  });
});

test("installment accepts arbitrary amounts without decimal drift", () => {
  let plan = {totalAmount: 21600, paidAmount: 0, status: "active"};
  for (let index = 0; index < 10; index += 1) {
    plan = {...plan, ...applyPaymentToPlan(plan, {
      id: `payment-${index}`,
      amount: 0.1,
    })};
  }
  assert.equal(plan.paidAmount, 1);
  assert.equal(plan.remaining, 21599);
});

test("installment application is idempotent by payment id", () => {
  const plan = {totalAmount: 9600, paidAmount: 1500, status: "active"};
  const first = applyPaymentToPlan(plan, {id: "payment-1", amount: 4000});
  const second = applyPaymentToPlan({...plan, ...first}, {
    id: "payment-1",
    amount: 4000,
  });
  assert.equal(first.paidAmount, 5500);
  assert.equal(second.paidAmount, 5500);
  assert.equal(second.applied, false);
});

test("installment rejects invalid totals and zero payments", () => {
  assert.throws(() => validatePlanInput({totalAmount: 0}), /ยอดเต็มไม่ถูกต้อง/);
  assert.throws(() => applyPaymentToPlan({
    totalAmount: 9600,
    paidAmount: 0,
    status: "active",
  }, {id: "payment-1", amount: 0}), /ยอดเงินไม่ถูกต้อง/);
});
