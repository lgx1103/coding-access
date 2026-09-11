import { spawn } from 'node:child_process';
import { claimTerminalSession, discardTerminalSession } from './terminal-session.js';
import { powershellQuote } from './launch.js';

// Run with this application's bundled Node runtime; no system Node installation is needed.
async function run() {
  const { directory, command } = claimTerminalSession(process.argv[2] ?? '');
  const cleanup = () => discardTerminalSession(directory);
  process.once('exit', cleanup);
  try {
    const env = { ...process.env, ...command.env }; delete env.ELECTRON_RUN_AS_NODE;
    const batchFile = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.executable);
    const executable = batchFile ? 'powershell.exe' : command.executable;
    const args = batchFile ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`& ${[command.executable, ...command.args].map(powershellQuote).join(' ')}\nexit $LASTEXITCODE`, 'utf16le').toString('base64')] : command.args;
    process.stdout.write(`Coding Access · ${command.label.replace(/[\x00-\x1f\x7f]/g, '')} · 临时会话（默认模型未更改）\n\n`);
    const child = spawn(executable, args, { cwd: command.project, env, stdio: 'inherit' });
    // The foreground CLI receives Ctrl+C too; let it implement its own cancel/exit behavior.
    const interrupt = () => {};
    const terminate = () => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt); process.on('SIGHUP', terminate); process.on('SIGTERM', terminate);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject); child.once('close', code => resolve(code ?? 1));
      });
    } finally { process.off('SIGINT', interrupt); process.off('SIGHUP', terminate); process.off('SIGTERM', terminate); }
  } finally { cleanup(); process.off('exit', cleanup); }
}
void run().catch(() => { process.stderr.write('临时会话启动失败，请检查工具安装和项目目录，然后从客户端重新打开。\n'); process.exitCode = 1; });
