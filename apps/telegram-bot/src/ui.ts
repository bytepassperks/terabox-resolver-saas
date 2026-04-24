import type { InlineKeyboardButton } from 'grammy/types';
import type { ResolverResult } from '@trs/shared-types';

/** Formats byte counts the way users expect (KB/MB/GB, 2 sig figs). */
export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

export interface SuccessMessage {
  text: string;
  inlineKeyboard: InlineKeyboardButton[][];
}

export function renderSuccess(result: ResolverResult, remainingCredits: number): SuccessMessage {
  const lines: string[] = [];
  lines.push('🎬 <b>Your file is ready</b>');
  lines.push('');
  if (result.fileName) lines.push(`📄 <b>Name:</b> ${escapeHtml(result.fileName)}`);
  lines.push(`📦 <b>Size:</b> ${formatBytes(result.fileSizeBytes)}`);
  if (result.mimeType) lines.push(`🧬 <b>Type:</b> <code>${escapeHtml(result.mimeType)}</code>`);
  lines.push(`🏷️ <b>Provider:</b> ${result.provider}`);
  lines.push('');
  lines.push(`💰 <b>Credits left:</b> ${remainingCredits}`);

  const buttons: InlineKeyboardButton[][] = [];
  const row: InlineKeyboardButton[] = [];
  if (result.streamUrl) row.push({ text: '▶️ Stream', url: result.streamUrl });
  if (result.downloadUrl) row.push({ text: '⬇️ Download', url: result.downloadUrl });
  if (row.length > 0) buttons.push(row);

  return { text: lines.join('\n'), inlineKeyboard: buttons };
}

export function renderError(code: string, message: string): string {
  return [
    '⚠️ <b>Resolve failed</b>',
    '',
    `<b>Reason:</b> <code>${escapeHtml(code)}</code>`,
    message ? `<i>${escapeHtml(message)}</i>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
