import React, { useEffect, useRef, useState } from 'react';
import { FolderInput, Undo2 } from 'lucide-react';
import { desktop, type DesktopState, type MigrationAgent, type MigrationPreview, type MigrationStatus } from './api';
import { Button, Field, Modal, Notice } from './components';

const agentNames: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI / 桌面版', zcode: 'ZCode' };

/** Normal upgrades are silent. Only show local conflicts, without blocking login. */
export function AutomaticUpgradeNotice({ disabled = false, onChecked }: {
  disabled?: boolean; onChecked?: (state: DesktopState) => void;
}) {
  const [state, setState] = useState<DesktopState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    if (!desktop?.migration) return;
    let active = true;
    desktop.getState().then(s => { if (active) setState(s); }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, []);
  const issues = state?.upgradeIssues ?? [];
  if (!desktop?.migration || state?.development || (!error && !state?.upgradeError && !issues.length)) return null;
  return <Notice error>
    <p>部分旧版配置未能自动接续，当前工具文件未修改。你仍可登录、查看模型和打开临时终端。</p>
    {(error || state?.upgradeError) && <p>{error || state?.upgradeError}</p>}
    {issues.map(a => <p key={a.agent}><strong>{agentNames[a.agent] || a.agent}：</strong>{a.message}</p>)}
    <p>旧工具记录有冲突或缺少备份时，可直接启用模型，客户端会先备份当前文件。也可重新检查旧记录，无需退出登录。</p>
    <button type="button" className="text-button" disabled={disabled || busy} onClick={() => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setError('');
      void desktop!.migration!.retry().then(s => { setState(s); onChecked?.(s); })
        .catch(e => setError((e as Error).message))
        .finally(() => { pending.current = false; setBusy(false); });
    }}>{busy ? '正在检查…' : '重新检查本地配置'}</button>
  </Notice>;
}

function AgentList({ agents, imported }: { agents: MigrationAgent[]; imported?: boolean }) {
  return <ul className="migration-agents">{agents.map(a => <li key={a.agent}>
    <div><strong>{agentNames[a.agent] || a.agent}</strong><span className={a.status === 'ready' ? 'migration-ready' : 'migration-skipped'}>{a.status === 'ready' ? (imported ? '已导入' : '可导入') : '已跳过'}</span></div>
    <p>{a.modelName}</p><small>{a.status === 'ready' && imported ? '重新登录后同步默认模型。' : a.message}</small>
  </li>)}</ul>;
}
export function LegacyMigration({ disabled, onPreferences, development }: { development: boolean; disabled: boolean; onPreferences: (url: string) => void }) {
  const bridge = desktop?.migration;
  const [status, setStatus] = useState<MigrationStatus>();
  const [sourceId, setSourceId] = useState('');
  const [preview, setPreview] = useState<MigrationPreview>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    bridge.status().then(s => { if (!disposed) { setStatus(s); setSourceId(s.sources[0]?.id || ''); } }).catch(e => { if (!disposed) setError((e as Error).message); });
    return () => { disposed = true; };
  }, [bridge]);
  if (!bridge) return null;
  async function action(run: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await run(); } catch (e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }
  async function loadPreview(id: string) {
    setSourceId(id); setPreview(undefined);
    await action(async () => { setPreview(await bridge!.preview(id)); });
  }
  return <div className="legacy-migration">
    <Button type="button" kind="quiet" disabled={disabled} onClick={() => {
      setOpen(true);
      if (!status?.imported && sourceId) void loadPreview(sourceId);
    }}><FolderInput size={17} />{status?.imported ? '查看旧版导入结果' : '从旧版导入配置'}</Button>
    {feedback && <p className="migration-note" role="status">{feedback}</p>}
    {open && <Modal title={status?.imported ? '旧版配置已导入' : '导入旧版配置'} subtitle={development ? "导入到独立开发目录，保留旧版原文件。" : "接续旧版模型设置和最初备份，导入后重新登录。"} onClose={() => { if (!busy) setOpen(false); }}
      footer={<>
        <Button type="button" kind="secondary" disabled={busy} onClick={() => setOpen(false)}>关闭</Button>
        {status?.imported ? <Button type="button" kind="secondary" busy={busy} onClick={() => void action(async () => {
          await bridge.undo(); setStatus(await bridge.status()); setPreview(undefined);
          setOpen(false); setFeedback('已撤销本次导入。');
          onPreferences((await desktop!.getState()).serverUrl);
        })}><Undo2 size={16} />撤销本次导入</Button> : <Button type="button" busy={busy} disabled={!preview} onClick={() => void action(async () => {
          if (!preview) return;
          await bridge.import(preview.sourceId, preview.fingerprint); setFeedback('');
          setStatus(await bridge.status()); onPreferences((await desktop!.getState()).serverUrl);
        })}>{development ? '导入到开发版' : '导入到新版'}</Button>}
      </>}>
      {error && <Notice error>{error}</Notice>}
      {status?.imported ? <>
        <Notice>服务地址、项目目录和可迁移的模型配置已导入。请重新登录，同步默认模型后使用。</Notice>
        <AgentList agents={status.imported.agents} imported />
        <p className="migration-note">撤销会恢复本次导入前的客户端记录。登录或修改配置后，不再直接撤销。</p>
      </> : <>
        {!status?.sources.length ? <Notice>未找到旧版数据，可直接登录开发版。</Notice> : <>
          {status.sources.length > 1 ? <Field label="旧版数据目录"><select value={sourceId} disabled={busy} onChange={e => void loadPreview(e.target.value)}>{status.sources.map(s => <option key={s.id} value={s.id}>{s.path}</option>)}</select></Field> : <p className="migration-source">{status.sources[0].path}</p>}
          {preview && <>
            <dl className="migration-preferences"><div><dt>公司服务地址</dt><dd>{preview.serverUrl}</dd></div><div><dt>项目目录</dt><dd>{preview.projectDirectory || '未选择'}</dd></div></dl>
            <AgentList agents={preview.agents} />
            {preview.warnings.map(w => <Notice key={w}>{w}</Notice>)}
          </>}
          {!preview && busy && <p role="status">正在检查旧版配置和备份…</p>}
        </>}
      </>}
    </Modal>}
  </div>;
}
