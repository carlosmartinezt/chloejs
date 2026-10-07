import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import { when } from "../lib/format.ts";
import type { Token } from "../lib/types.ts";

/**
 * Tokens for other systems. The secret exists in one piece exactly once, in the
 * reply that made it, so this page shows it until the next thing happens and
 * never asks the server for it again.
 */
export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [made, setMade] = useState<{ name: string; secret: string } | null>(null);
  const [trouble, setTrouble] = useState("");

  const refresh = useCallback(async () => {
    try {
      setTokens(await api.tokens());
      setTrouble("");
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.agents().then((all) => setAgents(all.map((one) => one.id)), () => setAgents([]));
  }, [refresh]);

  async function make(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const token = await api.makeToken(name.trim(), agent || undefined);
      setMade({ name: token.name, secret: token.secret });
      setName("");
      await refresh();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  return (
    <>
      <div className="head">
        <h1>Tokens</h1>
      </div>
      <p>
        For another system to read this API and reach the agents that bind an api channel. A token cannot
        write a file, read the notes, or make and revoke tokens. Those are the account&rsquo;s.
      </p>
      <p>
        Made for one agent, it reaches that agent and nothing else. That is the kind a website&rsquo;s own
        server needs to start its visitors&rsquo; chats.
      </p>

      <form className="row" onSubmit={make}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="What is it for"
          aria-label="What the token is for"
        />
        <select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Which agent it reaches">
          <option value="">Every agent</option>
          {agents.map((one) => (
            <option key={one} value={one}>
              Only {one}
            </option>
          ))}
        </select>
        <button className="small" type="submit" disabled={!name.trim()}>
          Make one
        </button>
      </form>

      {made && (
        <div className="fresh">
          <p>
            <strong>{made.name}</strong>. Copy it now: it is not stored and cannot be shown again.
          </p>
          <pre className="token">{made.secret}</pre>
        </div>
      )}
      {trouble && <p className="bad">{trouble}</p>}

      {tokens.length === 0 && <p className="empty">None yet. Nothing but this browser can reach the API.</p>}
      <table className="tight">
        <tbody>
          {tokens.map((token) => (
            <tr key={token.id} className={token.revoked ? "dim" : undefined}>
              <td>{token.name}</td>
              <td className="dim num aside">{token.agent ? `only ${token.agent}` : "every agent"}</td>
              <td className="dim num aside">made {when(token.created)}</td>
              <td className="dim num aside">
                {token.revoked ? `revoked ${when(token.revoked)}` : token.lastUsed ? `used ${when(token.lastUsed)}` : "never used"}
              </td>
              <td className="right">
                {!token.revoked && (
                  <button className="small" onClick={() => void api.revokeToken(token.id).then(refresh)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
