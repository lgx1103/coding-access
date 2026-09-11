import type { ZodError, ZodIssue } from 'zod';

const fields: Record<string, string> = {
  id: '模型标识', name: '名称', username: '登录账号', password: '密码',
  currentPassword: '当前密码', newPassword: '新密码', role: '账号角色',
  enabled: '启用状态', product: '产品或套餐', description: '模型说明',
  endpoints: '接口地址', messages: 'Claude 消息接口地址', chat: '通用对话接口地址',
  responses: 'Codex 响应接口地址', auth: '身份验证方式', headers: '额外请求头',
  defaults: '请求默认参数', agents: '编程工具', contextWindow: '上下文长度',
  maxOutputTokens: '最大输出词元数', routes: '模型接入', providerId: '供应商接入',
  upstreamModel: '供应商模型标识', weight: '分配权重', vision: '图片支持',
  keys: '密钥列表', secret: '供应商密钥', models: '模型范围',
  maxConcurrent: '最大同时请求数', rateScope: '限流共享范围', group: '共享组名称',
  client: '客户端类型', device: '设备名称', modelId: '模型标识', agent: '编程工具',
  credentialId: '访问凭证标识', since: '开始时间',
};

function fieldLabel(path: PropertyKey[]) {
  return path.map((part, index) => {
    if (typeof part === 'number') return `第 ${part + 1} 项`;
    // Header and parameter names are editable technical identifiers, not payload values.
    if (index > 0 && ['headers', 'defaults'].includes(String(path[index - 1]))) return `「${String(part)}」`;
    return fields[String(part)] ?? '输入内容';
  }).join(' / ');
}

function description(issue: ZodIssue): string {
  switch (issue.code) {
    case 'custom':
      return /[\u3400-\u9fff]/.test(issue.message) ? issue.message : '请检查填写内容';
    case 'invalid_type':
      return ({
        string: '请填写文本', number: '请填写有效数字', int: '请填写整数',
        boolean: '请选择有效的开关状态', object: '请填写 JSON 对象',
        record: '请填写 JSON 对象', array: '请提供有效列表',
      } as Record<string, string>)[issue.expected] ?? '请填写有效内容';
    case 'too_small': {
      if (issue.path.at(-1) === 'agents' && issue.minimum === 1) return '至少选择一个编程工具';
      if (issue.path.at(-1) === 'routes' && issue.minimum === 1) return '至少添加一个供应商接入';
      if (issue.origin === 'string') return `至少填写 ${issue.minimum} 个字符`;
      if (issue.origin === 'array') return `至少提供 ${issue.minimum} 项`;
      return `数值必须${issue.inclusive ? '大于或等于' : '大于'} ${issue.minimum}`;
    }
    case 'too_big':
      if (issue.origin === 'string') return `最多填写 ${issue.maximum} 个字符`;
      if (issue.origin === 'array') return `最多提供 ${issue.maximum} 项`;
      return `数值必须${issue.inclusive ? '小于或等于' : '小于'} ${issue.maximum}`;
    case 'invalid_format':
      if (issue.format === 'url') return '请填写完整且有效的接口地址';
      if (issue.format === 'regex') return '请以英文字母或数字开头，仅使用英文字母、数字、点、下划线或短横线，长度为 1–100 个字符';
      return '填写格式不正确';
    case 'invalid_value': return '请选择有效选项';
    case 'not_multiple_of': return `请填写 ${issue.divisor} 的整数倍`;
    case 'unrecognized_keys': return '包含不支持的字段';
    case 'invalid_key': return '字段名称不符合要求';
    case 'invalid_element': return '列表中包含无效内容';
    case 'invalid_union': return '填写内容不符合要求';
  }
}

/** Format validation failures without changing schemas or including submitted values. */
export function formatValidationError(error: ZodError) {
  return error.issues.map(issue => {
    const field = fieldLabel(issue.path);
    return `${field ? `${field}：` : ''}${description(issue)}`;
  }).join('；');
}
