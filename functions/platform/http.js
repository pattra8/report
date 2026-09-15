"use strict";

const ALLOWED_ORIGINS = new Set([
  "https://pattra8.com",
  "https://www.pattra8.com",
  "https://pattra8.github.io",
]);
const DEFAULT_ORIGIN = "https://pattra8.com";

/**
 * Applies the legacy HTTP headers used by Pattra static-site clients.
 *
 * Keep this compatibility function stable while handlers are modularized. A
 * future versioned API wrapper can add a normalized response envelope without
 * changing existing clients.
 *
 * @param {*} req Express-compatible request.
 * @param {*} res Express-compatible response.
 * @return {void}
 */
function setCorsHeaders(req, res) {
  const origin = req.get("Origin");
  res.set(
      "Access-Control-Allow-Origin",
      ALLOWED_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN,
  );
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  // Without this the browser re-runs the preflight on nearly every call
  // (Chrome defaults to a 5s preflight cache), adding a cold-start-prone
  // round trip in front of each POST.
  res.set("Access-Control-Max-Age", "3600");
  res.set("Cache-Control", "no-store");
}

/**
 * Applies legacy headers and handles preflight/method rejection consistently.
 * @param {*} req Express-compatible request.
 * @param {*} res Express-compatible response.
 * @param {string[]} methods Allowed non-OPTIONS methods.
 * @return {boolean} True when the handler should continue.
 */
function prepareJsonRequest(req, res, methods = ["POST"]) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return false;
  }
  if (!methods.includes(req.method)) {
    res.status(405).json({ok: false, error: "Method Not Allowed"});
    return false;
  }
  return true;
}

/**
 * Sends the existing unversioned Pattra API error shape.
 * @param {*} res Express-compatible response.
 * @param {*} err Error with an optional numeric status.
 * @return {*} Express response result.
 */
function sendLegacyError(res, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  const message = err && err.message ? err.message : "Internal Server Error";
  return res.status(status).json({ok: false, error: message});
}

module.exports = {
  prepareJsonRequest,
  sendLegacyError,
  setCorsHeaders,
};
