import type { ProviderId } from './providers.js';

/**
 * Discriminated error taxonomy. Every failure mode the resolver can produce
 * falls under one of these codes; consumers can branch on `code` without
 * string-matching messages.
 */
export type ResolverErrorCode =
  | 'UNSUPPORTED_URL'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_AUTH_EXPIRED'
  | 'PROVIDER_UPSTREAM_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'CIRCUIT_OPEN'
  | 'INVALID_SHARE_LINK'
  | 'CONTENT_NOT_FOUND'
  | 'CONTENT_PASSWORD_PROTECTED'
  | 'INVALID_PASSWORD'
  | 'INTERNAL_ERROR';

export interface ResolverErrorDetails {
  code: ResolverErrorCode;
  message: string;
  provider?: ProviderId;
  /** True if the caller should NOT be charged credits for this failure. */
  refundable: boolean;
  /** True if the gateway should advance to the next adapter in the chain. */
  retriable: boolean;
  cause?: unknown;
}

export class ResolverError extends Error {
  public readonly code: ResolverErrorCode;
  public readonly provider: ProviderId | undefined;
  public readonly refundable: boolean;
  public readonly retriable: boolean;
  public override readonly cause?: unknown;

  constructor(details: ResolverErrorDetails) {
    super(details.message);
    this.name = 'ResolverError';
    this.code = details.code;
    this.provider = details.provider;
    this.refundable = details.refundable;
    this.retriable = details.retriable;
    this.cause = details.cause;
  }

  static is(err: unknown): err is ResolverError {
    return err instanceof ResolverError;
  }

  toJSON(): Omit<ResolverErrorDetails, 'cause'> {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      refundable: this.refundable,
      retriable: this.retriable,
    };
  }
}
