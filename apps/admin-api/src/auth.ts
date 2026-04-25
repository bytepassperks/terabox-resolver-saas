import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import {
  ADMIN_PERMISSIONS,
  type AdminJwtPayload,
  type AdminPermission,
  type AdminRole,
} from '@trs/shared-types';

const ALG = 'HS256';

function secretKey(): Uint8Array {
  const s = process.env.ADMIN_JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('ADMIN_JWT_SECRET must be set and at least 32 bytes');
  }
  return new TextEncoder().encode(s);
}

export async function issueAdminJwt(sub: string, role: AdminRole, ttlSeconds = 3600): Promise<string> {
  return await new SignJWT({ role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(sub)
    .setIssuer(process.env.ADMIN_JWT_ISSUER ?? 'terabox-resolver-saas')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey());
}

export async function verifyAdminJwt(token: string): Promise<AdminJwtPayload> {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: process.env.ADMIN_JWT_ISSUER ?? 'terabox-resolver-saas',
  });
  if (!payload.sub) throw new Error('Missing subject');
  const role = payload['role'] as AdminRole | undefined;
  if (!role) throw new Error('Missing role claim');
  return {
    sub: payload.sub,
    role,
    iss: String(payload.iss ?? ''),
    iat: Number(payload.iat ?? 0),
    exp: Number(payload.exp ?? 0),
  };
}

export interface AuthedRequest extends Request {
  admin: AdminJwtPayload;
}

export function requireAdmin(permission?: AdminPermission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(auth);
    if (!match) {
      res.status(401).json({ ok: false, error: 'missing_bearer' });
      return;
    }
    try {
      const payload = await verifyAdminJwt(match[1]!);
      if (permission && !ADMIN_PERMISSIONS[payload.role].includes(permission)) {
        res.status(403).json({ ok: false, error: 'forbidden', required: permission });
        return;
      }
      (req as AuthedRequest).admin = payload;
      next();
    } catch (err) {
      res.status(401).json({ ok: false, error: 'invalid_token', message: (err as Error).message });
    }
  };
}
