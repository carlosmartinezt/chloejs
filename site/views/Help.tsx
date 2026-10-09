/** Where to ask the people who make Chloe, and what to put in the question. */
export function Help() {
  return (
    <>
      <div className="head">
        <h1>Get help</h1>
      </div>

      <section className="setting">
        <h2>Ask in the open</h2>
        <p className="empty">
          A question others might have too, or an idea: open a discussion on GitHub, where the answer helps the next
          person as well.
        </p>
        <a className="button" href="https://github.com/carlosmartinezt/chloejs/discussions/new/choose" target="_blank" rel="noreferrer">
          Open a discussion
        </a>
      </section>

      <section className="setting">
        <h2>Write to us</h2>
        <p className="empty">
          Anything else, or anything private: <a href="mailto:info@chloejs.org">info@chloejs.org</a>. It is answered
          faster with:
        </p>
        <ul className="empty">
          <li>
            The version: <code>npm ls @chloejs/core</code> in the project's folder.
          </li>
          <li>What you did, what you expected, and what happened instead.</li>
          <li>The lines it printed, or the run from the log, with any key or password taken out.</li>
          <li>Your system: Linux or Mac, and which model the agent asks.</li>
        </ul>
      </section>
    </>
  );
}
