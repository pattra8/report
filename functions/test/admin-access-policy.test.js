"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  ADMIN_ACCESS_DEFAULTS,
  ADMIN_PERMISSION_KEYS,
  normalizeAdminPermissions,
} = require("../domains/auth/admin-access-policy");

test("admin permissions deny missing and non-boolean grants", () => {
  const permissions = normalizeAdminPermissions({
    "admin.portal": true,
    "admin.survey": "true",
    "unknown.permission": true,
  });
  assert.equal(Object.keys(permissions).length, ADMIN_PERMISSION_KEYS.length);
  assert.equal(permissions["admin.portal"], true);
  assert.equal(permissions["admin.survey"], false);
  assert.equal("unknown.permission" in permissions, false);
});

test("default admin access policy remains stable", () => {
  const chair = ADMIN_ACCESS_DEFAULTS["38/8"];
  const committee = ADMIN_ACCESS_DEFAULTS["38/38"];
  assert.equal(chair.roleLabel, "ประธานกรรมการ");
  assert.equal(
      Object.values(chair.permissions).every((value) => value === true),
      true,
  );
  assert.deepEqual(committee.permissions, {
    "expense.view": true,
    "insurance.view": true,
    "blueprints.view": true,
  });
});
