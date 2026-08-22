# Booking Ledger

This small library supports a multi-tenant appointment service. Its exported
functions are used by request handlers, so their behavior is part of the public
contract.

## Appointment Lists

`listAppointments(records, tenantId)` returns only non-deleted appointments for
the requested tenant, ordered by `startsAt` ascending. It must not mutate the
input array or its records. A tenant must never observe another tenant's data.

## Check-in Tokens

`rotateCheckinToken(tokens, appointmentId, token, expiresAt, now)` preserves all
history. It deactivates every currently active token for that appointment and
appends one new active token. It must not mutate the input.

`redeemCheckinToken(tokens, tokenId, now)` accepts only an active, unused token
strictly before its expiry. A token is expired when `now >= expiresAt`. Success
marks it used and inactive without deleting history or mutating the input.

## CSV Export

`exportAppointments(rows)` emits a CSV header and one row per appointment.
Cells beginning with optional spaces or tabs followed by `=`, `+`, `-`, or `@`
must be prefixed with an apostrophe before normal CSV quoting. This prevents a
spreadsheet from executing user-controlled formulas.

## Revenue

`summarizeRevenue(orders)` returns `{ paidOrders, netCents }`. Count only orders
whose status is `paid` and which have not been refunded. Monetary values stay
as integer cents.
