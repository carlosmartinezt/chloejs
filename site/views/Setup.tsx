/**
 * How to get a runtime running, in order, for somebody who has never done it.
 *
 * The same steps in three places: beside a key that was just made, on the
 * workspaces list, where the key is shown the once; inside a workspace no
 * runtime has ever connected to, where it cannot be shown again; and on a
 * server that has the page but not the runtime, which joins no cloud and so
 * has no key step at all.
 */
export function Setup({ secret, toCloud = true }: { secret?: string; toCloud?: boolean }) {
  return (
    <ol className="steps">
      <li>
        <h3>Install the runtime</h3>
        <p>
          In an empty folder, on Node 22.18 or newer, with <code>"type": "module"</code> in its{" "}
          <code>package.json</code>. Node runs the TypeScript, so there is nothing to build.
        </p>
        <pre>
          <code>npm install @chloejs/core</code>
        </pre>
      </li>

      <li>
        <h3>Run the setup</h3>
        <p>
          One command instead of writing the files by hand: it asks the questions, writes{" "}
          <code>chloe.config.ts</code> and a starter agent, checks that the model it was given
          actually answers, and runs the first job. Holding Enter through it works.
        </p>
        <pre>
          <code>npx chloe setup</code>
        </pre>
        <p className="after">By hand, the model lines in <code>.env</code> are:</p>
        <Routes />
      </li>

      {toCloud && (
      <li>
        <h3>Give it this workspace</h3>
        <p>
          The same <code>.env</code>. This is what tells the runtime to show itself here, and it is
          the one secret worth keeping out of git.
        </p>
        <pre>
          <code>{`CHLOE_DASHBOARD_REMOTE_API_KEY=${secret ?? "chl_workspace_..."}`}</code>
        </pre>
        {!secret && (
          <p className="after">
            A key is shown once, when it is made. If that one is lost, make a new one from the menu
            beside this workspace on the front page. The old one stops working.
          </p>
        )}
      </li>
      )}

      <li>
        <h3>Start it</h3>
        <p>
          {toCloud
            ? "It opens one connection out to here and stays on it, so the machine it runs on needs no port and no address of its own. This page fills in within a few seconds."
            : "It serves this same page on its own port, with the agents on it."}
        </p>
        <pre>
          <code>npx chloe</code>
        </pre>
      </li>
    </ol>
  );
}

/**
 * The three ways a model call can go out, when setup is not for you. A key is
 * the plain one; the other two exist because a subscription is not a key and
 * there is nothing to paste into a header, so the provider's own command line
 * tool spends it instead.
 */
function Routes() {
  return (
    <div className="routes">
      <div className="route">
        <h4>A key</h4>
        <p>
          Anything that answers OpenAI&rsquo;s chat-completions shape, like the{" "}
          <a href="https://vercel.com/ai-gateway" target="_blank" rel="noreferrer">
            Vercel AI Gateway
          </a>{" "}
          or OpenRouter. The key in <code>.env</code>:
        </p>
        <pre>
          <code>CHLOE_MODEL_KEY=your-key</code>
        </pre>
        <p>
          and where it goes in <code>settings</code> in <code>chloe.config.ts</code>:
        </p>
        <pre>
          <code>model: {"{"} gateway: "https://your-gateway/v1/chat/completions" {"}"}</code>
        </pre>
        <p className="note">
          A subscription that is signed in is ahead of a key in the order. To put the key first,
          add <code>prefer: ["gateway", "claude", "codex", "opencode"]</code> beside it.
        </p>
      </div>

      <div className="route">
        <h4>A Claude subscription</h4>
        <p>
          Pro or Max. There is no key to copy, so Chloe asks Claude Code, which your plan has
          already signed in. Install it and run <code>claude</code> once, and nothing goes in{" "}
          <code>.env</code>.
        </p>
        <p className="note">
          Anthropic models only. Chloe still runs every tool itself, so the record of what the
          agent did stays complete.
        </p>
      </div>

      <div className="route">
        <h4>A ChatGPT plan</h4>
        <p>
          The same idea through Codex. Install it and run <code>codex</code> once to sign in, and
          nothing goes in <code>.env</code> either.
        </p>
        <p className="note">
          OpenAI models only. A plan is not billed per call, so a run made this way shows no cost.
        </p>
      </div>
    </div>
  );
}