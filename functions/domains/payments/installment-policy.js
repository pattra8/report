"use strict";

/* eslint-disable require-jsdoc */

const PLAN_ACTIVE = "active";
const PLAN_COMPLETED = "completed";
const PLAN_CLOSED = "closed";

function validatePlanInput(input = {}) {
  const totalAmount = toSatang(input.totalAmount);
  if (!Number.isFinite(Number(input.totalAmount)) || totalAmount <= 0) {
    throw Object.assign(new Error("ยอดเต็มไม่ถูกต้อง"), {status: 400});
  }
  return {totalAmount};
}

function toSatang(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function applyPaymentToPlan(plan, payment = {}) {
  const totalAmount = Number(plan.totalAmount || 0);
  const appliedPaymentIds = Array.isArray(plan.appliedPaymentIds) ?
    plan.appliedPaymentIds.slice() : [];
  const paymentId = payment.id || null;
  const current = toSatang(plan.paidAmount);

  if (paymentId && appliedPaymentIds.includes(paymentId)) {
    return {
      paidAmount: current,
      remaining: Math.max(0, toSatang(totalAmount - current)),
      status: planStatusOf(plan.status, totalAmount, current),
      appliedPaymentIds,
      applied: false,
    };
  }

  const amount = toSatang(payment.amount);
  if (!Number.isFinite(Number(payment.amount)) || amount <= 0) {
    throw Object.assign(new Error("ยอดเงินไม่ถูกต้อง"), {status: 400});
  }
  const paidAmount = toSatang(current + amount);
  if (paymentId) appliedPaymentIds.push(paymentId);
  return {
    paidAmount,
    remaining: Math.max(0, toSatang(totalAmount - paidAmount)),
    status: planStatusOf(plan.status, totalAmount, paidAmount),
    appliedPaymentIds,
    applied: true,
  };
}

function planStatusOf(currentStatus, totalAmount, paidAmount) {
  if (currentStatus === PLAN_CLOSED) return PLAN_CLOSED;
  return toSatang(paidAmount) >= toSatang(totalAmount) ?
    PLAN_COMPLETED : PLAN_ACTIVE;
}

function planProgress(plan) {
  const totalAmount = toSatang(plan && plan.totalAmount);
  const paidAmount = toSatang(plan && plan.paidAmount);
  const remaining = Math.max(0, toSatang(totalAmount - paidAmount));
  const percent = totalAmount > 0 ?
    Math.min(100, Math.round((paidAmount / totalAmount) * 100)) : 0;
  return {totalAmount, paidAmount, remaining, percent};
}

function isPlanActive(plan) {
  return Boolean(plan) && plan.status === PLAN_ACTIVE;
}

module.exports = {
  PLAN_ACTIVE,
  PLAN_CLOSED,
  PLAN_COMPLETED,
  applyPaymentToPlan,
  isPlanActive,
  planProgress,
  planStatusOf,
  toSatang,
  validatePlanInput,
};
