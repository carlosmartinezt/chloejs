import { useState } from "react";

import { api } from "../../lib/api.ts";

/**
 * Signing in to one connection from the page: the same sign-in a chat runs,
 * so the link comes from the runtime as it made it and the answer goes
 * straight back to it. The button opens the sign-in page in a new tab at
 * once, then asks for what that page gives: a code to paste back, or, when
 * the person types a code there instead (`code`), only to say they are done.
 * With no agent it is a sign-in for the whole copy, whose plugin gives it as
 * `whole`, like Google's. `done` refreshes the list once it is finished.
 */
export function SignIn({ agent, name, again, whole, done }: {
  agent?: string;
  name: string;
  again: boolean;
  whole?: { start(): Promise<{ say: string; link?: string; code?: string }>; finish(answer: string): Promise<string> };
  done: () => void;
}) {
  const [started, setStarted] = useState<{ say: string; link?: string; code?: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [bad, setBad] = useState("");

  async function start() {
    setBusy(true);
    setBad("");
    setSaid("");
    // Opened now, while the click still counts, or the browser blocks it; it is pointed at the page once the link is back.
    const tab = window.open("", "_blank");
    try {
      const got = agent ? await api.startSignIn(agent, name) : await whole!.start();
      if (got.link && tab) {
        tab.opener = null;
        tab.location.href = got.link;
      } else tab?.close();
      setStarted(got);
    } catch (error) {
      tab?.close();
      setBad((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finish(given: string) {
    setBusy(true);
    setBad("");
    try {
      setSaid(
        agent ? (await api.finishSignIn(agent, name, given)).said : await whole!.finish(given),
      );
      setStarted(null);
      setAnswer("");
      done();
    } catch (error) {
      setBad((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signing">
      {!started ? (
        <button className="small" onClick={() => void start()} disabled={busy}>
          {again ? "Sign in again" : "Sign in"}
        </button>
      ) : !started.link ? (
        // Nothing to open yet: the steps are all there is to show.
        <span className="does">{started.say}</span>
      ) : started.code ? (
        <>
          <span className="does">
            On the page that opened, type <code>{started.code}</code> and sign in. Then press Done.
          </span>
          <span className="answer">
            <button className="small go" onClick={() => void finish("done")} disabled={busy}>
              Done
            </button>
            <button className="small plain" onClick={() => setStarted(null)} disabled={busy}>
              Cancel
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="does">Sign in on the page that opened. Then paste the code it shows here.</span>
          <span className="answer">
            <input value={answer} placeholder="The code" onChange={(event) => setAnswer(event.target.value)} />
            <button className="small go" onClick={() => void finish(answer.trim())} disabled={busy || !answer.trim()}>
              Finish
            </button>
            <button className="small plain" onClick={() => setStarted(null)} disabled={busy}>
              Cancel
            </button>
          </span>
        </>
      )}
      {started?.link && (
        <a className="dim" href={started.link} target="_blank" rel="noopener noreferrer">
          The page did not open? Open it here.
        </a>
      )}
      {said ? <span className="free needs">{said}</span> : null}
      {bad ? <span className="bad needs">{bad}</span> : null}
    </div>
  );
}
