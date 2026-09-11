declare const __ACA_DEFAULT_SERVICE_URL__: string;
export const DEFAULT_SERVICE_URL = typeof __ACA_DEFAULT_SERVICE_URL__ === 'string' ? __ACA_DEFAULT_SERVICE_URL__ : '';
const EXAMPLE_SERVICE_URL = 'http://localhost:4317';

/** Employees can replace the company default with another service address. */
export function serviceBaseUrl(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw new Error('请填写有效的公司服务地址');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error(`请填写完整的公司服务地址，例如 ${EXAMPLE_SERVICE_URL}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('公司服务地址须使用 HTTP 或 HTTPS');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写公司服务根地址，不包含用户名、路径或查询参数');
  return url.origin;
}
