import type { MouseEvent, ReactNode } from "react";

import { labelOf } from "../../lib/format.ts";
import { go, href, type View } from "../../lib/route.ts";

/**
 * Back means back, so it uses the history. The view is where it lands when
 * there is no history, which is what happens on a link somebody was sent, and
 * it is also the address, so a middle click still opens somewhere sensible.
 */
export function Back({ to }: { to: View }) {
  function click(event: MouseEvent) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (window.history.length > 1) window.history.back();
    else go(to);
  }
  return (
    <a href={href(to)} className="back" onClick={click}>
      &larr; Back
    </a>
  );
}

/**
 * Where you are inside one agent, and every step of the way back to it. A step
 * with somewhere to go is a link; the last one is where you are.
 */
export function Trail({ agent, steps }: { agent: string; steps: { name: string; to?: View }[] }) {
  return (
    <nav className="trail">
      <Link to={{ at: "agent", agent }} className="who-ran">
        {labelOf(agent)}
      </Link>
      {steps.map((step, at) => (
        <span key={at}>
          <i>/</i>
          {step.to ? <Link to={step.to}>{step.name}</Link> : <span>{step.name}</span>}
        </span>
      ))}
    </nav>
  );
}

/**
 * Everything that moves the page is a real link: it has an address you can
 * copy, and a middle click opens it in a tab like anything else.
 */
export function Link({
  to,
  className,
  current,
  title,
  children,
}: {
  to: View;
  className?: string;
  current?: boolean;
  title?: string;
  children: ReactNode;
}) {
  function click(event: MouseEvent) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    go(to);
  }
  return (
    <a href={href(to)} className={className} title={title} aria-current={current} onClick={click}>
      {children}
    </a>
  );
}
