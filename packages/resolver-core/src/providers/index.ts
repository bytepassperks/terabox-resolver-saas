export * from './terabox/index.js';
export * from './gofile/index.js';
export * from './pixeldrain/index.js';
export * from './buzzheavier/index.js';
export * from './placeholders.js';

import type { AdapterRegistry } from '../registry.js';
import { teraboxAdapter } from './terabox/index.js';
import { gofileAdapter } from './gofile/index.js';
import { pixeldrainAdapter } from './pixeldrain/index.js';
import { buzzheavierAdapter } from './buzzheavier/index.js';
import {
  drivePlaceholder,
  dropboxPlaceholder,
  krakenfilesPlaceholder,
  mediafirePlaceholder,
  onedrivePlaceholder,
  sendcmPlaceholder,
  workuploadPlaceholder,
} from './placeholders.js';

/**
 * Registers every known adapter (active + inactive) with the registry so the
 * gateway can route URLs to them. Adding a new provider is one import + one
 * `.register()` line here.
 */
export function registerAllProviders(registry: AdapterRegistry): void {
  // Active adapters
  registry.register(teraboxAdapter);
  registry.register(pixeldrainAdapter);
  registry.register(gofileAdapter);
  registry.register(buzzheavierAdapter);
  // Placeholder adapters (pending full implementation)
  registry.register(drivePlaceholder);
  registry.register(dropboxPlaceholder);
  registry.register(onedrivePlaceholder);
  registry.register(mediafirePlaceholder);
  registry.register(krakenfilesPlaceholder);
  registry.register(workuploadPlaceholder);
  registry.register(sendcmPlaceholder);
}
