# Telegram Stars integration

Telegram Stars uses the in-app currency code `XTR`. Stars invoices **do not**
require an external payment provider token — BotFather handles settlement.

## Flow

```
user taps /buy
   ▼
bot sends ctx.answerCallbackQuery() + sendInvoice({
   currency: 'XTR',
   prices: [{ label, amount: plan.stars }],
   payload: JSON.stringify({ planId, credits }),
})
   ▼
Telegram shows the Stars confirmation sheet
   ▼
pre_checkout_query → bot verifies planId + amount
   ▼
successful_payment → StarsHandler.handle()
   ├─ INSERT INTO stars_events ON CONFLICT DO NOTHING   (idempotency)
   ├─ plan = planFromInvoicePayload(payload)
   ├─ CreditsService.grant({ idempotencyKey: `stars:${charge_id}`, plan })
   └─ UPDATE stars_events SET processed = TRUE
```

Retries by Telegram are safe: `stars_events.telegram_charge_id` is the primary
key, so duplicate deliveries short-circuit before touching balances.

## Pricing

Defined in `packages/credits-engine/src/plans.ts`. Tweak `credits` and `stars`
per plan; `validityDays` sets the rate-tier expiry.

## Refunds

Telegram Stars refunds are operator-initiated via BotFather. When a refund
fires, use the admin API:

```
POST /admin/credits/adjust
{ "userId": "<uuid>", "delta": -<credits>, "reason": "stars refund" }
```

The mutation is recorded in `credit_mutations` with `source=admin_adjustment`,
so financial reconciliation can match it against Telegram's refund receipt.
