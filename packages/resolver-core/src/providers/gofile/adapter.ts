import { request } from 'undici';
import type { ResolverContext, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from '../../adapter.js';

interface GofileAccountResponse {
  status: string;
  data: { token: string };
}

interface GofileContentChild {
  id: string;
  name: string;
  size: number;
  mimetype?: string;
  link?: string;
  thumbnail?: string;
  type: 'file' | 'folder';
}

interface GofileContentResponse {
  status: string;
  data: {
    id: string;
    name: string;
    type: string;
    children?: Record<string, GofileContentChild>;
  };
}

let cachedWebsiteToken = '';
let cachedWebsiteTokenTs = 0;
const WEBSITE_TOKEN_TTL_MS = 15 * 60 * 1000;

async function getWebsiteToken(signal: AbortSignal): Promise<string> {
  if (cachedWebsiteToken && Date.now() - cachedWebsiteTokenTs < WEBSITE_TOKEN_TTL_MS) {
    return cachedWebsiteToken;
  }
  const res = await request('https://gofile.io/dist/js/alljs.js', {
    method: 'GET',
    signal,
  });
  const js = await res.body.text();
  const match = /fetchData\.wt\s*=\s*["']([^"']+)["']/.exec(js);
  if (!match?.[1]) {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: 'Could not extract GoFile website token',
      provider: 'gofile',
      refundable: true,
      retriable: true,
    });
  }
  cachedWebsiteToken = match[1];
  cachedWebsiteTokenTs = Date.now();
  return cachedWebsiteToken;
}

async function createGuestAccount(signal: AbortSignal): Promise<string> {
  const res = await request('https://api.gofile.io/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal,
  });
  const json = (await res.body.json()) as GofileAccountResponse;
  if (json.status !== 'ok' || !json.data?.token) {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: 'GoFile createAccount failed',
      provider: 'gofile',
      refundable: true,
      retriable: true,
    });
  }
  return json.data.token;
}

export const gofileAdapter: ResolverAdapter = {
  id: 'gofile',
  capabilities: {
    active: true,
    supportsStream: true,
    supportsDownload: true,
    supportsThumbnail: false,
  },

  canHandle(url: URL): boolean {
    return /(^|\.)gofile\.io$/i.test(url.hostname);
  },

  extractShareId(url: URL): string | null {
    const m = /\/d\/([A-Za-z0-9]+)/.exec(url.pathname);
    return m?.[1] ?? null;
  },

  async resolve(url: URL, _ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    const shareId = this.extractShareId(url);
    if (!shareId) {
      throw new ResolverError({
        code: 'INVALID_SHARE_LINK',
        message: 'GoFile URL did not contain a content id',
        provider: 'gofile',
        refundable: true,
        retriable: false,
      });
    }

    const [token, wt] = await Promise.all([
      createGuestAccount(signal),
      getWebsiteToken(signal),
    ]);

    const res = await request(
      `https://api.gofile.io/contents/${shareId}?wt=${wt}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        signal,
      },
    );

    if (res.statusCode === 404 || res.statusCode === 401) {
      throw new ResolverError({
        code: 'CONTENT_NOT_FOUND',
        message: 'GoFile content not found or access denied',
        provider: 'gofile',
        refundable: true,
        retriable: false,
      });
    }

    if (res.statusCode >= 500) {
      throw new ResolverError({
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: `GoFile HTTP ${res.statusCode}`,
        provider: 'gofile',
        refundable: true,
        retriable: true,
      });
    }

    const json = (await res.body.json()) as GofileContentResponse;

    if (json.status === 'error-passwordRequired') {
      throw new ResolverError({
        code: 'CONTENT_PASSWORD_PROTECTED',
        message: 'GoFile content is password protected',
        provider: 'gofile',
        refundable: true,
        retriable: false,
      });
    }

    if (json.status !== 'ok' || !json.data) {
      throw new ResolverError({
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: `GoFile API error: ${json.status}`,
        provider: 'gofile',
        refundable: true,
        retriable: true,
      });
    }

    const children = json.data.children;
    if (!children || Object.keys(children).length === 0) {
      throw new ResolverError({
        code: 'CONTENT_NOT_FOUND',
        message: 'GoFile folder is empty',
        provider: 'gofile',
        refundable: true,
        retriable: false,
      });
    }

    const firstFile = Object.values(children).find((c) => c.type === 'file');
    if (!firstFile) {
      throw new ResolverError({
        code: 'CONTENT_NOT_FOUND',
        message: 'GoFile folder has no files',
        provider: 'gofile',
        refundable: true,
        retriable: false,
      });
    }

    const dl = firstFile.link ?? null;
    const mime = firstFile.mimetype ?? null;
    const isStreamable = mime ? mime.startsWith('video/') || mime.startsWith('audio/') : false;

    return {
      provider: 'gofile',
      shareId,
      fileName: firstFile.name,
      fileSizeBytes: firstFile.size ?? null,
      mimeType: mime,
      thumbnailUrl: firstFile.thumbnail ?? null,
      streamUrl: isStreamable && dl ? dl : null,
      downloadUrl: dl,
      expiresAtMs: null,
      cached: false,
      raw: { contentId: shareId, token },
    };
  },
};
