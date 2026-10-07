import { useEffect, useState, type FormEvent } from "react";

import { api } from "../api.ts";

/** Signing in, or choosing the password when this copy has none yet. */
export function Login({ onIn }: { onIn: () => void }) {
  const [making, setMaking] = useState<boolean>();
  const [password, setPassword] = useState("");
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    api.hasAccount().then((exists) => setMaking(!exists), (error: Error) => setTrouble(error.message));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await (making ? api.setUp(password) : api.signIn(password));
      onIn();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  if (making === undefined && !trouble) return null;
  return (
    <main className="door">
      <form className="card" onSubmit={submit}>
        <div className="mark">
          <span className="dot" aria-hidden />
          chloe
        </div>
        <h1>{making ? "Choose a password" : "Sign in"}</h1>
        <p className="dim">
          {making
            ? "This copy has no password yet. Anything else on this machine can reach this port, so chloe asks for one before it shows the agents, their runs and their memory. Signing in lasts a week. Forgotten it later is npx chloe account in a terminal."
            : "Behind this are the agents, what they have run, and what they remember."}
        </p>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={making ? "Password, 8 characters or more" : "Password"}
          autoComplete={making ? "new-password" : "current-password"}
          minLength={8}
          autoFocus
          required
        />
        <button className="primary" type="submit">
          {making ? "Set password" : "Sign in"}
        </button>
        {trouble && <p className="bad">{trouble}</p>}
      </form>
    </main>
  );
}
