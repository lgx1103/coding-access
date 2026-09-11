import 'dotenv/config';
import { PASSWORD_MIN_LENGTH } from '../shared/password-policy.js';
import { Store } from './db.js';
import { createApp } from './app.js';
import { SecretBox, hashPassword, id } from './security.js';

async function main() {
  const secret = process.env.ACA_MASTER_KEY;
  if (!secret) throw new Error('尚未初始化。请先运行 npm run setup，再启动服务。');
  const box = new SecretBox(secret);
  const store = new Store(process.env.ACA_DB_PATH ?? '.local/access.sqlite');
  if (store.users().length === 0) {
    const initialPassword = process.env.ACA_ADMIN_PASSWORD;
    if (!initialPassword || initialPassword.length < PASSWORD_MIN_LENGTH) throw new Error(`首次启动需要配置至少 ${PASSWORD_MIN_LENGTH} 个字符的 ACA_ADMIN_PASSWORD`);
    store.saveUser({ id: id('user'), username: process.env.ACA_ADMIN_USERNAME ?? 'admin', name: '管理员', role: 'admin', enabled: true, mustChangePassword: true, models: [], createdAt: Date.now(), passwordHash: await hashPassword(initialPassword) });
  }
  const port = Number(process.env.ACA_PORT ?? 4317);
  const publicUrl = process.env.ACA_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  const { app } = await createApp({ store, box, publicUrl, companyName: process.env.ACA_COMPANY_NAME, downloadsRoot: process.env.ACA_DOWNLOADS_DIR, development: process.env.NODE_ENV !== 'production', allowInsecureUpstream: process.env.ACA_ALLOW_HTTP_UPSTREAM === '1' });
  await app.listen({ port, host: process.env.ACA_HOST ?? '127.0.0.1' });
  process.stdout.write(`Coding Access 已启动：${publicUrl}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    // Give current work a grace period, then disconnect streams so their leases
    // and request records are released before closing SQLite.
    const force = setTimeout(() => app.server.closeAllConnections(), 15_000);
    force.unref();
    await app.close(); clearTimeout(force); store.close(); process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : '启动失败'}\n`); process.exit(1); });
