import { request } from 'undici';
import type { Logger } from '@trs/logger';
import type { ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';

export interface ResolverClientOptions {
  baseUrl: string;
  internalToken: string;
  log: Logger;
}

/**
 * Thin HTTP client for the resolver-api. Kept in the bot app (not in a shared
 * package) because the bot is the only consumer today — other callers (admin
 * UI, partner integrations) would talk directly to the same endpoint.
 */
export class ResolverClient {
  constructor(private readonly opts: ResolverClientOptions) {}

  async resolve(input: {
    url: string;
    telegramUserId: number;
    requestId?: string;
    password?: string;
  }): Promise<ResolverResult> {
    const res = await request(`${this.opts.baseUrl}/v1/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.internalToken}`,
      },
      body: JSON.stringify(input),
    });
    const payload = (await res.body.json()) as
      | { ok: true; result: ResolverResult }
      | { ok: false; error: ReturnType<ResolverError['toJSON']> | string };
    if (!payload.ok) {
      if (typeof payload.error === 'string') {
        throw new ResolverError({
          code: 'INTERNAL_ERROR',
          message: payload.error,
          refundable: true,
          retriable: true,
        });
      }
      throw new ResolverError({ ...payload.error, cause: undefined });
    }
    return payload.result;
  }
}
