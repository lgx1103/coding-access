import type { Model, PublicUser } from './types.js';

export function inModelAudience(user: Pick<PublicUser, 'id' | 'role' | 'models'>, model: Model) {
  return user.role === 'admin' || (model.audience ? model.audience.type === 'all' || model.audience.userIds.includes(user.id) : user.models.includes(model.id));
}
export function canUseModel(user: Pick<PublicUser, 'id' | 'role' | 'models' | 'enabled'>, model: Model) {
  return user.enabled && model.enabled && inModelAudience(user, model);
}
export function publicationLabel(model: Model) {
  return model.enabled ? '已发布' : model.everPublished ? '已下架' : '草稿';
}
export function audienceLabel(model: Model) {
  return model.audience?.type === 'all' ? '全体成员' : `指定 ${model.audience?.userIds.length ?? 0} 位成员`;
}
