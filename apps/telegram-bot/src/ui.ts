import type { InlineKeyboardButton } from 'grammy/types';
import type { ResolverResult } from '@trs/shared-types';
import type { ResolverErrorCode } from '@trs/shared-types';
import { PAID_PLAN_IDS, PLAN_DEFINITIONS } from '@trs/credits-engine';

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

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

// ── Message Interfaces ────────────────────────────────────────────────

export interface BotMessage {
  text: string;
  inlineKeyboard: InlineKeyboardButton[][];
}

// ── /start ────────────────────────────────────────────────────────────

export function renderStart(credits: number): BotMessage {
  const text = [
    '\u{1F44B} <b>Welcome to Universal Link Resolver</b>',
    '',
    'Resolve cloud-share links instantly.',
    '',
    '\u26A1 Fast streaming links',
    '\u{1F512} Secure processing',
    '\u{1F30D} Multi-provider support',
    '',
    '<b>Supported providers:</b>',
    '\u2705 TeraBox \u2022 Pixeldrain \u2022 GoFile',
    '\u2705 Buzzheavier \u2022 MediaFire \u2022 Google Drive',
    '\u2705 OneDrive \u2022 Dropbox \u2022 KrakenFiles',
    '\u{1F6A7} WorkUpload \u2022 Send.cm <i>(coming soon)</i>',
    '',
    `You currently have: <b>${credits}</b> credits`,
  ].join('\n');

  return {
    text,
    inlineKeyboard: [
      [{ text: '\u{1F50D} Resolve Link', callback_data: 'action:resolve' }],
      [
        { text: '\u2B50 Buy Credits', callback_data: 'action:buy' },
        { text: '\u{1F4BC} My Balance', callback_data: 'action:balance' },
      ],
      [
        { text: '\u{1F39F} Redeem Code', callback_data: 'action:redeem' },
        { text: '\u2753 Help', callback_data: 'action:help' },
      ],
    ],
  };
}

// ── /help ─────────────────────────────────────────────────────────────

export function renderHelp(): BotMessage {
  const text = [
    '<b>Universal Link Resolver \u2014 Help</b>',
    '',
    'Send me any supported share link \u2014 I will return a playable / downloadable URL.',
    '',
    '<b>Supported providers:</b>',
    'TeraBox \u2022 Pixeldrain \u2022 GoFile \u2022 Buzzheavier',
    'MediaFire \u2022 Google Drive \u2022 OneDrive \u2022 Dropbox',
    'KrakenFiles \u2022 WorkUpload \u2022 Send.cm',
    '',
    '<b>Commands</b>',
    '/start  \u2014 intro',
    '/help   \u2014 this message',
    '/balance \u2014 show your credit balance',
    '/plan   \u2014 show your current plan',
    '/buy    \u2014 purchase credits with Telegram Stars',
    '/redeem &lt;code&gt; \u2014 redeem a promo code',
    '/resolve &lt;url&gt; \u2014 resolve a share link',
    '/history \u2014 resolve history (coming soon)',
  ].join('\n');

  return {
    text,
    inlineKeyboard: [
      [
        { text: '\u{1F50D} Resolve Link', callback_data: 'action:resolve' },
        { text: '\u{1F3E0} Main Menu', callback_data: 'action:start' },
      ],
    ],
  };
}

// ── /balance ──────────────────────────────────────────────────────────

export function renderBalance(credits: number, plan: string): BotMessage {
  const text = [
    '\u{1F4BC} <b>Your Credit Wallet</b>',
    '',
    `Available credits: <b>${credits}</b>`,
    '',
    `Plan: <b>${plan}</b>`,
    '',
    'Use credits to resolve protected or large files instantly.',
  ].join('\n');

  return {
    text,
    inlineKeyboard: [
      [
        { text: '\u{1F50D} Resolve Link', callback_data: 'action:resolve' },
        { text: '\u2B50 Buy Credits', callback_data: 'action:buy' },
      ],
    ],
  };
}

// ── /buy ──────────────────────────────────────────────────────────────

