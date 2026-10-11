import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";

/**
 * The owner's own account: the first password, then changing it or adding a
 * name, both with the current password, and signing out. A forgotten password
 * cannot be reset from here, because whoever is at this browser may not be
 * the owner: it is `npx chloe account` in the project's folder.
 */
export function Account() {
  const [exists, setExists] = useState<boolean | null>(null);
  const [name, setName] = useState("");

  const refresh = () => {
    api.account().then(
      (said) => setExists(said.exists),
      () => setExists(null),
    );
    api.ownName().then(
      (said) => setName(said.name),
      () => setName(""),
    );
  };
  useEffect(refresh, []);

  return (
    <>
      <div className="head">
        <h1>My account</h1>
      </div>

      {exists === false && (
        <section className="setting">
          <h2>Password</h2>
          <First done={refresh} />
        </section>
      )}

      {exists && (
        <>
          <section className="setting">
            <h2>Name and password</h2>
            <p className="empty">
              {name ? (
                <>
                  You sign in with the name <b>{name}</b> and the password.
                </>
              ) : (
                <>You sign in with your password. Add a name, and you sign in with both. That is safer.</>
              )}{" "}
              A new password signs out every other browser.
            </p>
            <Change name={name} done={refresh} />
          </section>

          <section className="setting">
            <h2>Forgotten the password?</h2>
            <p className="empty">
              Run <code>npx chloe account</code> in the project's folder. It sets a new one, says your name, and loses
              nothing. <code>npx chloe link</code> there prints a link that signs one browser in without a password.
            </p>
          </section>
        </>
      )}

      <section className="setting">
        <h2>Sign out</h2>
        <p className="empty">Signs this browser out. Every other one stays signed in.</p>
        <button className="small" onClick={() => void api.signOut().then(() => window.location.assign("/login"))}>
          Sign out
        </button>
      </section>
    </>
  );
}

/**
 * The first password. A copy with none opens only with a link it printed, and
 * the first password is set here, by the browser already in.
 */
function First({ done }: { done: () => void }) {
  const [password, setPassword] = useState("");
  const [trouble, setTrouble] = useState("");

  async function set(event: React.FormEvent) {
    event.preventDefault();
    setTrouble("");
    try {
      await api.setup(password);
      done();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  return (
    <>
      <p className="empty">
        No password: this copy opens with a link from <code>npx chloe link</code> in its folder, which signs one browser
        in for a week. Set a password to sign in without one, from any browser that reaches this page.
      </p>
      <form className="row" onSubmit={set}>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
          aria-label="Password"
        />
        <button className="small" type="submit" disabled={password.length < 8}>
          Set password
        </button>
      </form>
      {trouble && <p className="bad">{trouble}</p>}
    </>
  );
}

/** A new name, a new password, or both, given the current password. */
function Change({ name, done }: { name: string; done: () => void }) {
  const [current, setCurrent] = useState("");
  const [newName, setNewName] = useState(name);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [trouble, setTrouble] = useState("");
  const [said, setSaid] = useState("");

  useEffect(() => setNewName(name), [name]);

  const nameChanged = newName.trim().toLowerCase() !== name;
  const ready = current && (nameChanged || password) && password === again && (!password || password.length >= 8);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setTrouble("");
    setSaid("");
    try {
      await api.changeAccount(current, { ...(nameChanged ? { name: newName } : {}), ...(password ? { password } : {}) });
      setSaid(password ? "Saved. Every other browser is signed out." : "Saved.");
      setCurrent("");
      setPassword("");
      setAgain("");
      done();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  return (
    <form className="fields" onSubmit={save}>
      <label>
        Name
        <input
          value={newName}
          autoComplete="username"
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Optional"
        />
      </label>
      <label>
        New password
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Leave empty to keep the one you have"
        />
      </label>
      {password && (
        <label>
          The new password again
          <input type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
        </label>
      )}
      <label>
        Current password
        <input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
      </label>
      {password && password.length < 8 && <p className="dim">At least 8 characters.</p>}
      {password && again && password !== again && <p className="bad">Those two are not the same.</p>}
      <div>
        <button className="small" type="submit" disabled={!ready}>
          Save
        </button>
      </div>
      {said && <p className="empty">{said}</p>}
      {trouble && <p className="bad">{trouble}</p>}
    </form>
  );
}
