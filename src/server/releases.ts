import { accessSync, constants, lstatSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function clientReleases(root: string, version: string) {
  const downloads: { name: string; url: string; size: number; platform: string; arch: string }[] = [];
  let downloadIssue: { code: string; message: string } | undefined;
  const prefix = `Coding-Access-${version}-`;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') downloadIssue = {
      code: 'release_directory_unavailable', message: '安装包目录暂时无法读取，请管理员检查下载目录和访问权限。模型服务不受影响。',
    };
    return { version, downloads, downloadIssue };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !/^(win|mac)-(x64|arm64)\.zip$/.test(entry.name.slice(prefix.length))) continue;
    try {
      const path = resolve(root, entry.name);
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      accessSync(path, constants.R_OK);
      downloads.push({ name: entry.name, url: `/downloads/${entry.name}`, size: stat.size, platform: entry.name.includes('-win-') ? 'Windows' : 'macOS', arch: entry.name.includes('-arm64.') ? 'Apple Silicon' : 'x64' });
    } catch {
      downloadIssue = { code: 'release_file_unavailable', message: '部分安装包暂时无法读取，请管理员检查文件及访问权限。可继续下载下方可用的安装包。' };
    }
  }
  return { version, downloads, downloadIssue };
}
