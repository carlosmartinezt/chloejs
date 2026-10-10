import { type CSSProperties, Fragment, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { AgentSummary, Run, RunRow, Step, Visitor } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { ago, clock, dayOf, kindOf, labelOf, many, spent, text, when } from "../lib/format.ts";
import { gist } from "./Chat.tsx";
import { ChangeCard } from "./components/Changes.tsx";
import { rich } from "./components/Markdown.tsx";
import { go } from "../lib/route.ts";
import { logShare, setLogShare } from "../lib/prefs.ts";
import { Link, Trail } from "./components/Link.tsx";
import { Down, More, Tool } from "./components/Icons.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";

export function LogTable({
  rows,
  agent,
  open,
}: {
  rows: RunRow[];
  /** Set when every row is the same agent, so the column is not repeated. */
  agent?: string;
  /** The run showing in the panel, if one is. */
  open?: string;
}) {
  if (rows.length === 0) return <p className="empty">Nothing here.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          {!agent && <th>Agent</th>}
          <th>Channel</th>
          <th>Job</th>
          <th className="right">Steps</th>
          <th className="right">Cost</th>
          <th className="right" />
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => (
          <tr
            key={run.id}
            className="pick"
            aria-current={run.id === open}
            onClick={() => go({ at: "log", agent, run: run.id })}
          >
            <td className="num">
              {when(run.started)} <span className="dim">{ago(run.started)}</span>
            </td>
            {!agent && (
              <td>
                <span className="who-ran">{labelOf(run.agent)}</span>
              </td>
            )}
            <td className="num dim">{run.source}</td>
            <td className="num dim">{run.job ?? ""}</td>
            <td className="right num">{run.steps}</td>
            <td className="right num">
              {/* A job with no model step in it costs nothing, and that is worth seeing. */}
              {run.cost || run.unpriced ? spent(run.cost, run.unpriced) : <span className="free">free</span>}
            </td>
            <td className="right num">
              {run.error ? (
                <span className="bad">failed</span>
              ) : run.finished ? (
                ""
              ) : (
                <span className="dim">running</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Every run kept, narrowed by a word and by the filters in a popup, in a list
 * down the left with the one picked read beside it. The edge between them
 * drags, and stays where it was left.
 */
export function Log({
  agent,
  agents,
  open,
}: {
  agent?: string;
  /** Every agent there is, for the agent filter. */
  agents: AgentSummary[];
  open?: string;
}) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [trouble, setTrouble] = useState("");
  const [word, setWord] = useState("");
  const [channel, setChannel] = useState("");
  const [job, setJob] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [share, setShare] = useState(logShare);
  const [tip, setTip] = useState<{ run: RunRow; top: number; left: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; run: RunRow } | null>(null);
  const [archived, setArchived] = useState(false);
  const filters = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRows(null);
    api.runs(200, agent).then(setRows, (error: Error) => setTrouble(error.message));
  }, [agent]);

  // The popup closes on a click outside it and on Escape.
  useEffect(() => {
    if (!filtering) return;
    const away = (event: globalThis.PointerEvent) => {
      if (!filters.current?.contains(event.target as Node)) setFiltering(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltering(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [filtering]);

  // The channels and jobs to pick from are the ones in the runs loaded.
  const channels = useMemo(() => [...new Set((rows ?? []).map((run) => run.source))].sort(), [rows]);
  const jobs = useMemo(() => [...new Set((rows ?? []).flatMap((run) => (run.job ? [run.job] : [])))].sort(), [rows]);

  const shown = useMemo(() => {
    const looking = word.trim().toLowerCase();
    return (rows ?? []).filter((run) => {
      if (run.archived && !archived) return false;
      if (channel && run.source !== channel) return false;
      if (job && run.job !== job) return false;
      const day = dayOf(run.started);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (!looking) return true;
      // What a person would search for: who ran, what woke it, what it said,
      // and what went wrong.
      const hay = `${run.agent} ${labelOf(run.agent)} ${run.source} ${run.job ?? ""} ${run.model ?? ""} ${run.asked ?? ""} ${run.summary ?? ""} ${run.reply ?? ""} ${run.error ?? ""}`;
      return hay.toLowerCase().includes(looking);
    });
  }, [rows, word, channel, job, from, to, archived]);
  const hidden = (rows ?? []).filter((run) => run.archived).length;

  const archive = (run: RunRow, on: boolean) =>
    api.archive(run.id, on).then(
      (done) => {
        setRows((all) => all && all.map((one) => (one.id === run.id ? { ...one, archived: done.archived } : one)));
        if (on && run.id === open && !archived) go({ at: "log", agent });
      },
      (error: Error) => setTrouble(error.message),
    );

  // Escape lets go of the run, and the arrow keys move to the one above or
  // below, unless a box has the keys.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as Element).closest("input, textarea, select")) return;
      if (event.key === "Escape" && open) return go({ at: "log", agent });
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const at = shown.findIndex((run) => run.id === open);
      const next = shown[event.key === "ArrowDown" ? at + 1 : Math.max(at - 1, 0)];
      if (!next) return;
      event.preventDefault();
      go({ at: "log", agent, run: next.id });
      document.getElementById(`run-${next.id}`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shown, open, agent]);

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const edge = event.currentTarget;
    const { left, width } = (edge.parentElement as HTMLElement).getBoundingClientRect();
    edge.setPointerCapture(event.pointerId);
    let now = share;
    const move = (moved: globalThis.PointerEvent) => {
      now = Math.min(Math.max(moved.clientX - left, 240), width - 360) / width;
      setShare(now);
    };
    const done = () => {
      edge.removeEventListener("pointermove", move);
      setLogShare(now);
    };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("lostpointercapture", done, { once: true });
  };

  // How many filters are on, for the button that opens them. The agent is one
  // too, though it is the page's own rather than a filter on what was loaded.
  const on = [agent, channel, job, from, to].filter(Boolean).length;
  const narrowed = Boolean(word || channel || job || from || to);
  let day = "";

  return (
    <div className={open ? "log-split reading" : "log-split"} style={{ "--list-w": `${share * 100}%` } as CSSProperties}>
      <section className="runs" aria-label="Runs">
        <div className="runs-head">
          <h1>{agent ? `${labelOf(agent)}'s log` : "Every agent's log"}</h1>
          <span className="num dim">{rows ? (narrowed ? `${shown.length} of ${rows.length}` : rows.length) : ""}</span>
        </div>
        <div className="filters" ref={filters}>
          <input className="word" value={word} placeholder="Find a word in the log" onChange={(event) => setWord(event.target.value)} />
          <button className="small" aria-expanded={filtering} onClick={() => setFiltering(!filtering)}>
            {on ? `Filters (${on})` : "Filters"}
          </button>
          {filtering && (
            <div className="filter-pop">
              {/* Picking an agent opens that agent's log, which is a page of its own. */}
              <label>
                Agent
                <select value={agent ?? ""} onChange={(event) => go({ at: "log", agent: event.target.value || undefined })}>
                  <option value="">Every agent</option>
                  {agents.map((one) => (
                    <option key={one.id} value={one.id}>
                      {labelOf(one.id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Job
                <select value={job} onChange={(event) => setJob(event.target.value)}>
                  <option value="">Every job</option>
                  {jobs.map((one) => (
                    <option key={one}>{one}</option>
                  ))}
                </select>
              </label>
              <label>
                Channel
                <select value={channel} onChange={(event) => setChannel(event.target.value)}>
                  <option value="">Every channel</option>
                  {channels.map((one) => (
                    <option key={one}>{one}</option>
                  ))}
                </select>
              </label>
              <label>
                From
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label>
                To
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </label>
              <button
                className="plain"
                disabled={!on}
                onClick={() => {
                  setChannel("");
                  setJob("");
                  setFrom("");
                  setTo("");
                  if (agent) go({ at: "log" });
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {trouble ? (
          <p className="bad">{trouble}</p>
        ) : !rows ? (
          <p className="dim">Loading</p>
        ) : shown.length === 0 ? (
          <p className="empty">{narrowed ? "Nothing in the log matches that." : "Nothing has run yet."}</p>
        ) : (
          <ul className="run-list" onMouseLeave={() => setTip(null)}>
            {shown.map((run) => {
              const today = dayOf(run.started);
              const heading = today !== day ? (day = today) : "";
              const state = run.error ? "bad" : run.finished ? "" : "busy";
              return (
                <Fragment key={run.id}>
                  {heading && <li className="day">{dayName(run.started)}</li>}
                  <li
                    className={menu?.run.id === run.id ? "held" : undefined}
                    onMouseEnter={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      setTip({ run, top: Math.min(box.top, window.innerHeight - 260), left: box.right + 10 });
                    }}
                  >
                    <button
                      id={`run-${run.id}`}
                      className="plain"
                      aria-current={run.id === open}
                      onClick={() => go({ at: "log", agent, run: run.id })}
                    >
                      <span className={`dot ${state}`} />
                      <span className="line">
                        <span className={run.archived ? "headline dim" : "headline"}>{headline(run)}</span>
                        <span className="about">
                          <span className="agent">{labelOf(run.agent)}</span>
                          {[run.source, run.job].filter(Boolean).map((one) => `, ${one}`)}
                          {answered(run)}
                        </span>
                      </span>
                      <span className="num dim">{spent(run.cost, run.unpriced)}</span>
                      <span className="num dim">{clock(run.started).slice(0, 5)}</span>
                    </button>
                    <button
                      className="plain more"
                      title="More"
                      aria-label="More"
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        setTip(null);
                        setMenu({ x: box.right, y: box.bottom + 4, run });
                      }}
                    >
                      <More />
                    </button>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        )}
        {hidden > 0 && (
          <button className="plain show-archived" onClick={() => setArchived(!archived)}>
            {archived ? "Hide archived" : `Show ${many(hidden, "archived run")}`}
          </button>
        )}
        {menu && (
          <ContextMenu
            at={menu}
            from="right"
            close={() => setMenu(null)}
            choices={[{ label: menu.run.archived ? "Unarchive" : "Archive", run: () => void archive(menu.run, !menu.run.archived) }]}
          />
        )}
        {tip && !menu && <RunTip {...tip} />}
      </section>

      <div className="edge" role="separator" aria-orientation="vertical" title="Drag to resize" onPointerDown={drag} />

      <section className="reader" aria-label="Run">
        {open ? (
          <>
            <a className="back" href="#" onClick={(event) => (event.preventDefault(), go({ at: "log", agent }))}>
              All runs
            </a>
            <RunDetail id={open} agents={agents} />
          </>
        ) : (
          <p className="empty">Pick a run to read it.</p>
        )}
      </section>
    </div>
  );
}

/** Somebody talking to the agent, rather than a job: its line is what they asked. */
const asked = (run: RunRow) => (!run.job && run.asked ? run.asked : "");

/** What a run comes to, in a line: what was asked, else its summary, else what it said, else what it was. */
function headline(run: RunRow): string {
  if (run.error) return `Failed: ${gist(run.error)}`;
  return gist(asked(run) || run.summary || run.reply || run.job || `started by ${run.source}`);
}

/** Under a question, the answer it got. */
const answered = (run: RunRow) => (asked(run) && !run.error && (run.summary || run.reply) ? `: ${gist(run.summary || run.reply || "")}` : "");

/** "Today", "Yesterday", or the date, for a heading over a day's runs. */
function dayName(iso: string): string {
  const day = dayOf(iso);
  const now = Date.now();
  if (day === dayOf(new Date(now).toISOString())) return "Today";
  if (day === dayOf(new Date(now - 864e5).toISOString())) return "Yesterday";
  return when(iso).split(",")[0];
}

/** Everything else about a run, beside its line while the pointer is on it. */
function RunTip({ run, top, left }: { run: RunRow; top: number; left: number }) {
  const facts: [string, string][] = [
    ["time", `${when(run.started)}, ${ago(run.started)}`],
    ["agent", labelOf(run.agent)],
    ["channel", run.source],
    ...(run.job ? [["job", run.job] as [string, string]] : []),
    ...(run.model ? [["model", run.model] as [string, string]] : []),
    ["steps", String(run.steps)],
    ["cost", spent(run.cost, run.unpriced)],
    ["state", run.error ? "failed" : run.finished ? "finished" : "running"],
    ...(run.archived ? [["archived", when(run.archived)] as [string, string]] : []),
  ];
  return (
    <div className="run-tip" style={{ top, left }} role="tooltip">
      {run.error && <p className="bad">{gist(run.error)}</p>}
      <dl className="facts">
        {facts.map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd className={name === "state" && run.error ? "bad" : undefined}>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** For a job's prompt the service stopped in the middle of, or that ran out of steps: pick it up again, in the same run. */
function CarryOn({ id, why, started }: { id: string; why: "cut off" | "out of steps"; started: () => void }) {
  const [trouble, setTrouble] = useState("");
  const [sending, setSending] = useState(false);
  const press = () => {
    setSending(true);
    api.carryOn(id).then(started, (error: Error) => {
      setSending(false);
      setTrouble(error.message);
    });
  };
  return (
    <p className="carry-on">
      <button className="small" disabled={sending} onClick={press}>
        {why === "out of steps" ? "Give it more steps" : "Carry on from here"}
      </button>
      <span className={trouble ? "bad" : "dim"}>
        {trouble ||
          (why === "out of steps"
            ? "It ran out of steps. This gives it as many again and picks up where it stopped, in this same run."
            : "It picks up where the service stopped it, in this same run.")}
      </span>
    </p>
  );
}

function RunDetail({ id, agents }: { id: string; agents: AgentSummary[] }) {
  const [run, setRun] = useState<Run | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    setRun(null);
    setTrouble("");
    api.run(id).then(setRun, (error: Error) => setTrouble(error.message));
  }, [id]);

  // A run still going writes its trace step by step, so it is read again
  // until it finishes.
  const going = run !== null && !run.finished && !run.parked;
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => void api.run(id).then(setRun, () => {}), 1500);
    return () => clearInterval(timer);
  }, [id, going]);

  if (trouble) return <p className="bad">{trouble}</p>;
  if (!run) return <p className="dim">Loading</p>;

  const lasted = run.finished ? took(Date.parse(run.finished) - Date.parse(run.started)) : "";
  return (
    <>
      <div className="head">
        <div>
          <Trail agent={run.agent} steps={[{ name: "log", to: { at: "log", agent: run.agent } }, { name: run.job ?? run.source }]} />
          <h1 className="outcome">
            {run.error ? (
              "It failed"
            ) : run.summary ? (
              <>
                <span className="dim">Summary: </span>
                {run.summary}
              </>
            ) : (
              when(run.started)
            )}
          </h1>
          <p className="when num">
            {when(run.started)}
            {lasted && `, took ${lasted}`}
            {`, ${spent(run.cost, run.unpriced)}`}
          </p>
        </div>
      </div>

      {run.job && <JobLine run={run} job={agents.find((one) => one.id === run.agent)?.jobs.find((one) => one.id === run.job)} />}
      <RunThread run={run} />
      {run.carryOn && <CarryOn id={id} why={run.carryOn} started={() => setRun({ ...run, carryOn: false, finished: null, error: null })} />}

      {run.commits && run.commits.length > 0 && (
        <div className="run-changes">
          <p className="event num">What it changed</p>
          {run.commits.map((one) => (
            <ChangeCard key={`${one.in}-${one.id}`} agent={run.agent} change={one} />
          ))}
        </div>
      )}

      {run.state && run.state !== "{}" && (
        <details className="call">
          <summary>
            <b>State it carried</b>
          </summary>
          <div className="open">
            <Value value={parsed(run.state) ?? run.state} />
          </div>
        </details>
      )}
    </>
  );
}

/** Which job a run was and what started it, with what the job is for and the files it is made of. */
function JobLine({ run, job }: { run: Run; job?: AgentSummary["jobs"][number] }) {
  return (
    <header className="run-job">
      <b className="num">{run.job}</b>
      {job?.description && <p>{job.description}</p>}
      <p className="num dim">
        {job?.files.map((path) => (
          <Link key={path} to={{ at: "file", agent: run.agent, path }} className={kindOf(path)}>
            {path}
          </Link>
        ))}
        {`started by ${run.source}`}
      </p>
    </header>
  );
}

/**
 * A run told as a conversation: what started it on the right, what the agent
 * said on the left as plain words, and everything it did between (the tools,
 * the steps, what the model was given) folded into one line between them that
 * opens to every detail. Who said it and when shows under each message on a
 * hover, so the words themselves are what you read.
 */
function RunThread({ run }: { run: Run }) {
  const agent = labelOf(run.agent);
  // A job's last model answer is often its reply too, so that is not said twice.
  const said = run.trace.map((step) => step.say ?? (step.kind === "model" ? step.result : undefined)).filter(Boolean);
  const parts: Part[] = [];
  const work = (item: Work) => {
    const last = parts.at(-1);
    if (last && "work" in last) last.work.push(item);
    else parts.push({ work: [item] });
  };
  const show = (node: ReactNode) => parts.push({ show: node });

  if (run.context) {
    const context = parsed(run.context) ?? run.context;
    work({ name: "Agent context", step: { result: context }, body: <Context value={context} /> });
  }
  run.trace.forEach((step, at) => {
    if (step.kind === "ask") {
      show(<Them key={at} who="" meta={saidBy(`${agent} asked`, step.at)} words={step.question ?? step.name ?? ""} />);
      show(
        step.reply !== undefined ? (
          <You key={`${at}-reply`} who={step.note ?? ""} words={step.reply} />
        ) : (
          <p key={`${at}-reply`} className="event num">
            {step.note}, so it carried on with {brief(step.result)}
          </p>
        ),
      );
      return;
    }
    if (step.kind === "model") {
      const model = (step.note ?? "the model").split("/").pop();
      if (step.prompt) work({ name: `What ${model} was asked`, step: { at: startedAt(step), result: step.prompt } });
      show(
        <div key={at} className="msg them model">
          <div className="who">{`${model} on ${step.name}`}</div>
          <Answer value={step.result} />
          <Meta words={saidBy(`answered${step.ms ? ` in ${took(step.ms)}` : ""}`, step.at, spent(step.cost, step.unpriced))} />
        </div>,
      );
      return;
    }
    // An agent step is one line in the record with every call it made inside
    // it, so the calls come first and the step's answer last, which is the
    // order they happened in.
    if (step.kind === "agent") {
      const model = (step.note ?? "the model").split("/").pop();
      if (step.prompt) work({ name: `The goal ${model} was given`, step: { at: startedAt(step), result: step.prompt } });
      step.calls?.forEach((call) =>
        work({ name: call.toolName, tool: true, step: { args: call.input, result: call.output, ...(call.refused && { note: "not allowed" }) } }),
      );
      work({ name: step.name ?? "", tool: true, step });
      return;
    }
    if (step.carried) return show(<p key={at} className="event num">{step.carried}</p>);
    if (step.kind) return work({ name: step.name ?? "", tool: true, step });
    if (step.tool) return work({ name: step.tool, tool: true, step });
    // A model turn that only asked for tools has nothing to read: its cost is
    // in the run's total.
    if (step.say) {
      show(
        <div className="msg them" key={at}>
          <div className="said">{rich(step.say)}</div>
          <Meta words={saidBy(agent, step.at, spent(step.cost, step.unpriced))} />
        </div>,
      );
    }
    // Shown on its own, not folded in with the calls that did run.
    if (step.dropped) {
      show(
        <WorkDone
          key={`${at}-dropped`}
          verb="Used"
          items={[{ name: "Wrote what the tools would say before they ran, set aside unread", step: { at: step.at, result: step.dropped } }]}
        />,
      );
    }
  });

  return (
    <div className="thread run-thread">
      {run.prompt && (
        <Prompt
          source={run.source}
          at={run.started}
          prompt={run.prompt}
          visitor={run.source === "web" && run.owner?.startsWith("web:") ? { agent: run.agent, id: run.owner.slice(4) } : undefined}
        />
      )}

      {parts.map((part, at) => ("work" in part ? <WorkDone key={`work-${at}`} items={part.work} verb={run.job ? "Ran" : "Used"} /> : part.show))}

      {/* A prompt's reply is already its last words above. */}
      {run.reply && !said.includes(run.reply) && <Them who="" words={run.reply} meta={saidBy(`${agent} finished`, run.finished)} />}
      {run.parked && <p className="event num">{waitingOn(run.parked)}</p>}
      {run.error && (
        <div className="msg them bad">
          <div className="said">{run.error}</div>
          <Meta words={saidBy(`${agent} failed`, run.finished)} />
        </div>
      )}
      {!run.finished && !run.parked && (
        <p className="thinking">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          Working
        </p>
      )}
    </div>
  );
}

/** One thing the agent did between its words: a tool call, a job step, or what it was given. */
interface Work {
  name: string;
  step: Step;
  /** What it opens to, when the usual layout of a result is not the way to read it. */
  body?: ReactNode;
  /** Set when it is a call or a step, as against something the model read. */
  tool?: boolean;
}
type Part = { work: Work[] } | { show: ReactNode };

/** Everything done between two messages, folded to one line that says what. */
function WorkDone({ items, verb }: { items: Work[]; verb: string }) {
  const tools = items.filter((item) => item.tool);
  const bad = items.some((item) => item.step.failed);
  const names = [...new Set(tools.map((item) => item.name))];
  const label =
    tools.length === 0
      ? items.map((item) => item.name).join(", ")
      : `${verb} ${names.length > 4 ? `${tools.length} ${verb === "Ran" ? "steps" : "tools"}` : listed(names)}${tools.length > names.length && names.length <= 4 ? `, ${tools.length} times in all` : ""}`;
  return (
    <details className={bad ? "work bad" : "work"} open={bad}>
      <summary>
        <Tool />
        <span>{label}</span>
        <Down />
      </summary>
      <div className="did">
        {items.map((item, at) => (
          <Card key={at} name={item.name} step={item.step} body={item.body} />
        ))}
      </div>
    </details>
  );
}

/** Names as a person would list them: "a, b and c". */
function listed(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What a person said: what started a run, or a line in a chat. A channel puts what it knows about the sender in a
 * tagged block before the message, like <telegram_context>. That is for the
 * model, so here it moves out of the message into a note beside the channel's
 * name, opened on a click.
 */
export function Prompt({
  source,
  at,
  prompt,
  stamp = clock,
  visitor,
}: {
  source?: string;
  at?: string | null;
  prompt: string;
  /** How `at` is shown: the time alone inside one run, and more where a page spans days. */
  stamp?: (iso: string | null) => string;
  /** A web channel's visitor who said it: what the runtime keeps on them and the model is not shown is added to the note. */
  visitor?: { agent: string; id: string };
}) {
  const found = /^\s*<([a-z_]+)>\n?([\s\S]*?)\n?<\/\1>\s*/.exec(prompt);
  const words = found ? prompt.slice(found[0].length) : prompt;
  const kept = useVisitor(visitor);
  const fields = found ? fieldsIn(found[2]) : undefined;
  const shown = kept?.ip && fields && typeof fields === "object" ? { ...fields, "IP address": kept.ip } : fields;
  return (
    <div className="msg you">
      {(found || source) && (
        <div className="who">
          {found && (
            <details className="note">
              <summary>{found[1].replace(/^.*_/, "")}</summary>
              <div className="pop">
                <Value value={shown} />
              </div>
            </details>
          )}
          {source && <span>{source}</span>}
        </div>
      )}
      <div className="bubble">
        <Folded words={words || prompt} />
      </div>
      <Meta words={stamp(at ?? null)} />
    </div>
  );
}

/** "from: Carlos" lines as fields, or the text as it was when it is not that. */
/** Each agent's visitors, asked for once per page load and shared by every message that names one. */
const visitorsOf = new Map<string, Promise<Visitor[]>>();

/** What the runtime keeps on one visitor, once it has answered, or undefined. */
function useVisitor(visitor?: { agent: string; id: string }): Visitor | undefined {
  const [found, setFound] = useState<Visitor>();
  useEffect(() => {
    if (!visitor) return;
    let stale = false;
    if (!visitorsOf.has(visitor.agent)) visitorsOf.set(visitor.agent, api.visitors(visitor.agent).catch(() => []));
    visitorsOf.get(visitor.agent)!.then((all) => !stale && setFound(all.find((one) => one.id === visitor.id)));
    return () => void (stale = true);
  }, [visitor?.agent, visitor?.id]);
  return found;
}

function fieldsIn(block: string): unknown {
  const lines = block.split("\n").filter((line) => line.trim());
  const pairs = lines.map((line) => /^\s*([\w ]+):\s?(.*)$/.exec(line));
  if (pairs.some((pair) => !pair)) return block;
  return Object.fromEntries(pairs.map((pair) => [pair![1], pair![2]]));
}

/** Who said it and when, under a message, shown on a hover. */
function Meta({ words }: { words: string }) {
  return words ? <div className="meta num">{words}</div> : null;
}

/** What a person said: a bubble on the right. */
function You({ who, words }: { who: string; words: string }) {
  return (
    <div className="msg you">
      {who && <div className="who">{who}</div>}
      <div className="bubble">{words}</div>
    </div>
  );
}

/** Who said something, and when, when that was kept: "Chloe, 18:13:08, $0.0187". */
function saidBy(who: string, at?: string | null, ...more: string[]): string {
  return [who, clock(at), ...more].filter(Boolean).join(", ");
}

/** A job's line is stamped when it finished, so what it was asked went in that long before. */
function startedAt(step: Step): string | undefined {
  return step.at && step.ms ? new Date(Date.parse(step.at) - step.ms).toISOString() : step.at;
}

/** Long words folded to their first line, opened on a click. */
function Folded({ words }: { words: string }) {
  if (words.length <= 600) return <>{words}</>;
  return (
    <details>
      <summary>{gist(words)}</summary>
      {words}
    </details>
  );
}

/** What the agent said. A job's reply is often data, and reads better as data. */
function Them({ who, words, meta = "" }: { who: string; words: string; meta?: string }) {
  const data = /^\s*[[{]/.test(words) ? parsed(words) : undefined;
  return (
    <div className="msg them">
      {who && <div className="who">{who}</div>}
      {data === undefined ? <div className="said">{rich(words)}</div> : <Answer value={data} />}
      <Meta words={meta} />
    </div>
  );
}

/** A model's answer: each field it filled in, under the field's name. */
function Answer({ value }: { value: unknown }) {
  if (typeof value === "string") return <div className="said">{rich(value)}</div>;
  if (!isObject(value)) return <Value value={value} />;
  // Short fields read best side by side, as a table of names and values.
  const short = Object.values(value).every((one) => isScalar(one) && !(typeof one === "string" && (one.includes("\n") || one.length > 120)));
  if (short) {
    return (
      <div className="answer">
        <Value value={value} />
      </div>
    );
  }
  return (
    <div className="answer">
      {Object.entries(value).map(([field, one]) => (
        <div key={field}>
          <div className="field">{words(field)}</div>
          {typeof one === "string" ? <div className="said">{rich(one)}</div> : <Value value={one} />}
        </div>
      ))}
    </div>
  );
}

function parsed(words: string): unknown {
  try {
    return JSON.parse(words);
  } catch {
    return undefined;
  }
}

/** Every message the agent was handed before it answered, each under who it is from, wrapped to the width. */
function Context({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return <Value value={value} />;
  return (
    <div className="context">
      {value.map((one, at) => {
        const message: Plain = isObject(one) ? one : { content: one };
        const content = typeof message.content === "string" ? message.content : text(message.content);
        return (
          <div key={at}>
            <div className="field">{String(message.role ?? "")}</div>
            <Folded words={content} />
          </div>
        );
      })}
    </div>
  );
}

/** A tool call or a job step, folded to one line. A failed one opens itself. */
function Card({ name, step, body }: { name: string; step: Step; body?: ReactNode }) {
  const facts = [clock(step.at), step.ms ? took(step.ms) : "", step.cost || step.unpriced ? spent(step.cost, step.unpriced) : "", step.note ?? ""].filter(Boolean);
  const gist =
    typeof step.failed === "string" ? step.failed : body && Array.isArray(step.result) ? many(step.result.length, "message") : brief(step.result);
  const script = scriptRun(step.result);
  const bad = Boolean(step.failed) || (script !== null && script.exitCode !== 0);
  return (
    <details className={bad ? "call bad" : "call"} open={Boolean(step.failed)}>
      <summary>
        <b>{name}</b>
        <span className="gist">{gist}</span>
        {facts.length > 0 && <span className="kind">{facts.join(", ")}</span>}
      </summary>
      <div className="open">
        {step.args !== undefined && (
          <>
            <div className="field">asked with</div>
            <Value value={step.args} />
            <div className="field">got back</div>
          </>
        )}
        {body ?? (typeof step.failed === "string" ? <div className="bubble">{step.failed}</div> : <Value value={step.result} />)}
      </div>
    </details>
  );
}

/** How long something took, in the unit a person would say it in. */
function took(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

type Plain = Record<string, unknown>;
const isObject = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown) => value === null || typeof value !== "object";
const isRow = (value: unknown): value is Plain => isObject(value) && Object.values(value).every(isScalar);

/** A field name as words: diskPercent reads as "disk percent". */
const words = (field: string) => field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;
function scalar(value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (typeof value === "string") return ISO.test(value) ? when(value) : value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" && !Number.isInteger(value)) return String(Number(value.toFixed(2)));
  return String(value);
}

interface ScriptRun {
  script: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
}
function scriptRun(value: unknown): ScriptRun | null {
  return isObject(value) && typeof value.script === "string" && typeof value.exitCode === "number"
    ? (value as unknown as ScriptRun)
    : null;
}

/** One line saying what came back, for the folded card. */
function brief(value: unknown): string {
  const script = scriptRun(value);
  if (script) return `ran ${script.script}, ${script.exitCode === 0 ? "it finished" : `it exited ${script.exitCode}`}`;
  if (typeof value === "string") return gist(scalar(value));
  if (isScalar(value)) return scalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "nothing";
    if (value.every(isScalar)) return gist(value.map(scalar).join("; "));
    if (!value.every(isRow)) return `${value.length} things`;
    // Rows that all agree on something say so, like five services all active.
    const same = Object.keys(value[0]).filter(
      (field) => value.length > 1 && value.every((row) => row[field] === value[0][field]),
    );
    if (same.length > 0) return gist(`${value.length}, all ${same.map((field) => `${words(field)} ${scalar(value[0][field])}`).join(", ")}`);
    return gist(`${value.length === 1 ? "one" : `${value.length}, the last`}: ${fieldsOf(value.at(-1) as Plain)}`);
  }
  return gist(fieldsOf(value as Plain));
}

/** An object's fields in a line: "disk percent 65, at 19 Sept, 07:00". */
function fieldsOf(value: Plain): string {
  return Object.entries(value)
    .map(([field, one]) =>
      isScalar(one) ? `${words(field)} ${scalar(one)}` : `${words(field)} (${Array.isArray(one) ? one.length : Object.keys(one as Plain).length})`,
    )
    .join(", ");
}

/**
 * Anything a step returned, laid out to be read: a table for rows, a list of
 * fields for an object, a script's output as it printed it.
 */
function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const script = scriptRun(value);
  if (script) {
    return (
      <>
        <p className="exit">
          {script.script} {script.exitCode === 0 ? "finished" : `exited ${script.exitCode}`}
        </p>
        {script.stdout && <pre>{script.stdout}</pre>}
        {script.stderr && <pre className="bad">{script.stderr}</pre>}
      </>
    );
  }
  if (typeof value === "string") return value.includes("\n") || value.length > 120 ? <pre>{value}</pre> : <p>{scalar(value)}</p>;
  if (isScalar(value)) return <p>{scalar(value)}</p>;
  if (depth > 2) return <pre>{text(value)}</pre>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="dim">nothing</p>;
    if (value.every(isRow)) return <Rows rows={value} />;
    if (value.every(isScalar)) {
      return (
        <ul>
          {value.map((one, at) => (
            <li key={at}>{scalar(one)}</li>
          ))}
        </ul>
      );
    }
    return <pre>{text(value)}</pre>;
  }

  const entries = Object.entries(value as Plain);
  // An object of rows, like one line per site, is a table with its names down the side.
  if (entries.length > 1 && entries.every(([, one]) => isRow(one))) {
    return <Rows rows={entries.map(([name, one]) => ({ "": name, ...(one as Plain) }))} />;
  }
  return (
    <dl className="fields">
      {entries.map(([field, one]) => (
        <div key={field}>
          <dt>{words(field)}</dt>
          <dd>
            <Value value={one} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Rows({ rows }: { rows: Plain[] }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="rows">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{words(column)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, at) => (
            <tr key={at}>
              {columns.map((column) => (
                <td key={column} className="num">
                  {column in row ? scalar(row[column]) : ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What a parked run is waiting for, out of the record it left. */
function waitingOn(parked: string): string {
  try {
    const one = JSON.parse(parked) as { who: string; question: string; expires: string; wait?: true };
    if (one.wait) return `Waiting until ${when(one.expires)}.`;
    return `Waiting on ${one.who} until ${when(one.expires)}: ${one.question}`;
  } catch {
    return "Waiting on an answer.";
  }
}
