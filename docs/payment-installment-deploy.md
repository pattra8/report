# Payment installment deployment

The installment feature uses a running balance: `totalAmount - paidAmount`.
There is no monthly schedule. A resident may upload any positive amount, and
the balance changes only after a committee member reviews and verifies it.

## Safe deployment order

1. Deploy the canonical Cloud Function from `Pattra Report/` first:

   ```sh
   firebase deploy --only functions:pattraPay
   ```

2. Confirm that `houseBilling` exists before publishing the web build:

   ```sh
   curl -sS \
     https://asia-southeast1-pattra8-54c3f.cloudfunctions.net/pattraPay \
     -H 'Content-Type: application/json' \
     --data '{"action":"houseBilling","houseNo":1}'
   ```

   The response must contain `"ok":true`. Do not use a real resident PIN in
   command history or deployment notes.

3. Build the React app from `pattra8-pay/`:

   ```sh
   npm run build
   ```

4. Publish the generated single-file app to both active routes in the static
   site repository:

   - `dist/index.html` to `/paystatus/index.html`
   - `dist/upload-slip/index.html` to `/upload-slip/index.html`

The upload page includes a legacy fallback, so a temporary `houseBilling`
failure does not block residents from sending an H2 slip. The fallback does
not display or guess installment balances.

## Production checks

- A normal house can upload a slip without a PIN.
- An installment house can also upload without a PIN, but must enter its own
  six-digit PIN to see total, paid, percentage, and remaining balance.
- A failed OCR result enters the admin queue with amount zero; approval stays
  disabled until the committee enters a positive reviewed amount.
- Verifying once updates the payment, receipt counter, and plan balance in one
  Firestore transaction. Repeating the same verification must not add money a
  second time.
- The dashboard shows installment houses separately and does not classify a
  partial payment as fully paid.

## Verification commands

From `Pattra Report/`:

```sh
npm --prefix functions run lint
npm --prefix functions test
```

From `pattra8-pay/`:

```sh
npm run build
```

## Rollback

Roll back the static pages first. Existing installment documents and verified
payment records remain valid ledger data. Do not delete them. If the function
must also be rolled back, stop creating or verifying installment payments until
the running-balance version is restored, because the legacy verifier does not
apply plan balances.
