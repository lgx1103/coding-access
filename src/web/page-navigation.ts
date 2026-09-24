import { useEffect, useState } from 'react';
import { webPageAt, webPagePath } from '../shared/web-routes.js';

// Browser pages are addressed by URL. Native clients keep their existing in-window navigation.
export function usePageNavigation(role: string | undefined, native: boolean): [string, (page: string) => void] {
  const [nativePage, setNativePage] = useState('overview');
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const page = native ? nativePage : role ? webPageAt(pathname, role) : 'overview';

  useEffect(() => {
    if (native) return;
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [native]);

  useEffect(() => {
    // Keep the requested URL while signing in or changing the initial password.
    if (native || !role) return;
    const canonical = webPagePath(page, role);
    if (pathname !== canonical) {
      window.history.replaceState(null, '', canonical);
      setPathname(canonical);
    }
  }, [native, role, pathname, page]);

  return [page, next => {
    if (native) { setNativePage(next); return; }
    if (!role) return;
    const path = webPagePath(next, role);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setPathname(path);
  }];
}
