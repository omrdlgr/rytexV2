// Merkezi JWT üretim/doğrulama — tek kaynak.
// Tüm token'lar `jti` (benzersiz kimlik) taşır; logout'ta jti iptal edilir
// ve verifyToken iptal listesini kontrol eder (B7 revocation).
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { JWT_SECRET } from './config.js';
import { revokedTokens } from './db.js';

const TTL = '30d';

export function signToken(sub) {
  return jwt.sign({ sub, jti: randomUUID() }, JWT_SECRET, { expiresIn: TTL });
}

// Geçerli claims döner; imza/expiry hatası veya iptal edilmişse fırlatır.
export function verifyToken(token) {
  const claims = jwt.verify(token, JWT_SECRET); // bozuk/expired → throw
  if (claims.jti && revokedTokens.isRevoked(claims.jti)) {
    throw new Error('token_revoked');
  }
  return claims;
}

// Token'ı iptal et (logout). exp claim'i kadar iptal listesinde tutulur.
export function revokeToken(claims) {
  if (claims?.jti && claims?.exp) {
    revokedTokens.revoke(claims.jti, claims.exp);
  }
}

// Fastify route'ları için ortak Bearer doğrulama. Başarısızsa reply'a
// 401 yazar ve null döner.
export function authenticateRequest(request, reply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing_token' });
    return null;
  }
  try {
    return verifyToken(auth.slice(7));
  } catch {
    reply.code(401).send({ error: 'invalid_token' });
    return null;
  }
}
