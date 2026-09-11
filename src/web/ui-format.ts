const agentNames: Record<string, string> = {
  'claude-code': 'Claude Code',
  'zcode': 'ZCode',
  codex: 'Codex（终端与桌面共用）',
  'codex-cli': 'Codex CLI',
  'codex-desktop': 'Codex 桌面版',
  browser: '浏览器',
};

const statusNames: Record<string, string> = {
  available: '可用', busy: '繁忙', unavailable: '暂不可用', unknown: '待验证',
  success: '成功', error: '失败', running: '进行中', pending: '等待中',
  cancelled: '已取消', interrupted: '已中断', incomplete: '输出未完整',
  enabled: '已启用', disabled: '已停用', cooldown: '冷却中',
};

const errorNames: Record<string, string> = {
  InvalidSubscription: '订阅或席位不可用', '1309': '套餐到期', '1314': '企业套餐失效',
  '1113': '余额不足', '1308': '额度耗尽', '1310': '周期额度耗尽', '1311': '模型未授权', '1315': '密钥产品不匹配',
  upstream_authentication: '服务凭证异常', upstream_subscription: '订阅资源不可用',
  upstream_quota: '额度不足', upstream_rate_limit: '请求限流', upstream_configuration: '接入配置或授权异常',
  upstream_context_length: '请求过长', upstream_content_policy: '内容检查未通过',
  upstream_invalid_request: '请求参数不兼容', upstream_service: '模型服务异常', server_error: '公司服务异常',
  invalid_api_key: '访问凭证无效', authentication_error: '访问凭证无效',
  invalid_model: '未指定有效模型', model_not_found: '模型不存在',
  model_disabled: '模型已停用', model_forbidden: '没有模型使用权限',
  agent_not_enabled: '当前工具尚未开放', access_revoked: '访问权限已撤销',
  rate_limit_error: '供应商限流', rate_limit_exceeded: '供应商限流',
  rate_limited: '供应商限流', '1302': '供应商限流', '1305': '供应商繁忙',
  insufficient_quota: '供应商额度不足', quota_exceeded: '供应商额度不足',
  no_available_channel: '暂无可用接入', no_compatible_channel: '暂无兼容接入',
  upstream_unreachable: '供应商连接失败', upstream_connection: '供应商连接中断',
  upstream_error: '供应商服务异常', request_error: '请求处理失败',
  cancelled: '请求已取消', wait_timeout: '请求等待超时',
  stream_interrupted: '输出中断', incomplete_stream: '输出未完整',
  stream_error: '输出异常', empty_stream: '供应商未返回输出',
  invalid_upstream_response: '供应商回复无效', invalid_upstream_stream: '供应商输出格式无效',
  stream_format: '输出格式不兼容', stream_prelude_limit: '输出前置事件过多',
  output_limit: '输出长度超出范围', unsupported_content: '消息格式不受支持',
  unsupported_input: '输入格式不受支持', unsupported_tool: '工具类型不受支持',
  unsupported_reasoning: '思考上下文不兼容', full_context_required: '需要完整会话上下文',
  invalid_reasoning_state: '思考上下文不匹配', key_decryption_failed: '服务端密钥解密失败',
  invalid_tool_namespace: '工具命名空间无效', invalid_tool_call: '工具调用无效',
  incomplete_tool_arguments: '工具参数未完整', invalid_custom_tool: '自定义工具输入无效',
  unsupported_block_order: '输出顺序不兼容', background_unsupported: '后台请求不受支持',
};

export const agentLabel = (value: string | null | undefined) => agentNames[value ?? ''] ?? '其他工具';
export const statusLabel = (value: string | null | undefined) => statusNames[value ?? ''] ?? '未知状态';
export function errorCodeLabel(value: string | null | undefined, httpStatus?: number | null) {
  if (value && errorNames[value]) return errorNames[value];
  const status = httpStatus ?? Number(value?.match(/^http_(\d+)$/)?.[1]);
  if (status === 401 || status === 403) return '供应商拒绝访问';
  if (status === 402) return '供应商额度不足';
  if (status === 429) return '供应商限流';
  if (status >= 500) return '供应商服务异常';
  return value ? '调用异常' : '正常完成';
}

export const contextLabel = (value: number) => `${value.toLocaleString('zh-CN')} 词元上下文`;
