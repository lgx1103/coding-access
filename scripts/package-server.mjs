import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd(); const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('.local', { recursive: true }); mkdirSync('release', { recursive: true });
const stage = mkdtempSync(resolve('.local/server-package-'));
try {
  for (const file of ['dist/server', 'dist/web', 'dist/scripts', 'docs', 'deploy', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.env.example']) cpSync(resolve(file), join(stage, file), { recursive: true });
  writeFileSync(join(stage, 'README.md'), `# Coding Access 服务端运行包

Linux 已有 Docker + Compose：按 docs/docker-deployment.md 部署，不需要宿主机安装 Node.js。

1. 解压到专用目录，进入该目录。
2. 全新部署执行：sh deploy/docker-init.sh http://服务器内网IP:4317
3. 执行：docker compose --env-file .env -f deploy/compose.yaml up -d --build

迁移已有数据时不要执行全新初始化，先按 Docker 部署手册迁移数据库与配套 .env。

直接运行方式需要 Node.js 22.16+：npm ci --omit=dev，首次执行 node dist/scripts/setup.js，配置 .env 后运行 node dist/server/main.js。详见 docs/deployment.md。

初始账号保存在 .local/initial-credentials.txt。已有部署保留 .env 与 .local。客户端 ZIP 单独分发，源码开发、演示和测试命令请在完整源码项目执行。
`);
  const metadataFlags = process.platform === 'darwin' ? ['--no-xattrs', '--no-acls', '--no-fflags', '--no-mac-metadata'] : [];
  const target = resolve(`release/Coding-Access-${version}-server.tar.gz`); execFileSync('tar', [...metadataFlags, '-czf', target, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }); process.stdout.write(`服务端运行包：${target}\n`);
} finally { rmSync(stage, { recursive: true, force: true }); }
