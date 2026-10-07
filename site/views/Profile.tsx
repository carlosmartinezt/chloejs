import { Fragment, useEffect, useState } from "react";

import { cloud, NeedsSignIn } from "../lib/api.ts";
import { initials, many } from "../lib/format.ts";
import { go } from "../lib/route.ts";
import { Link } from "./components/Link.tsx";
import type { Me, Workspace } from "../lib/types.ts";

/**
 * Who is signed in. A cloud knows a person by the address they signed up with,
 * the name they choose to go by and the organizations they are in; a runtime of
 * its own has one password and nobody to tell apart, so it sends people to
 * Account settings instead.
 */
export function Profile({
  onCloud,
  me,
  said,
}: {
  onCloud: boolean;
  me: Me | null;
  /** The account as it is now, so the bar changes with the page. */
  said: (me: Me) => void;
}) {
  const [all, setAll] = useState<Workspace[] | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    if (!onCloud) return;
    let stale = false;
    cloud.workspaces().then(
      (workspaces) => !stale && setAll(workspaces),
      (error) => {
        if (stale) return;
        if (error instanceof NeedsSignIn) return go({ at: "signin", making: false });
        setTrouble((error as Error).message);
      },
    );
    return () => void (stale = true);
  }, [onCloud]);

  if (!onCloud) {
    return (
      <>
        <div className="head">
          <h1>My profile</h1>
        </div>
        <p className="empty">
          This runtime signs in with one password and keeps no profile.{" "}
          <Link to={{ at: "settings" }}>Account settings</Link> is where to change how the page looks.
        </p>
      </>
    );
  }

  const online = all?.filter((one) => one.online).length ?? 0;

  return (
    <div className="profile">
      <div className="head">
        <h1>My profile</h1>
      </div>
      {trouble && <p className="bad">{trouble}</p>}
      {!me ? (
        <p className="dim">Loading</p>
      ) : (
        <>
          <div className="card">
            <span className="avatar" aria-hidden="true">
              {initials(me.name || me.email.split("@")[0])}
            </span>
            <div>
              <h2 className={me.name ? undefined : "none"}>{me.name || "No name yet"}</h2>
              <p>{me.email}</p>
            </div>
          </div>

          <section>
            <Name me={me} said={said} />
          </section>

          <section>
            <h3>Account</h3>
            <dl className="details">
              <dt>Email</dt>
              <dd>{me.email}</dd>
              {me.organizations.map((one) => (
                <Fragment key={one.id}>
                  <dt>Organization</dt>
                  <dd>
                    {one.name} ({one.role})
                  </dd>
                </Fragment>
              ))}
              <dt>Workspaces</dt>
              <dd>{all ? `${many(all.length, "workspace")}, ${online} connected now` : "Counting"}</dd>
            </dl>
          </section>
        </>
      )}
    </div>
  );
}

/** The name, typed in and saved. Empty is allowed: then the address stands in for it. */
function Name({ me, said }: { me: Me; said: (me: Me) => void }) {
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [trouble, setTrouble] = useState("");
  const changed = name.trim() !== me.name;

  async function save() {
    setBusy(true);
    try {
      said(await cloud.setName(name.trim()));
      setSaved(true);
      setTrouble("");
    } catch (error) {
      if (error instanceof NeedsSignIn) return go({ at: "signin", making: false });
      setTrouble((error as Error).message);
    }
    setBusy(false);
  }

  return (
    <>
      <label htmlFor="profile-name">Name</label>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) void save();
        }}
      >
        <input
          id="profile-name"
          value={name}
          placeholder="Enter your name"
          autoComplete="name"
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
        <button className="go small" type="submit" disabled={!changed || busy}>
          Save
        </button>
        {saved && !changed && <span className="dim">Saved</span>}
      </form>
      {trouble && <p className="bad">{trouble}</p>}
    </>
  );
}
