"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  prepareJsonRequest,
  sendLegacyError,
  setCorsHeaders,
} = require("../platform/http");

/**
 * Builds minimal Express request/response doubles for header assertions.
 * @param {string|undefined} origin Request origin.
 * @return {{req: Object, res: Object, headers: Map<string, string>,
 *   output: Object}}
 */
function httpDoubles(origin) {
  const headers = new Map();
  const output = {};
  const res = {
    set: (name, value) => headers.set(name, value),
    status: (status) => {
      output.status = status;
      return res;
    },
    json: (body) => {
      output.body = body;
      return res;
    },
    send: (body) => {
      output.body = body;
      return res;
    },
  };
  return {
    req: {
      get: (name) => name === "Origin" ? origin : undefined,
    },
    res,
    headers,
    output,
  };
}

test("setCorsHeaders reflects each supported Pattra origin", () => {
  for (const origin of [
    "https://pattra8.com",
    "https://www.pattra8.com",
    "https://pattra8.github.io",
  ]) {
    const {req, res, headers} = httpDoubles(origin);
    setCorsHeaders(req, res);
    assert.equal(headers.get("Access-Control-Allow-Origin"), origin);
  }
});

test("setCorsHeaders keeps the legacy fallback for unknown origins", () => {
  const {req, res, headers} = httpDoubles("https://unknown.example");
  setCorsHeaders(req, res);
  assert.equal(
      headers.get("Access-Control-Allow-Origin"),
      "https://pattra8.com",
  );
});

test("setCorsHeaders preserves the complete compatibility header set", () => {
  const {req, res, headers} = httpDoubles(undefined);
  setCorsHeaders(req, res);
  assert.deepEqual(Object.fromEntries(headers), {
    "Access-Control-Allow-Origin": "https://pattra8.com",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "3600",
    "Cache-Control": "no-store",
  });
});

test("prepareJsonRequest preserves preflight and method contracts", () => {
  const preflight = httpDoubles("https://pattra8.com");
  preflight.req.method = "OPTIONS";
  assert.equal(prepareJsonRequest(preflight.req, preflight.res), false);
  assert.deepEqual(preflight.output, {status: 204, body: ""});

  const invalid = httpDoubles("https://pattra8.com");
  invalid.req.method = "GET";
  assert.equal(prepareJsonRequest(invalid.req, invalid.res), false);
  assert.deepEqual(invalid.output, {
    status: 405,
    body: {ok: false, error: "Method Not Allowed"},
  });

  const valid = httpDoubles("https://pattra8.com");
  valid.req.method = "POST";
  assert.equal(prepareJsonRequest(valid.req, valid.res), true);
  assert.deepEqual(valid.output, {});
});

test("sendLegacyError preserves status and message response shape", () => {
  const known = httpDoubles();
  const err = Object.assign(new Error("Invalid occupants"), {status: 400});
  sendLegacyError(known.res, err);
  assert.deepEqual(known.output, {
    status: 400,
    body: {ok: false, error: "Invalid occupants"},
  });

  const unknown = httpDoubles();
  sendLegacyError(unknown.res, null);
  assert.deepEqual(unknown.output, {
    status: 500,
    body: {ok: false, error: "Internal Server Error"},
  });
});