export function renderBuy(): BotMessage {
  const lines: string[] = ['\u2B50 <b>Choose a credit plan</b>', ''];
  for (const id of PAID_PLAN_IDS) {
    const p = PLAN_DEFINITIONS[id];
    const popular = id === 'pro' ? ' \u{1F525} <i>Most Popular</i>' : '';
    lines.push(`<b>${p.name}</b>${popular}`);
    lines.push(`${p.credits} credits`);
    lines.push(`\u2B50 ${p.stars} Stars`);
    lines.push('');
  }

  const keyboard: InlineKeyboardButton[][] = [
    [
      { text: `Starter \u2014 ${PLAN_DEFINITIONS.starter.stars}\u2B50`, callback_data: 'buy:starter' },
      { text: `Basic \u2014 ${PLAN_DEFINITIONS.basic.stars}\u2B50`, callback_data: 'buy:basic' },
    ],
    [
      { text: `\u{1F525} Pro \u2014 ${PLAN_DEFINITIONS.pro.stars}\u2B50`, callback_data: 'buy:pro' },
      { text: `Power \u2014 ${PLAN_DEFINITIONS.power.stars}\u2B50`, callback_data: 'buy:power' },
    ],
    [{ text: `Ultra \u2014 ${PLAN_DEFINITIONS.ultra.stars}\u2B50`, callback_data: 'buy:ultra' }],
  ];

  return { text: lines.join('\n'), inlineKeyboard: keyboard };
}

// ── Resolve progress ──────────────────────────────────────────────────

export function renderResolvePending(): string {
  return '\u{1F50D} <b>Resolving your link...</b>\n\nPlease wait a few seconds.';
}

export function renderResolveCacheHit(): string {
  return '\u26A1 <b>Found cached result</b>\nPreparing file...';
}

export function renderResolveStillWorking(): string {
  return '\u23F3 Still working on your file...';
}

// ── Resolve success card ──────────────────────────────────────────────

export interface SuccessMessage {
  text: string;
  inlineKeyboard: InlineKeyboardButton[][];
}

const PROVIDER_LABELS: Record<string, string> = {
  terabox: 'TeraBox',
  gofile: 'GoFile',
  pixeldrain: 'Pixeldrain',
  buzzheavier: 'Buzzheavier',
  mediafire: 'MediaFire',
  drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  krakenfiles: 'KrakenFiles',
  workupload: 'WorkUpload',
  sendcm: 'Send.cm',
};

export function renderSuccess(result: ResolverResult, remainingCredits: number): SuccessMessage {
  const lines: string[] = [];
  const providerLabel = PROVIDER_LABELS[result.provider] ?? result.provider;
  lines.push('\u{1F4E6} <b>File Ready</b>');
  lines.push('');
  lines.push(`\u{1F310} Provider: <b>${providerLabel}</b>`);
  if (result.fileName) lines.push(`\u{1F3AC} ${escapeHtml(result.fileName)}`);
  lines.push(`\u{1F4BE} Size: ${formatBytes(result.fileSizeBytes)}`);
  lines.push('');
  lines.push('Your link is ready.');
  lines.push('Choose how you want to continue:');
  lines.push('');
  lines.push(`Credits remaining: <b>${remainingCredits}</b>`);

  const buttons: InlineKeyboardButton[][] = [];
  const row1: InlineKeyboardButton[] = [];
  if (result.streamUrl) row1.push({ text: '\u25B6 Stream Now', url: result.streamUrl });
  if (result.downloadUrl) row1.push({ text: '\u2B07 Download', url: result.downloadUrl });
  if (row1.length > 0) buttons.push(row1);

  if (result.downloadUrl) {
    buttons.push([{ text: '\u{1F4CB} Copy Link', callback_data: `copy:${result.downloadUrl.slice(0, 60)}` }]);
  }

  return { text: lines.join('\n'), inlineKeyboard: buttons };
}

// ── Password flow ─────────────────────────────────────────────────────

export function renderPasswordRequired(): string {
  return [
    '\u{1F510} <b>This link is password protected</b>',
    '',
    'Send the access code to continue.',
  ].join('\n');
}

export function renderPasswordVerifying(): string {
  return '\u{1F50D} <b>Verifying password...</b>\n\nPlease wait a moment.';
}

export function renderPasswordInvalid(): string {
  return [
    '\u274C <b>Incorrect password</b>',
    '',
    'Please try again.',
  ].join('\n');
}

