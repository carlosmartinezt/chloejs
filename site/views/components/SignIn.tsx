import { useState } from "react";

import { api } from "../../lib/api.ts";

/**
 * Signing in to one connection from the page: the same sign-in a chat runs, so
 * the link comes from the runtime as it made it and the code goes straight back
 * to it. Where the dashboard catches Google's answer there is nothing to paste,
 * and `done` refreshing the list is how that shows.
 */
export function SignIn({ agent, name, again, done }: { agent: string; name: string; again: boolean; done: () => void }) {
  const [started, setStarted] = useState<{ say: string; link?: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [bad, setBad] = useState("");

  const work = async (step: () => Promise<void>) => {
    setBusy(true);
    setBad("");
    try {
      await step();
    } catch (error) {
      setBad((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    work(async () => {
      setSaid("");
      setStarted(await api.startSignIn(agent, name));
    });
  const finish = () =>
    work(async () => {
      const { said } = await api.finishSignIn(agent, name, answer.trim());
      setSaid(said);
      setStarted(null);
      setAnswer("");
      done();
    });

  return (
    <div className="signing">
      {!started ? (
        <button className="small" onClick={start} disabled={busy}>
          {again ? "Sign in again" : "Sign in"}
        </button>
      ) : (
        <>
          <span className="does">{started.say}</span>
          {started.link ? (
            <a href={started.link} target="_blank" rel="noopener noreferrer">
              Open the sign-in page
            </a>
          ) : null}
          {started.link ? (
            <span className="answer">
              <input value={answer} placeholder="The code, or the page's whole address" onChange={(event) => setAnswer(event.target.value)} />
              <button className="small go" onClick={finish} disabled={busy || !answer.trim()}>
                Finish
              </button>
              <button className="small plain" onClick={() => setStarted(null)} disabled={busy}>
                Cancel
              </button>
            </span>
          ) : null}
        </>
      )}
      {said ? <span className="free needs">{said}</span> : null}
      {bad ? <span className="bad needs">{bad}</span> : null}
    </div>
  );
}
