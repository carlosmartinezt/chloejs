import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { nameOf } from "../lib/format.ts";
import type { ChannelShown } from "../lib/types.ts";
import { Link } from "./components/Link.tsx";
import { Options } from "./components/Options.tsx";

/**
 * The ways in: every channel chloe ships, with a switch and its options as a
 * form, and any the agent wrote itself. A switch or a form changes `channels`
 * in the agent's agent.ts, and a token goes to .env.
 */
export function Channels({ agent }: { agent: string }) {
  const [channels, setChannels] = useState<ChannelShown[] | null>(null);
  const [trouble, setTrouble] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let stale = false;
    setChannels(null);
    setTrouble("");
    api.channels(agent).then(
      (all) => !stale && setChannels(all),
      (error: Error) => !stale && setTrouble(missing(error, "channels")),
    );
    return () => void (stale = true);
  }, [agent]);

  const change = async (name: string, what: { on?: boolean; set?: Record<string, unknown>; secrets?: Record<string, string> }) => {
    setBusy(name);
    setTrouble("");
    try {
      setChannels(await api.setChannel(agent, { name, ...what }));
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="head">
        <h1>Channels</h1>
      </div>
      <p className="empty">
        The ways in: how a person or another system reaches {nameOf(agent)}. A switch or a form changes{" "}
        <code>channels</code> in its <code>agent.ts</code>, and the agent is loaded again with the change. A token goes to{" "}
        <code>.env</code>.
      </p>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {!trouble && channels === null && <p className="dim">Loading</p>}
      {channels && (
        <ul className="ways tools">
          {channels.map((channel) => {
            const needed = !channel.on && channel.fields.some((one) => one.required);
            return (
              <li key={channel.name} className={channel.on ? "" : "off"}>
                <span className="line">
                  <b>{channel.label}</b>
                  {!channel.own && !needed && (
                    <label className="switch">
                      <input type="checkbox" checked={channel.on} disabled={busy !== "" || channel.code} onChange={() => change(channel.name, { on: !channel.on })} />
                      {busy === channel.name ? "Saving" : channel.on ? "On" : "Off"}
                    </label>
                  )}
                </span>
                <span className="does">{channel.does}</span>
                {channel.on && channel.needs && channel.needs.missing.length > 0 && (
                  <span className="needs">
                    Needs {channel.needs.name}: {channel.needs.missing.join(" ")} <Link to={{ at: "connections", agent }}>Connections</Link>
                  </span>
                )}
                {channel.code && <span className="needs">Written as code in agent.ts, so it is changed there.</span>}
                {(channel.on || needed) && channel.fields.length > 0 && (
                  <Options
                    fields={channel.fields}
                    busy={busy !== ""}
                    needed={needed}
                    label={needed ? "Switch on" : "Save"}
                    save={(set) => change(channel.name, needed ? { on: true, set } : { set })}
                  />
                )}
                {channel.on && channel.secrets.length > 0 && (
                  <Secrets channel={channel} busy={busy !== ""} save={(secrets) => change(channel.name, { secrets })} />
                )}
                {channel.settings.length > 0 && (
                  <ul className="set">
                    {channel.settings.map((one) => (
                      <li key={one.name}>
                        <i>{one.name}</i> {one.value}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** The tokens a channel reads. A filled one shows as set and is never read back; typing a new one replaces it. */
function Secrets({ channel, busy, save }: { channel: ChannelShown; busy: boolean; save: (secrets: Record<string, string>) => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const given = Object.entries(draft).filter(([, value]) => value.trim() !== "");
  return (
    <div className="options">
      {channel.secrets.map((one) => (
        <label key={one.path}>
          <span className="name">{one.label}</span>
          <input
            type="password"
            autoComplete="off"
            disabled={busy}
            value={draft[one.path] ?? ""}
            placeholder={one.set ? "set: type to replace it" : "not set"}
            onChange={(event) => setDraft({ ...draft, [one.path]: event.target.value })}
          />
          <span className="hint">Kept in .env, never shown again.</span>
        </label>
      ))}
      <button
        className="small"
        disabled={busy || given.length === 0}
        onClick={async () => {
          await save(Object.fromEntries(given));
          setDraft({});
        }}
      >
        {busy ? "Saving" : "Save token"}
      </button>
    </div>
  );
}
