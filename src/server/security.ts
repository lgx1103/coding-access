import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = (prefix = 'aca') => `${prefix}_${randomBytes(32).toString('base64url')}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [method, salt, hash] = stored.split(':');
  if (method !== 'scrypt' || !salt || !hash) return false;
  const candidate = await derive(password, salt, 32) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

export class SecretBox {
  private key: Buffer;
  constructor(secret: string) {
    this.key = Buffer.from(secret, 'base64');
    if (this.key.length !== 32) throw new Error('ACA_MASTER_KEY 必须是 base64 编码的 32 字节密钥，请运行 npm run setup');
  }
  seal(value: string, context = 'upstream-key') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
  }
  open(value: string, context = 'upstream-key') {
    const [iv, tag, encrypted] = value.split('.').map(x => Buffer.from(x, 'base64url'));
    if (!iv || !tag || !encrypted) throw new Error('加密数据格式无效');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}

export function redact(value: string, secrets: string[] = []) {
  let output = value;
  for (const secret of secrets) if (secret.length >= 4) output = output.split(secret).join('[redacted]');
  return output.replace(/(?:Bearer\s+)[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|aca_|aca_session_)[a-zA-Z0-9_-]+/g, '[redacted]')
    .slice(0, 600);
}
