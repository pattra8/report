"use strict";

const ADMIN_PERMISSION_KEYS = Object.freeze([
  "admin.portal",
  "admin.residents",
  "admin.pins",
  "admin.vote",
  "admin.survey",
  "admin.announcements",
  "admin.pickup",
  "admin.issues",
  "admin.audit",
  "expense.view",
  "expense.manage",
  "insurance.view",
  "insurance.manage",
  "blueprints.view",
  "blueprints.manage",
]);

const ADMIN_ACCESS_DEFAULTS = Object.freeze({
  "38/8": Object.freeze({
    roleLabel: "ประธานกรรมการ",
    permissions: Object.freeze(Object.fromEntries(
        ADMIN_PERMISSION_KEYS.map((key) => [key, true]),
    )),
  }),
  "38/38": Object.freeze({
    roleLabel: "กรรมการ",
    permissions: Object.freeze({
      "expense.view": true,
      "insurance.view": true,
      "blueprints.view": true,
    }),
  }),
});

/**
 * Returns a complete permission map containing only explicit boolean grants.
 * @param {Object} permissions Stored or default permissions.
 * @return {Object<string, boolean>}
 */
function normalizeAdminPermissions(permissions = {}) {
  return Object.fromEntries(
      ADMIN_PERMISSION_KEYS.map((key) => [key, permissions[key] === true]),
  );
}

module.exports = {
  ADMIN_ACCESS_DEFAULTS,
  ADMIN_PERMISSION_KEYS,
  normalizeAdminPermissions,
};

