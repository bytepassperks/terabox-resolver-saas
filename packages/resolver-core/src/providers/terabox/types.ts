/**
 * Raw shapes returned by TeraBox's internal APIs. None of these leak past the
 * `normalize.ts` boundary — they exist solely so `extract.ts` can type-check
 * against what the frontend currently emits. When TeraBox rotates their
 * schema, update ONLY these types and the parser in `extract.ts`.
 */

export interface TeraboxSessionContext {
  jsToken: string;
  logid: string;
  cookies: string;
  /** Short share URL id (e.g. for `surl=1XyZ`, this is `1XyZ`). */
  shortUrl: string;
  /** Optional password-protect token once we support password links. */
  signData?: {
    sign: string;
    timestamp: number;
  };
}

export interface TeraboxFileEntry {
  fs_id: string | number;
  server_filename: string;
  size: number | string;
  md5?: string;
  isdir?: number;
  category?: number;
  thumbs?: { url1?: string; url2?: string; url3?: string };
  dlink?: string;
}

export interface TeraboxShareListResponse {
  errno: number;
  list: TeraboxFileEntry[];
  /** TeraBox sometimes returns `share_id` / `uk` — captured for refresh flows. */
  share_id?: string | number;
  uk?: string | number;
  title?: string;
  server_ctime?: number;
}

export interface TeraboxDownloadResponse {
  errno: number;
  dlink: string;
  /** Seconds until dlink expires (TeraBox uses ~8h today). */
  expiration?: number;
}
