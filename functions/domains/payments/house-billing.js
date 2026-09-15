"use strict";

/* eslint-disable require-jsdoc */

const {commonSlipAmount} = require("./public-slip-policy");
const {COMMON_PERIODS, commonPeriodLabel} = require("./period-policy");
const {isPlanActive, planProgress} = require("./installment-policy");

const STATUS_PAID = "paid";
const STATUS_PENDING = "pending";
const STATUS_OPEN = "open";
const STATUS_INSTALLMENT = "installment";

function scopedPayments(payments, period, year) {
  return payments.filter((payment) =>
    payment.feeType === "common" &&
    payment.period === period &&
    Number(payment.year) === Number(year));
}

function periodPaymentState(payments, period, year) {
  const scoped = scopedPayments(payments, period, year);
  const verified = scoped.find((payment) => payment.status === "verified");
  if (verified) return {status: STATUS_PAID, payment: verified};
  const pending = scoped.find((payment) => payment.status === "pending");
  if (pending) return {status: STATUS_PENDING, payment: pending};
  return {status: STATUS_OPEN, payment: null};
}

function buildPeriodCard(args) {
  const {period, year, houseNo, baseAmount, payments, plan} = args;
  const label = commonPeriodLabel(period);
  const shortLabel = commonPeriodLabel(period, true);
  const state = periodPaymentState(payments, period, year);

  if (isPlanActive(plan)) {
    const progress = planProgress(plan);
    const awaitingReview = scopedPayments(payments, period, year)
        .some((payment) => payment.status === STATUS_PENDING);
    return {
      period,
      label,
      shortLabel,
      status: STATUS_INSTALLMENT,
      amountDue: progress.remaining,
      transferAmount: 0,
      paidAt: null,
      receiptNo: "",
      pendingTermNo: null,
      installment: {
        planId: plan.id || "",
        totalAmount: progress.totalAmount,
        paidAmount: progress.paidAmount,
        remaining: progress.remaining,
        percent: progress.percent,
        awaitingReview,
      },
      closedPlan: null,
    };
  }

  if (plan && plan.status === "closed" && state.status !== STATUS_PAID) {
    const {totalAmount, paidAmount, remaining} = planProgress(plan);
    return {
      period,
      label,
      shortLabel,
      status: remaining > 0 ? state.status : STATUS_PAID,
      amountDue: remaining,
      transferAmount: commonSlipAmount(remaining, houseNo),
      paidAt: null,
      receiptNo: "",
      pendingTermNo: null,
      installment: null,
      closedPlan: {totalAmount, paidAmount, remaining},
    };
  }

  return {
    period,
    label,
    shortLabel,
    status: state.status,
    amountDue: state.status === STATUS_PAID ? Number(state.payment.amount) :
      baseAmount,
    transferAmount: commonSlipAmount(baseAmount, houseNo),
    paidAt: state.payment && state.payment.verifiedAt || null,
    receiptNo: state.payment && state.payment.receiptNo || "",
    pendingTermNo: null,
    installment: null,
    closedPlan: null,
  };
}

function buildHouseBilling(args) {
  const {houseNo, year, baseAmount} = args;
  const payments = Array.isArray(args.payments) ? args.payments : [];
  const plans = Array.isArray(args.plans) ? args.plans : [];
  const periods = COMMON_PERIODS.map((period) => buildPeriodCard({
    period,
    year,
    houseNo,
    baseAmount,
    payments,
    plan: plans.find((plan) => plan.period === period &&
      Number(plan.year) === Number(year)) || null,
  }));
  const payableCard = periods.find((card) =>
    card.status === STATUS_OPEN || card.status === STATUS_INSTALLMENT) || null;
  return {
    houseNo,
    year,
    periods,
    payable: payableCard ? payableCard.period : null,
    allPaid: periods.every((card) => card.status === STATUS_PAID),
  };
}

function redactInstallmentBalances(billing) {
  return {
    ...billing,
    requiresPin: true,
    periods: billing.periods.map((card) => card.installment ? {
      ...card,
      amountDue: 0,
      transferAmount: 0,
      installment: null,
    } : card),
  };
}

module.exports = {
  STATUS_INSTALLMENT,
  STATUS_OPEN,
  STATUS_PAID,
  STATUS_PENDING,
  buildHouseBilling,
  buildPeriodCard,
  periodPaymentState,
  redactInstallmentBalances,
};
