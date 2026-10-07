import { useState, type FormEvent } from "react";

import { api, useLoad } from "../api.ts";
import { ago, day, exact } from "../format.ts";

/**
 * Tokens for other systems. The secret exists in one piece once, in the reply
 * that made it, so it is shown until the page moves on and never asked for again.
 */
export function Tokens() {
  const { data: tokens, trouble: listing, reload } = useLoad(api.tokens, []);
  const { data: agents } = useLoad(api.agents, []);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [made, setMade] = useState<{ name: string; agent?: string; secret: string }>();
  const [copied, setCopied] = useState(false);
  const [trouble, setTrouble] = useState("");

  async function make(event: FormEvent) {
    event.preventDefault();
    try {
      const token = await api.makeToken(name.trim(), agent || undefined);
      setMade({ name: token.name, agent: token.agent, secret: token.secret });
      setCopied(false);
      setName("");
      setTrouble("");
      reload();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  async function revoke(id: string, called: string) {
    if (!confirm(`Revoke ${called}? Anything using it stops working now.`)) return;
    try {
      await api.revokeToken(id);
      reload();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  return (
    <>
      <h1>Tokens</h1>
      <p className="dim">
        For another system to read this API and reach the agents that bind an api channel. A token cannot write a
        file, read a memory, or make and revoke tokens. Made for one agent, it reaches that agent and nothing else,
        which is the kind a website&rsquo;s own server needs to start its visitors&rsquo; chats.
      </p>

      <form className="row" onSubmit={make}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="What is it for"
          aria-label="What the token is for"
          required
        />
        <select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Which agent it reaches">
          <option value="">Every agent on the api</option>
          {agents?.map((one) => (
            <option key={one.id} value={one.id}>
              Only {one.label || one.id}
            </option>
          ))}
        </select>
        <button className="primary" type="submit" disabled={!name.trim()}>
          Make one
        </button>
      </form>

      {made && (
        <div className="fresh">
          <p>
            <strong>{made.name}</strong>
            {made.agent ? `, for ${made.agent} only` : ""}. Copy it now: it is not stored and cannot be shown again.
          </p>
          <div className="row">
            <pre className="secret">{made.secret}</pre>
            <button
              onClick={() => void navigator.clipboard?.writeText(made.secret).then(() => setCopied(true))}
              disabled={!navigator.clipboard}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {(trouble || listing) && <p className="bad">{trouble || listing}</p>}

      {tokens?.length === 0 && <p className="dim">None yet. Only a signed-in browser can reach the API.</p>}
      {!!tokens?.length && (
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Reaches</th>
                <th>Made</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id} className={token.revoked ? "gone" : undefined}>
                  <td>{token.name}</td>
                  <td>{token.agent ? <code>{token.agent}</code> : <span className="dim">every agent on the api</span>}</td>
                  <td className="dim nowrap" title={exact(token.created)}>{day(token.created)}</td>
                  <td className="dim nowrap" title={token.lastUsed ? exact(token.lastUsed) : undefined}>
                    {ago(token.lastUsed)}
                  </td>
                  <td className="right">
                    {token.revoked ? (
                      <span className="dim nowrap">revoked {day(token.revoked)}</span>
                    ) : (
                      <button className="small" onClick={() => void revoke(token.id, token.name)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
