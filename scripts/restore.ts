import 'dotenv/config';
import { resolve } from 'node:path';
import { restoreBackup } from '../src/server/backup.js';
const source = process.argv.find((a, i) => i > 1 && !a.startsWith('--'));
if (!source || !process.argv.includes('--service-stopped')) throw new Error('请先停止服务，再运行 npm run restore -- 备份目录 --service-stopped。恢复会撤销全部历史凭证，并暂停其他成员账号供管理员审核。');
const result = await restoreBackup(resolve(source), resolve(process.env.ACA_DB_PATH ?? '.local/access.sqlite'), resolve('.env'));
process.stdout.write(`恢复完成。临时管理员信息：${result.credentials}\n原数据备份：${result.previous ?? '无现有数据库'}\n启动服务后请修改临时密码，核对仍在职的成员，再逐一启用。\n`);
