// SIT (black-box system integration) against the DEPLOYED functions.
// Hits real HTTP endpoints — tests the integrated stack (HTTP -> auth ->
// Firestore -> response) without a local emulator. Only exercises negative
// / contract / security paths that need no secrets or committee PIN; the
// authenticated happy paths (real OCR, valid login, image fetch) are covered
// in UAT on the LINE staging group.
//
// Run: npm run test:sit

const BASE = "https://asia-southeast1-pattra8-54c3f.cloudfunctions.net";
const ADMIN = `${BASE}/visitorIntakeAdmin`;
const WEBHOOK = `${BASE}/lineWebhook`;

let pass = 0;
let fail = 0;

async function check(id, desc, fn) {
  try {
    await fn();
    console.log(`  ✔ ${id}  ${desc}`);
    pass += 1;
  } catch (err) {
    console.log(`  ✖ ${id}  ${desc}\n      -> ${err.message}`);
    fail += 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log("\nSIT: visitorIntakeAdmin");

  await check("SIT-BB-01", "OPTIONS preflight -> 204 + CORS header", async () => {
    const r = await fetch(ADMIN, {method: "OPTIONS"});
    assert(r.status === 204, `expected 204, got ${r.status}`);
    assert(r.headers.get("access-control-allow-origin") !== null,
        "missing Access-Control-Allow-Origin");
  });

  await check("SIT-BB-02", "GET -> 405 Method Not Allowed", async () => {
    const r = await fetch(ADMIN, {method: "GET"});
    assert(r.status === 405, `expected 405, got ${r.status}`);
  });

  await check("SIT-BB-03", "POST bogus house/PIN -> not 200, ok:false",
      async () => {
        const r = await fetch(ADMIN, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(
              {action: "list", houseNo: "38/8", pin: "000000"}),
        });
        assert(r.status !== 200, `expected non-200, got ${r.status}`);
        const body = await r.json().catch(() => ({}));
        assert(body.ok === false, "expected {ok:false}");
        assert([401, 403].includes(r.status),
            `expected 401/403, got ${r.status}`);
      });

  await check("SIT-BB-04", "POST empty creds -> rejected", async () => {
    const r = await fetch(ADMIN, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({action: "list"}),
    });
    assert(r.status !== 200, `expected non-200, got ${r.status}`);
    const body = await r.json().catch(() => ({}));
    assert(body.ok === false, "expected {ok:false}");
  });

  console.log("\nSIT: lineWebhook");

  await check("SIT-BB-07", "GET -> 405", async () => {
    const r = await fetch(WEBHOOK, {method: "GET"});
    assert(r.status === 405, `expected 405, got ${r.status}`);
  });

  await check("SIT-BB-08", "POST without signature -> 401", async () => {
    const r = await fetch(WEBHOOK, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({events: []}),
    });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  await check("SIT-BB-09", "POST with forged signature -> 401", async () => {
    const r = await fetch(WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-line-signature": "forged-signature-not-valid",
      },
      body: JSON.stringify({events: []}),
    });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  console.log(`\nSIT result: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
