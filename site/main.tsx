import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { Dev } from "./views/components/Dev.tsx";
import { serverAt } from "./lib/api.ts";
import { takeLink } from "./lib/link.ts";

// Said in index.html, so a built copy can be pointed at a different runtime by
// editing one line rather than building it again.
const said = document.querySelector('meta[name="chloe-api"]')?.getAttribute("content");
if (said) serverAt(said);

void takeLink().then(() =>
  createRoot(document.getElementById("app")!).render(
    <>
      <Dev />
      <App />
    </>,
  ),
);
