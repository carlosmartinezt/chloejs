// The plugins' parts of the page, each from its plugin's folder. Like
// plugins/index.ts for the runtime, this is the one list: taking a plugin out
// is deleting its line here too. A plugin with no part of the page is not on it.
import type { ReactNode } from "react";

import { GoogleSetup } from "../plugins/google/page/GoogleSetup.tsx";

/**
 * A connection's own panel, by its name: set up once for the whole copy, and
 * shown on Configuration in its plugin's section and on an agent's
 * Connections, where people look for it.
 */
export const PANELS: Record<string, (props: { onAgent?: boolean; done?: () => void }) => ReactNode> = {
  google: GoogleSetup,
};
