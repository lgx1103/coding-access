import { useState } from 'react';
import { Copy, Download, ExternalLink, Monitor, ShieldCheck, Terminal } from 'lucide-react';
import { APP_VERSION } from '../shared/version.js';
import { copyText, desktop, number } from './api.js';
import { Button, Empty, Loading, Notice, Refresh, useData } from './components.js';

const toolGuides = [
  { name: 'Claude Code', url: 'https://code.claude.com/docs/en/setup' },
  { name: 'Codex CLI 与桌面版', url: 'https://developers.openai.com/codex' },
];

export function Help({ version = APP_VERSION, mode = "all", embedded = false }: { version?: string; mode?: "all" | "guide" | "downloads"; embedded?: boolean }) {
  const releases = useData('/api/client-release');
  const downloadIssue = releases.error ? '暂时无法获取安装包列表，请稍后刷新或联系管理员。' : releases.data?.downloadIssue?.message;
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  async function copyGuide(url: string) {
    try {
      await copyText(url);
      setCopied(url);
      setError('');
    } catch {
      setError('无法复制网址，请手动选择下方地址并复制到浏览器。');
    }
  }
  return <div className="page-enter">
    {!embedded && <div className="page-heading">
      <div><h1>客户端与帮助</h1><p>下载客户端，查看安装与连接步骤。当前版本 {version}。</p></div>
      <Refresh label="检查客户端版本" busy={releases.loading} onClick={() => void releases.refresh()} />
    </div>}
    {error && <Notice error>{error}</Notice>}{embedded && mode === "downloads" && <div className="help-refresh"><Refresh label="刷新安装包" busy={releases.loading} onClick={() => void releases.refresh()} /></div>}
    <div className={mode === "all" ? "settings-grid" : "help-single"}>
      {mode !== "guide" && <section className="panel">
        <div className="panel-heading"><div><h2><Download size={18} />客户端安装包</h2><p>从公司服务器下载安装</p></div></div>
        <div className="form-body">
          {downloadIssue && <Notice error>{downloadIssue}</Notice>}
          {releases.loading && !releases.data ? <Loading /> : releases.data?.downloads.length ? releases.data.downloads.map((d: any) => <div className="download-row" key={d.name}>
            <Monitor size={23} />
            <span><strong>{d.platform} · {d.arch}</strong><small>{d.name}<br />{number(Math.round(d.size / 1024 / 1024))} MB</small></span>
            {desktop
              ? <Button kind="secondary" onClick={() => void desktop!.download(d.url).catch(e => setError(e.message))}>下载</Button>
              : <a className="button secondary" href={d.url} download>下载</a>}
          </div>) : <Empty title={downloadIssue ? "安装包暂不可用" : "尚无可下载的安装包"} detail={downloadIssue ? "可通过公司已有渠道获取客户端。此处不影响模型的正常使用。" : "管理员上传后，点击右上角刷新。也可通过公司已有渠道获取安装包。"} />}
          <Notice>{desktop?.migration
            ? '手动安装前请退出客户端。安装后保留登录信息和配置，无需导入。'
            : '更新前请完全退出 Coding Access，解压新版本并替换旧应用。登录信息和工具配置会保留。'}</Notice>
        </div>
      </section>}
      {mode !== "downloads" && <section className="panel">
        <div className="panel-heading"><div><h2><Terminal size={18} />首次使用</h2><p>安装工具并连接公司服务</p></div></div>
        <div className="form-body">
          <ol className="help-steps">
            <li><strong>安装编程工具</strong><p>按照官方文档安装需要的工具。</p>
              <div className="official-links">
                {toolGuides.map(guide => <div key={guide.url} className="official-link">
                  {desktop ? <>
                    <span>{guide.name}</span>
                    <Button type="button" kind="quiet" onClick={() => void copyGuide(guide.url)}><Copy size={14} />{copied === guide.url ? '网址已复制' : '复制官网地址'}</Button>
                    {(!embedded || error) && <code>{guide.url}</code>}
                  </> : <a href={guide.url} target="_blank" rel="noopener noreferrer">{guide.name} 官方文档<ExternalLink size={14} /></a>}
                </div>)}
              </div>
              {desktop && <p>复制后粘贴到浏览器打开。</p>}
            </li>
            <li><strong>连接公司网络</strong><p>远程办公先连接 VPN，再填写公司服务地址并登录。模型列表加载失败时，检查网络和服务地址。</p></li>
            <li><strong>配置模型并开始使用</strong><p>选择工具后，点击模型行的“启用”可设为默认模型。“使用中”表示当前默认配置。Claude Code、Codex CLI 的终端按钮可直接启动该行模型的临时会话，无需先启用。桌面工具需先启用并重开应用。</p></li>
            <li><strong>排查调用问题</strong><p>展开客户端的“排查问题”，复制诊断信息交给管理员。GLM 暂不可用时，可手动选择已开放的 DeepSeek 模型。</p></li>
          </ol>
          <div className="small-note"><ShieldCheck size={14} />员工使用独立的公司访问凭证。退出客户端账号会撤销当前设备的凭证。</div>
        </div>
      </section>}
    </div>
  </div>;
}
