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
  /** Full share URL id including leading "1" (e.g. `1_uvqm1xGk4aGyGun22X8CQ`). */
  shortUrl: string;
  /** sign + timestamp from shorturlinfo / password verify – required for download. */
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

export interface TeraboxVerifyPasswordResponse {
  errno: number;
  sign?: string;
  timestamp?: number;
}

export interface TeraboxShortUrlInfoResponse {
  errno: number;
  shareid?: number;
  uk?: number;
  sign?: string;
  timestamp?: number;
  randsk?: string;
  list?: TeraboxFileEntry[];
  title?: string;
  fcount?: number;
}
