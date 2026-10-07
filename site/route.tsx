import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

/**
 * The page's addresses are real ones: each is answered by the server with this
 * page, and the page reads where it is from the address bar.
 */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const moved = () => setPath(location.pathname);
    window.addEventListener("popstate", moved);
    return () => window.removeEventListener("popstate", moved);
  }, []);
  return path.replace(/\/+$/, "") || "/";
}

export function go(to: string): void {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

/**
 * A link that moves inside the page without loading it again. Anything to or
 * from /api is loaded whole, because when a package's page is installed the
 * docs are the only address this page owns.
 */
export function Link({ to, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    if (to === "/api" || location.pathname === "/api") return;
    event.preventDefault();
    go(to);
  }
  return <a href={to} onClick={follow} {...rest} />;
}
