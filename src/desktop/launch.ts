import { existsSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentId } from '../shared/types.js';
import { isDesktopAgent } from '../shared/types.js';
import { atomicWrite } from './config.js';
import type { TerminalSession } from './terminal-session.js';

const exec = promisify(execFile);
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export function terminalScript(platform: string, executable: string, project: string, args: string[] = [], bundledNode = false) {
  if (/[\r\n\0]/.test(executable + project + args.join(''))) throw new Error('工具或项目路径包含不支持的控制字符');
  const quote = platform === 'win32' ? powershellQuote : shellQuote;
  const command = [executable, ...args].map(quote).join(' ');
  if (platform === 'win32') {
    const invoke = `& ${command}`;
    return `Set-Location -LiteralPath ${quote(project)}; ` + (bundledNode ? `$acaPreviousNodeMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process'); try { $env:ELECTRON_RUN_AS_NODE = '1'; ${invoke} } finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $acaPreviousNodeMode, 'Process'); Remove-Variable acaPreviousNodeMode }` : invoke);
  }
  return `#!/bin/zsh\ncd -- ${quote(project)} || exit\n${bundledNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${command}\nexec /bin/zsh -l\n`;
}
export function findTool(agent: AgentId, home: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  if (agent === 'zcode') {
    const candidates = platform === 'darwin' ? ['/Applications/ZCode.app', join(home, 'Applications/ZCode.app')]
      : [...(env.ZCODE_WINDOWS_APP_INSTALL_DIR ? [join(env.ZCODE_WINDOWS_APP_INSTALL_DIR, 'ZCode.exe')] : []), join(env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Programs/ZCode/ZCode.exe'), join(env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'ZCode/ZCode.exe'), join(env.ProgramFiles ?? 'C:\\Program Files', 'ZCode/ZCode.exe'), join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'ZCode/ZCode.exe'), ...(env.ProgramW6432 ? [join(env.ProgramW6432, 'ZCode/ZCode.exe')] : [])];
    return candidates.find(p => existsSync(p));
  }
  if (agent === 'codex-desktop') {
    const candidates = platform === 'darwin' ? ['/Applications/Codex.app', join(home, 'Applications/Codex.app')] : [join(env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Programs', 'Codex', 'Codex.exe'), join(env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Codex', 'Codex.exe')];
    return candidates.find(p => existsSync(p));
  }
  const command = agent === 'claude-code' ? 'claude' : 'codex';
  const dirs = [...(env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter), join(home, '.local/bin'), join(home, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(env.APPDATA ?? join(home, 'AppData/Roaming'), 'npm')];
  const nvm = join(home, '.nvm/versions/node'); if (platform !== 'win32' && existsSync(nvm)) for (const version of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, version, 'bin'));
  for (const dir of dirs.filter(Boolean)) for (const suffix of platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
    const path = join(dir, command + suffix); try { if (statSync(path).isFile()) { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return path; } } catch { /* Next known installation directory. */ }
  }
  return undefined;
}
export async function toolVersion(path: string, platform = process.platform) {
  if (path.endsWith('.app') || path.startsWith('appx:')) return null;
  try {
    const result = platform === 'win32' && /\.(cmd|bat)$/i.test(path)
      ? await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`& ${powershellQuote(path)} --version`, 'utf16le').toString('base64')], { timeout: 5000, windowsHide: true, maxBuffer: 4096 })
      : await exec(path, ['--version'], { timeout: 5000, maxBuffer: 4096, windowsHide: true });
    return result.stdout.trim().slice(0, 150);
  } catch { return null; }
}
export async function locateTool(agent: AgentId, home: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const found = findTool(agent, home, env, platform); if (found || agent !== 'codex-desktop' || platform !== 'win32') return found;
  try {
    const result = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Get-StartApps | Where-Object { $_.Name -eq 'Codex' } | Select-Object -First 1 -ExpandProperty AppID"], { timeout: 5000, windowsHide: true, maxBuffer: 4096 });
    const appId = result.stdout.trim(); if (/^[a-zA-Z0-9._-]+![a-zA-Z0-9._-]+$/.test(appId)) return `appx:${appId}`;
  } catch { /* The user can still open their desktop app manually. */ }
  return undefined;
}

export async function zcodeRunning(platform = process.platform) {
  if (platform === 'darwin') {
    try { await exec('/usr/bin/pgrep', ['-x', 'ZCode'], { timeout: 5000 }); return true; }
    catch (error) { if ((error as { code?: number }).code === 1) return false; throw new Error('无法检查 ZCode 运行状态，请稍后重试'); }
  }
  if (platform === 'win32') {
    const result = await exec('tasklist.exe', ['/FI', 'IMAGENAME eq ZCode.exe', '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true, maxBuffer: 16384 });
    return /^"ZCode\.exe"/im.test(result.stdout);
  }
  throw new Error('ZCode 接入当前支持 Windows 与 macOS');
}
function detached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => { const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
}
export async function launchTool(agent: AgentId, executable: string, project: string, stateDirectory: string, platform = process.platform, temporary?: TerminalSession & { runtime: string; runner: string }) {
  if (project && (!existsSync(project) || !statSync(project).isDirectory())) throw new Error('项目目录不存在，请重新选择');
  if (isDesktopAgent(agent)) { if (platform === 'darwin') await exec('/usr/bin/open', ['-a', executable]); else if (executable.startsWith('appx:') && /^[a-zA-Z0-9._-]+![a-zA-Z0-9._-]+$/.test(executable.slice(5))) await detached('explorer.exe', [`shell:AppsFolder\\${executable.slice(5)}`]); else await detached(executable, []); return; }
  if (!project) throw new Error('请先选择项目文件夹');
  const script = temporary ? terminalScript(platform, temporary.runtime, project, [temporary.runner, temporary.payloadPath], true) : terminalScript(platform, executable, project);
  if (platform === 'win32') await detached('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  else if (platform === 'darwin') {
    const file = temporary ? join(temporary.directory, 'launch.command') : join(stateDirectory, 'launch', `${agent}.command`); atomicWrite(file, script);
    const { chmodSync } = await import('node:fs'); chmodSync(file, 0o700); await exec('/usr/bin/open', ['-a', 'Terminal', file]);
  } else throw new Error('首版终端启动支持 Windows 与 macOS');
}
