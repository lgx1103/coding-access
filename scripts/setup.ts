import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { serviceBaseUrl } from '../src/shared/service-url.js';

const docker = process.argv[2] === '--docker';
if (process.argv.length > 2 && (!docker || process.argv.length !== 4)) throw new Error('用法：setup.js，或 setup.js --docker http://服务器内网IP:4317');
const publicUrl = docker ? serviceBaseUrl(process.argv[3]) : 'http://127.0.0.1:4317';
const url = new URL(publicUrl);
if (docker && url.protocol !== 'http:') throw new Error('Docker 直接部署请使用 HTTP；HTTPS 需另行配置反向代理证书');
if (docker && !isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Docker 初始化请填写服务器内网 IP；域名可在初始化后修改 ACA_PUBLIC_URL');
if (existsSync('.env') || existsSync('.local/access.sqlite') || existsSync('.local/initial-credentials.txt')) throw new Error('已有配置、数据库或初始账号文件，请按维护手册迁移；初始化不会覆盖已有数据。');
mkdirSync('.local', { recursive: true, mode: 0o700 });
const password = randomBytes(18).toString('base64url');
const key = randomBytes(32).toString('base64');
writeFileSync('.env', [
  'ACA_COMPANY_NAME="Coding Access"', 'ACA_HOST=127.0.0.1', 'ACA_PORT=4317',
  `ACA_PUBLIC_URL=${publicUrl}`, 'ACA_DB_PATH=.local/access.sqlite',
  `ACA_MASTER_KEY=${key}`, 'ACA_ADMIN_USERNAME=admin', `ACA_ADMIN_PASSWORD=${password}`,
  `NODE_ENV=${docker ? 'production' : 'development'}`,
  ...(docker ? [`ACA_BIND_ADDRESS=${url.hostname}`, `ACA_PUBLIC_PORT=${url.port || (url.protocol === 'https:' ? '443' : '80')}`] : []), '',
].join('\n'), { mode: 0o600, flag: 'wx' });
writeFileSync('.local/initial-credentials.txt', `首次管理员账号：admin\n首次管理员密码：${password}\n请登录后修改初始密码。备份 .env 与数据库，妥善保存其中的加密密钥。\n`, { mode: 0o600, flag: 'wx' });
if (docker) {
  mkdirSync('release', { recursive: true });
  // Installer archives are public files; a restrictive root umask must not block UID 1000.
  chmodSync('release', 0o755);
  // Docker initialization runs as container root so the long-running node user
  // can read its environment and write the new database in the bind mount.
  if (process.getuid?.() === 0) for (const path of ['.env', '.local', '.local/initial-credentials.txt']) chownSync(path, 1000, 1000);
}
process.stdout.write('初始化完成。初始账号信息保存在 .local/initial-credentials.txt。\n' + (docker ? '运行 docker compose --env-file .env -f deploy/compose.yaml up -d --build 启动。\n' : '运行 npm run dev 开始本地开发；构建后可用 npm start 启动。\n'));
