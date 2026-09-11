import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
import { hashPassword, SecretBox } from './security.js';
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const privateFile = (file: string) => { if (process.platform !== 'win32') chmodSync(file, 0o600); };

export function createBackup(database: string, environment: string, destination: string) {
  if (!existsSync(database) || !existsSync(environment)) throw new Error('数据库或 .env 不存在，请检查备份来源');
  if (existsSync(destination)) throw new Error('备份目标已存在，请选择新的空目录');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  // A read-only connection avoids Store's startup recovery and produces a consistent WAL snapshot.
  const db = new DatabaseSync(database, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(resolve(destination, 'database.sqlite')); } finally { db.close(); }
  copyFileSync(environment, join(destination, '.env')); privateFile(join(destination, '.env')); privateFile(join(destination, 'database.sqlite'));
  const manifest = { format: 1, createdAt: new Date().toISOString(), files: { 'database.sqlite': sha(join(destination, 'database.sqlite')), '.env': sha(join(destination, '.env')) } };
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 }); return manifest;
}

export async function restoreBackup(source: string, database: string, environment: string) {
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || ['database.sqlite', '.env'].some(file => manifest.files?.[file] !== sha(join(source, file)))) throw new Error('备份校验失败，文件缺失或内容已变化');
  const settings = parse(readFileSync(join(source, '.env'))); const box = new SecretBox(settings.ACA_MASTER_KEY ?? '');
  const adminUsername = settings.ACA_ADMIN_USERNAME ?? 'admin'; const newPassword = randomBytes(18).toString('base64url');
  const temp = `${database}.restore-${randomBytes(5).toString('hex')}`; mkdirSync(dirname(database), { recursive: true, mode: 0o700 }); copyFileSync(join(source, 'database.sqlite'), temp);
  const db = new DatabaseSync(temp);
  try {
    if ((db.prepare('PRAGMA integrity_check').get() as any)?.integrity_check !== 'ok') throw new Error('数据库完整性校验失败');
    for (const row of db.prepare('SELECT data FROM keys').all() as any[]) box.open(JSON.parse(row.data).encryptedSecret);
    const users = (db.prepare('SELECT data FROM users').all() as any[]).map(r => JSON.parse(r.data));
    if (!users.some(u => u.username === adminUsername && u.role === 'admin')) throw new Error('备份中不存在指定恢复管理员');
    const passwordHash = await hashPassword(newPassword);
    db.exec('BEGIN IMMEDIATE');
    for (const user of users) {
      const primary = user.username === adminUsername && user.role === 'admin'; user.enabled = primary;
      if (primary) { user.passwordHash = passwordHash; user.mustChangePassword = true; }
      db.prepare('UPDATE users SET data=? WHERE id=?').run(JSON.stringify(user), user.id);
    }
    db.exec("UPDATE tokens SET revoked=1; UPDATE requests SET status='interrupted',error_code='backup_restore' WHERE status='running'; UPDATE attempts SET status='interrupted',ambiguous=1,code='backup_restore' WHERE status='running'; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) { db.close(); if (existsSync(temp)) unlinkSync(temp); throw error; }
  db.close();
  // Caller stops the server first. Preserve existing files before replacing either file.
  const previous = join(dirname(database), `before-restore-${Date.now()}`);
  if (existsSync(database) && existsSync(environment)) createBackup(database, environment, previous);
  for (const suffix of ['-wal', '-shm']) if (existsSync(database + suffix)) unlinkSync(database + suffix);
  renameSync(temp, database); privateFile(database);
  settings.ACA_DB_PATH = resolve(database); settings.ACA_ADMIN_PASSWORD = newPassword;
  const text = Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  mkdirSync(dirname(environment), { recursive: true, mode: 0o700 }); writeFileSync(environment, text, { mode: 0o600 }); privateFile(environment);
  const credentials = join(dirname(database), 'restore-credentials.txt'); writeFileSync(credentials, `恢复管理员：${adminUsername}\n临时密码：${newPassword}\n首次登录后修改密码，并审核后重新启用仍在职的成员。历史凭证已全部撤销。\n`, { mode: 0o600 }); privateFile(credentials);
  return { credentials, previous: existsSync(previous) ? previous : null, adminUsername };
}
