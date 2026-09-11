import 'dotenv/config';
import { resolve } from 'node:path';
import { createBackup } from '../src/server/backup.js';
const target = resolve(process.argv[2] ?? `.local/backups/${new Date().toISOString().replaceAll(':', '-')}`);
createBackup(resolve(process.env.ACA_DB_PATH ?? '.local/access.sqlite'), resolve('.env'), target);
process.stdout.write(`备份完成：${target}\n此目录包含加密主密钥，请存入公司受控备份位置。\n`);
