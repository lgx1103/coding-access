const adminRoutes: Record<string, string> = {
  overview: '/admin/overview', providers: '/admin/providers', resources: '/admin/keys',
  models: '/admin/models', users: '/admin/users', requests: '/admin/usage',
  settings: '/admin/settings', help: '/admin/releases',
};
const memberRoutes: Record<string, string> = {
  overview: '/app/models', usage: '/app/usage', help: '/app/help',
};
export const WEB_PAGE_PATHS = [...Object.values(adminRoutes), ...Object.values(memberRoutes)];
const normalize = (path: string) => path.endsWith('/') ? path.slice(0, -1) : path;

export function isWebPagePath(path: string) {
  return WEB_PAGE_PATHS.includes(normalize(path));
}

export function webPagePath(page: string, role: string) {
  const routes = role === 'admin' ? adminRoutes : memberRoutes;
  return Object.hasOwn(routes, page) ? routes[page] : routes.overview;
}

export function webPageAt(path: string, role: string) {
  const routes = role === 'admin' ? adminRoutes : memberRoutes;
  return Object.entries(routes).find(([, route]) => route === normalize(path))?.[0] ?? 'overview';
}
