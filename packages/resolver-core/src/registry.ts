import type { ProviderId } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from './adapter.js';

/**
 * Map of provider id → adapter. Adapters register at gateway-construction
 * time; the registry is intentionally dumb (no ordering logic here — that
 * lives in `FallbackChain`).
 */
export class AdapterRegistry {
  private readonly adapters = new Map<ProviderId, ResolverAdapter>();

  register(adapter: ResolverAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): ResolverAdapter {
    const a = this.adapters.get(id);
    if (!a) {
      throw new ResolverError({
        code: 'PROVIDER_DISABLED',
        message: `No adapter registered for provider '${id}'`,
        refundable: true,
        retriable: false,
      });
    }
    return a;
  }

  has(id: ProviderId): boolean {
    return this.adapters.has(id);
  }

  list(): ResolverAdapter[] {
    return Array.from(this.adapters.values());
  }
}