// ── Error messages ────────────────────────────────────────────────────

const ERROR_MAP: Partial<Record<ResolverErrorCode, string>> = {
  CONTENT_PASSWORD_PROTECTED: '\u{1F510} Password required',
  INVALID_PASSWORD: '\u274C Incorrect password',
  PROVIDER_AUTH_EXPIRED: '\u26A0\uFE0F Session expired. Retrying...',
  PROVIDER_TIMEOUT: '\u23F3 Resolver took too long. Try again.',
  UNSUPPORTED_URL: '\u26A0\uFE0F Unsupported link. Supported: TeraBox, Pixeldrain, GoFile, Buzzheavier, MediaFire, Google Drive, OneDrive, Dropbox, KrakenFiles.',
  CONTENT_NOT_FOUND: '\u26A0\uFE0F Content not found or removed',
  PROVIDER_RATE_LIMITED: '\u23F3 Too many requests. Try again shortly.',
  CIRCUIT_OPEN: '\u26A0\uFE0F Provider temporarily unavailable',
  PROVIDER_DISABLED: '\u{1F6A7} This provider is not yet active. Support is coming soon!',
};

export function renderError(code: string, _message: string): string {
  const friendly = ERROR_MAP[code as ResolverErrorCode];
  if (friendly) return friendly;

  return [
    '\u26A0\uFE0F <b>Unable to resolve this link</b>',
    '',
    'Possible reasons:',
    '',
    '\u2022 link expired',
    '\u2022 incorrect password',
    '\u2022 temporary provider issue',
    '',
    'Try again or send another link.',
  ].join('\n');
}

export function renderErrorWithButtons(code: string, message: string, url?: string): BotMessage {
  const text = renderError(code, message);
  const keyboard: InlineKeyboardButton[][] = [];

  if (url) {
    keyboard.push([{ text: '\u{1F501} Retry', callback_data: `retry:${url.slice(0, 60)}` }]);
  }
  keyboard.push([{ text: '\u{1F50D} Resolve Another Link', callback_data: 'action:resolve' }]);

  return { text, inlineKeyboard: keyboard };
}

// ── Credit warnings ───────────────────────────────────────────────────

export function renderNoCredits(): BotMessage {
  const text = [
    '\u{1F381} <b>Daily free limit reached</b>',
    '',
    'Upgrade your credits to continue resolving instantly.',
  ].join('\n');

  return {
    text,
    inlineKeyboard: [[{ text: '\u2B50 Buy Credits', callback_data: 'action:buy' }]],
  };
}

export function renderLowCredits(credits: number): string {
  return [
    `\u26A0\uFE0F <b>Low credits remaining</b> (${credits})`,
    '',
    'Top up now to continue uninterrupted resolving.',
  ].join('\n');
}

// ── Payment success ───────────────────────────────────────────────────

export function renderPaymentSuccess(newBalance: number): BotMessage {
  const text = [
    '\u2705 <b>Credits added successfully</b>',
    '',
    `New balance: <b>${newBalance}</b>`,
    '',
    "You're ready to resolve more links.",
  ].join('\n');

  return {
    text,
    inlineKeyboard: [[{ text: '\u{1F50D} Resolve Link', callback_data: 'action:resolve' }]],
  };
}

// ── History placeholder ───────────────────────────────────────────────

export function renderHistory(): string {
  return '\u{1F4DC} <b>Coming soon</b>';
}

// ── Blocked user ──────────────────────────────────────────────────────

export function renderBlocked(): string {
  return '\u{1F6AB} <b>Your account is blocked.</b>\n\nContact support for assistance.';
}

// ── Persistent keyboard ──────────────────────────────────────────────

export const MAIN_MENU_KEYBOARD: InlineKeyboardButton[][] = [
  [
    { text: '\u{1F50D} Resolve Link', callback_data: 'action:resolve' },
    { text: '\u2B50 Buy Credits', callback_data: 'action:buy' },
  ],
  [
    { text: '\u{1F4BC} Balance', callback_data: 'action:balance' },
    { text: '\u{1F39F} Redeem Code', callback_data: 'action:redeem' },
  ],
  [{ text: '\u2753 Help', callback_data: 'action:help' }],
];
