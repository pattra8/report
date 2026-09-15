// Post-deploy smoke test — quick liveness check of the functions we touched.
// Safe to run anytime (read-only, no state change, no secrets). Use it right
// after a deploy and as a periodic go-live health check.
//
// Run: npm run smoke

const BASE = "https://asia-southeast1-pattra8-54c3f.cloudfunctions.net";

// [name, url, method, headers, body, expectStatus]
const CHECKS = [
  ["visitorIntakeAdmin (CORS alive)", `${BASE}/visitorIntakeAdmin`,
    "OPTIONS", {}, null, 204],
  ["visitorIntakeAdmin (auth gate alive)", `${BASE}/visitorIntakeAdmin`,
    "POST", {"Content-Type": "application/json"},
    JSON.stringify({action: "list"}), [401, 403]],
  ["lineWebhook (sig gate alive)", `${BASE}/lineWebhook`,
    "POST", {"Content-Type": "application/json"},
    JSON.stringify({events: []}), 401],
  ["dailyTrafficReport / lprlog (auth gate alive)",
    `${BASE}/dailyTrafficReport`,
    "POST", {"Content-Type": "application/json"},
    JSON.stringify({action: "dailyLog"}), [400, 401, 403]],
];

const TIMEOUT_MS = 10000;

async function ping(url, method, headers, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const r = await fetch(url, {method, headers, body, signal: ctrl.signal});
    return {status: r.status, ms: Date.now() - start};
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  console.log(`\nSmoke test @ ${new Date().toISOString()}`);
  let fail = 0;
  for (const [name, url, method, headers, body, want] of CHECKS) {
    try {
      const {status, ms} = await ping(url, method, headers, body);
      const ok = Array.isArray(want) ? want.includes(status) : status === want;
      const slow = ms > 5000 ? " ⚠ slow" : "";
      console.log(
          `  ${ok ? "✔" : "✖"} ${name} — ${status} (${ms}ms)${slow}`);
      if (!ok) {
        fail += 1;
        console.log(`      expected ${JSON.stringify(want)}`);
      }
    } catch (err) {
      fail += 1;
      console.log(`  ✖ ${name} — ERROR ${err.message}`);
    }
  }
  console.log(
      `\n${fail ? "❌" : "✅"} ${CHECKS.length - fail}/${CHECKS.length} healthy\n`);
  process.exit(fail ? 1 : 0);
}

main();
