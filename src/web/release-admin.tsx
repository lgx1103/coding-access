import { useState } from 'react';
import { valid, prerelease } from 'semver';
import { api } from './api.js';
import { Button, Field, Modal, Notice, Refresh, useData } from './components.js';
import { Select } from './select.js';

type Artifact = { id: string; name: string; platform: string; kind: 'installer' | 'updater' };
type Attached = Record<string, Partial<Record<'installer' | 'updater', Artifact>>>;
type Inputs = Record<string, { installer?: File; updater?: File; signature?: File }>;
const platforms = [{ id: 'darwin-aarch64', name: 'macOS Apple Silicon' }, { id: 'windows-x86_64', name: 'Windows x64' }, { id: 'darwin-x86_64', name: 'macOS Intel' }];
const initial = { version: '', channel: 'beta', minServerVersion: '0.1.16', notes: '' };

function FilePicker({ label, accept, file, onChange }: { label: string; accept: string; file?: File; onChange: (file?: File) => void }) {
  return file ? <span className="file-ready">{file.name}<button className="text-button" type="button" onClick={() => onChange(undefined)}>更换</button></span> : <input aria-label={label} type="file" accept={accept} onChange={e => onChange(e.target.files?.[0])} />;
}

export function ReleaseAdmin() {
  const list = useData('/api/admin/client-releases');
  const [open, setOpen] = useState(false); const [step, setStep] = useState(0); const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(initial); const [targets, setTargets] = useState<string[]>([]);
  const [attached, setAttached] = useState<Attached>({}); const [inputs, setInputs] = useState<Inputs>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [progress, setProgress] = useState('');
  const files = (list.data?.artifacts ?? []) as Artifact[];
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); setProgress(''); } }
  function begin(release?: any) {
    setEditing(release ?? null); setForm(release ? { version: release.version, channel: release.channel, minServerVersion: release.minServerVersion, notes: release.notes } : initial);
    const existing: Attached = {};
    for (const file of files.filter(a => release?.artifactIds.includes(a.id))) (existing[file.platform] ??= {})[file.kind] = file;
    // Reuse files already uploaded for this version; the confirmation step shows them before saving.
    if (release) for (const file of [...files].reverse()) if (existing[file.platform] && !existing[file.platform][file.kind] && file.name.startsWith(`Coding-Access-${release.version}-`)) existing[file.platform][file.kind] = file;
    setTargets(release ? Object.keys(existing) : ['darwin-aarch64', 'windows-x86_64']); setAttached(existing); setInputs({}); setStep(release?.published ? 1 : 0); setError(''); setOpen(true);
  }
  function choose(platform: string, kind: 'installer' | 'updater' | 'signature', file?: File) {
    setError('');
    setInputs(old => ({ ...old, [platform]: { ...old[platform], [kind]: file } }));
    setAttached(old => { const value = { ...old[platform] }; delete value[kind === 'signature' ? 'updater' : kind]; if (platform === 'windows-x86_64' && kind === 'installer') delete value.updater; return { ...old, [platform]: value }; });
  }
  async function uploadAndCheck() {
    if (!targets.length) throw new Error('请至少选择一个发布平台');
    for (const platform of targets) {
      const picked = inputs[platform] ?? {}; const saved = attached[platform] ?? {};
      const name = platforms.find(p => p.id === platform)!.name;
      if (!saved.installer && !picked.installer) throw new Error(`${name}：请选择完整安装包`);
      if (!saved.updater && (!picked.signature || !(platform === 'windows-x86_64' ? picked.updater ?? picked.installer : picked.updater))) throw new Error(`${name}：请选择更新包及对应的 .sig 签名文件`);
      for (const f of [picked.installer, picked.updater]) if (f && f.size > 256 * 1048576) throw new Error('文件不能超过 256 MB');
    }
    const done: Attached = { ...attached };
    for (const platform of targets) for (const kind of ['installer', 'updater'] as const) {
      if (done[platform]?.[kind]) continue;
      const picked = inputs[platform]!;
      const file = (kind === 'installer' ? picked.installer : picked.updater ?? (platform === 'windows-x86_64' ? picked.installer : undefined))!;
      setProgress(`正在上传 ${file.name}…`);
      const params = new URLSearchParams({ platform, kind, name: file.name });
      if (kind === 'updater') params.set('signature', (await picked.signature!.text()).trim());
      const response = await fetch(`/api/admin/client-artifacts?${params}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
      const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? '上传失败，请重试');
      done[platform] = { ...done[platform], [kind]: value }; setAttached({ ...done });
    }
    setStep(2);
  }
  async function save(publish: boolean) {
    const artifactIds = targets.flatMap(p => [attached[p]?.installer?.id, attached[p]?.updater?.id]).filter(Boolean) as string[];
    const value = await api(editing ? `/api/admin/client-releases/${editing.id}` : '/api/admin/client-releases', editing ? 'PUT' : 'POST', { ...form, artifactIds });
    setEditing(value);
    if (publish && !value.published) await api(`/api/admin/client-releases/${value.id}/publish`, 'POST', { published: true });
    await list.refresh(); setOpen(false); setMessage(editing?.published ? '更新文件已补全，同事可在客户端重新检查更新' : publish ? '版本已发布，同事可在客户端检查更新' : '草稿已保存');
  }
  return <div className="page-enter release-page">
    <div className="page-heading"><div><h1>客户端发布</h1><p>发布安装包和应用内更新，同事可直接在客户端升级。</p></div><div className="heading-actions"><Refresh busy={list.loading} label="刷新客户端版本" onClick={() => void list.refresh()} /><Button onClick={() => begin()}>发布新版本</Button></div></div>
    {message && <Notice>{message}</Notice>}{list.error && <Notice error>{list.error}</Notice>}{!open && error && <Notice error>{error}</Notice>}
    <section className="panel release-list"><div className="table-scroll"><table><thead><tr><th>版本</th><th>通道</th><th>发布状态</th><th>操作</th></tr></thead><tbody>
      {list.data?.releases.map((r: any) => <tr key={r.id}><td><strong>{r.version}</strong><small className="release-platform-label">{platforms.filter(p => files.some(f => r.artifactIds.includes(f.id) && f.platform === p.id)).map(p => p.name).join(' · ')}</small></td><td>{r.channel === 'stable' ? '稳定版' : '测试版'}</td><td>{r.published ? '已发布' : '草稿 / 已撤回'}{r.missingArtifacts?.map((issue: string) => <small className="release-warning" key={issue}>{issue}</small>)}</td><td><div className="heading-actions">
        {(!r.published || !!r.missingArtifacts?.length) && <Button kind="secondary" onClick={() => begin(r)}>{r.published ? '补全更新文件' : '继续编辑'}</Button>}
        {r.published && <Button kind="quiet" busy={busy} onClick={() => void run(async () => { await api(`/api/admin/client-releases/${r.id}/publish`, 'POST', { published: false }); await list.refresh(); setMessage('已撤回版本，已安装的客户端不受影响'); })}>撤回</Button>}
      </div></td></tr>)}
    </tbody></table></div>{!list.loading && !list.data?.releases.length && <p className="release-empty">还没有发布版本。点击右上角「发布新版本」开始。</p>}</section>
    {open && <Modal wide title={editing?.published ? `补全 ${form.version} 更新文件` : editing ? `编辑 ${form.version}` : '发布新版本'} onClose={() => { if (!busy) setOpen(false); }} footer={<>
      <Button kind="quiet" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
      {step > (editing?.published ? 1 : 0) && <Button kind="secondary" disabled={busy} onClick={() => { setError(''); setStep(step - 1); }}>上一步</Button>}
      {step === 0 && <Button onClick={() => { if (valid(form.version) !== form.version || !form.notes.trim()) { setError('请填写标准版本号和更新说明，例如 0.2.0-beta.7'); return; } if (form.channel === 'stable' && prerelease(form.version)) { setError('预发布版本请选择测试通道'); return; } setError(''); setStep(1); }}>下一步：选择文件</Button>}
      {step === 1 && <Button busy={busy} onClick={() => void run(uploadAndCheck)}>上传并检查</Button>}
      {step === 2 && <>{!editing?.published && <Button kind="secondary" busy={busy} onClick={() => void run(() => save(false))}>保存草稿</Button>}<Button busy={busy} onClick={() => void run(() => save(true))}>{editing?.published ? '补全并保持发布' : '确认发布'}</Button></>}
    </>}>
      <ol className="release-steps" aria-label="发布步骤">{['版本信息', '选择文件', '检查并发布'].map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      {error && <Notice error>{error}</Notice>}{progress && <p role="status">{progress}</p>}
      <div className="release-form">
        {step === 0 && <><div className="form-grid"><Field label="客户端版本"><input disabled={!!editing} value={form.version} onChange={e => setForm({ ...form, version: e.target.value })} placeholder="例如 0.2.0-beta.7" /></Field><Field label="发布通道"><Select label="发布通道" disabled={!!editing?.published} value={form.channel} onValueChange={channel => setForm({ ...form, channel })} options={[{value:'beta',label:'测试版'},{value:'stable',label:'稳定版'}]} /></Field></div><Field label="更新说明"><textarea disabled={!!editing?.published} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="告诉同事这次更新了什么" rows={4} /></Field><details><summary>兼容性设置</summary><Field label="最低服务端版本"><input disabled={!!editing?.published} value={form.minServerVersion} onChange={e => setForm({ ...form, minServerVersion: e.target.value })} /></Field></details></>}
        {step === 1 && <><p className="small-note">选择要发布的平台。Windows 的 EXE 会同时用作安装包和更新包，只需选择一次文件。</p>
          <div className="platform-choices">{platforms.map(p => <label key={p.id}><input type="checkbox" disabled={!!editing?.published} checked={targets.includes(p.id)} onChange={e => setTargets(old => e.target.checked ? [...old, p.id] : old.filter(v => v !== p.id))} />{p.name}</label>)}</div>
          {platforms.filter(p => targets.includes(p.id)).map(p => <section className="release-platform" key={p.id}><h3>{p.name}</h3>
            {(['installer','updater'] as const).map(kind => <div key={kind} className="release-file"><span>{kind === 'installer' ? '完整安装包' : '应用内更新包'}</span>{attached[p.id]?.[kind] ? <span className="file-ready">已就绪 · {attached[p.id][kind]!.name}{!editing?.published && <button className="text-button" type="button" onClick={() => choose(p.id, kind)}>更换</button>}</span> : p.id === 'windows-x86_64' && kind === 'updater' && !attached[p.id]?.installer ? <span className="small-note">使用上面的 EXE，另选下方签名</span> : <FilePicker label={`${p.name} ${kind === 'installer' ? '完整安装包' : '应用内更新包'}`} accept={p.id === 'windows-x86_64' ? '.exe' : kind === 'updater' ? '.gz' : '.zip'} file={inputs[p.id]?.[kind]} onChange={file => choose(p.id, kind, file)} />}</div>)}
            {!attached[p.id]?.updater && <div className="release-file"><span>更新签名</span><FilePicker label={`${p.name} 更新签名`} accept=".sig" file={inputs[p.id]?.signature} onChange={file => choose(p.id, 'signature', file)} /></div>}
          </section>)}
        </>}
        {step === 2 && <><h3>{form.version} · {form.channel === 'stable' ? '稳定版' : '测试版'}</h3><p className="release-summary">{form.notes}</p>{targets.map(p => <div className="release-check" key={p}><strong>{platforms.find(v => v.id === p)?.name}</strong><span>安装包：{attached[p]?.installer?.name}</span><span>更新包：{attached[p]?.updater?.name}</span></div>)}<Notice>发布后，同事可以在客户端检查、下载更新并安装重启。</Notice></>}
      </div>
    </Modal>}
  </div>;
}
