import type { Logger } from '@trs/logger';
import { starsWebhookFailures } from '@trs/metrics';
import type { StarsPaymentEvent } from '@trs/shared-types';
import type { Pool } from 'pg';
import type { CreditsService } from './credits-service.js';
import { planFromInvoicePayload } from './plans.js';

export interface StarsHandlerOptions {
  pg: Pool;
  credits: CreditsService;
  log: Logger;
}

/**
 * Idempotent Telegram Stars settlement. Telegram will retry successful_payment
 * webhook deliveries on transient 5xxs, so we persist the charge ID first and
 * reject duplicates before touching user balances.
 */
export class StarsHandler {
  constructor(private readonly opts: StarsHandlerOptions) {}

  async handle(event: StarsPaymentEvent): Promise<{ credited: boolean; reason: string }> {
    try {
      const inserted = await this.opts.pg.query(
        `INSERT INTO stars_events
          (telegram_charge_id, provider_payment_charge_id, telegram_user_id,
           amount_stars, payload, received_at, processed)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), FALSE)
         ON CONFLICT (telegram_charge_id) DO NOTHING`,
        [
          event.telegramChargeId,
          event.providerPaymentChargeId,
          event.telegramUserId,
          event.amountStars,
          event.payload,
          event.receivedAtMs,
        ],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        starsWebhookFailures.inc({ reason: 'duplicate' });
        return { credited: false, reason: 'duplicate' };
      }

      const plan = planFromInvoicePayload(event.payload);
      if (!plan) {
        starsWebhookFailures.inc({ reason: 'unknown_plan' });
        this.opts.log.warn({ event }, 'stars: invoice payload did not map to a plan');
        return { credited: false, reason: 'unknown_plan' };
      }
      if (event.amountStars < plan.stars) {
        starsWebhookFailures.inc({ reason: 'amount_mismatch' });
        this.opts.log.warn({ event, expectedStars: plan.stars }, 'stars: amount mismatch');
        return { credited: false, reason: 'amount_mismatch' };
      }

      const user = await this.opts.credits.ensureUser(event.telegramUserId);
      await this.opts.credits.grant({
        userId: user.userId,
        idempotencyKey: `stars:${event.telegramChargeId}`,
        amount: plan.credits,
        source: 'stars_payment',
        reason: `Stars purchase of plan ${plan.id}`,
        plan: plan.id,
        metadata: { planId: plan.id, stars: event.amountStars },
      });

      await this.opts.pg.query(`UPDATE stars_events SET processed = TRUE WHERE telegram_charge_id = $1`, [
        event.telegramChargeId,
      ]);

      return { credited: true, reason: 'ok' };
    } catch (err) {
      starsWebhookFailures.inc({ reason: 'exception' });
      this.opts.log.error({ err, event }, 'stars: handler failed');
      throw err;
    }
  }
}
