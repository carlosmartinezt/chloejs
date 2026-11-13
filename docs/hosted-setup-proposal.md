# Hosted setup and durable state

Status: proposal, not an implemented feature. Setup observations came from
0.55.0. Reports below are not claims that every issue reproduces on current
main. No runtime changes are included.

## Smallest storage change

There are two different hosting cases.

1. **A host with a durable filesystem:** keep SQLite and file-based state.
   Point `CHLOE_STATE` at a private persistent directory. Keep any separately
   configured `CHLOE_MEMORY` and `CHLOE_DB` there too. No database rewrite is
   needed. Use one process, backups, and a tested restore procedure.
2. **A host whose disk is temporary:** changing those paths is not enough.
   State must be stored outside the process. This needs a supported storage
   boundary in Chloe, not just a database connection string.

`core/db.ts` opens `node:sqlite` directly. `core/paths.ts` defines the state
and memory paths. `serve/login.ts` keeps the owner's account in a file.
Moving only conversations to another database would leave login, files,
memory history and other state behind.

### Proposed first implementation

Keep the local implementation as the default. Support one hosted process
before supporting multiple replicas.

- Inventory persistent reads and writes, including plugins. Separate
  temporary files from state that must survive.
- Put run records, steps, parked questions, conversations and access records
  behind explicit storage operations. Keep transactions and migrations.
  Add a PostgreSQL implementation for hosts without a durable disk.
- Provide durable file operations for memory, attachments and generated files.
  Preserve versions, audit-before-read behavior and agent boundaries.
  Existing filesystem and Git assumptions need adaptation, not a blind
  replacement of filesystem calls with object storage calls.
- Store account secrets, API tokens and provider sign-ins in protected durable
  storage. Keep person-specific sign-ins separate. Never expose credentials
  to models, deployment images, public buckets or source control.
- Initialize stores before loading agents. If configured storage cannot be
  reached, fail startup. Never silently create an empty local account.
- Keep self-improvement in development initially. Published code changes
  should go through a reviewed commit and deployment, not disappear at restart.

These are proposed boundaries, not new configuration options. The database
uses synchronous calls today; a remote implementation needs explicit async
changes at its callers. This is more than a one-line adapter.

### Migration and recovery

Stop writes, make a consistent SQLite backup, and export associated files
and memory history. Import into the chosen stores and check record counts,
file hashes, ownership and pending runs before switching. Keep the original
copy for rollback. Do not enable both schedulers during migration.

Do not periodically upload a live SQLite file as the primary durability
mechanism. It can lose acknowledged work and does not coordinate side effects.
Copying a database without its active WAL can also lose committed records.

### Acceptance checks

- Restart and redeploy: account access, conversations, memory, attachments and
  pending questions survive.
- Resume a parked job without repeating its completed steps.
- A lost send response does not cause an automatic duplicate message. Keep
  durable delivery records and handle uncertain delivery explicitly.
- Storage failure refuses writes and protected reads that require an audit,
  rather than claiming success.
- Restore a backup into a fresh instance and verify permissions and history.
- Refuse unsupported multiple-process scheduling, or add a shared lease before
  allowing it.
- Run the existing local suite unchanged and repeat storage behavior tests
  against the hosted implementation.

## Setup feedback

These are improvement notes, not instructions to weaken existing security.

| Area | Observation from setup | Proposed improvement and check |
| --- | --- | --- |
| First login | A loopback sign-in link cannot be opened from a remote browser. | Use an explicitly configured public address when generating links. Test behind a proxy. Never trust an arbitrary Host header. |
| Password setup | The no-password page made the terminal account command hard to discover. | Explain `npx chloe account`. Keep password setup restricted to an authenticated browser or trusted shell. Never allow the first public visitor to claim the instance. |
| Email field | The owner was asked for an email after setting only a password. | Explain whether an owner name is required. Test unnamed owners, named owners and invited people separately. |
| Logs | Startup printed a usable sign-in link. | Offer an explicit way to suppress links in hosted logs. Preserve a trusted-shell recovery path. |
| Host and port | Hosting required `0.0.0.0` and the assigned `PORT`. | Document the settings in the start guide. Retain safe local defaults and explain proxy trust. |
| Base path | Setup used the dashboard at the domain root. | Document that deployment shape. Investigate base-path support with asset, API, login and cookie tests before advertising it. |
| Custom model endpoint | An AI SDK model object worked through a hosted gateway. | Document custom `baseURL` support, required dependency majors and the distinction between model access and data access. |
| Model costs | Custom-model runs appeared unpriced. | Clearly distinguish unknown price from free usage. Document budget behavior. Current web-channel rules already refuse unpriced usage for visitor limits; preserve that protection. |
| Model selection | The model object was configured in code. | Explain picker limitations and consider a named custom-provider configuration with optional pricing. Do not hardcode model catalogs. |
| CLI job run | A 0.55.0 run reported `Cannot access 'PURPOSE_HERE' before initialization`; a script calling the job worked. | Reproduce independently before fixing. Add an isolated CLI smoke test to catch import-order failures. |
| MCP sign-in | A hosted MCP experiment required OAuth rather than static headers. | Consider discovery, PKCE, token refresh and a connection sign-in flow. Keep credentials outside model context. |
| Diagnostics | An earlier setup log disagreed with a successful custom-model run. | Treat this as unconfirmed. Add a diagnostic test that distinguishes route setup from custom model objects. |
| Memory history | Memory initialization updated the containing repository's Git exclusions. | Document this filesystem side effect and its permissions. |

## Platform-managed connections

A hosted model gateway supplies model inference. It does not supply access
to mail, messages or notes. A separate connection service authorizes those
requests. A short guide should explain both paths:

```text
Chloe model call -> model gateway -> model
Chloe tool -> provider service -> authorized data API
```

For Replit, a working app used a custom AI SDK model and provider-specific
services through the Connectors SDK. The installed connector SDK has a
deployment identity path. That supports keeping the integration, but does
not prove a particular published app has the required permissions.

Document how an external connection fits Chloe's connection lifecycle.
An owner-only platform connection must not become an invited person's
connection. Keep provider services separate from model-facing wrappers.
Use pagination and expose incomplete results, rather than presenting a
small sample as the whole account.

## Publishing checklist

- Confirm the hosting platform's storage guarantees. An always-running VM
  does not by itself guarantee persistent files.
- Keep the dashboard private and verify owner, member and token boundaries.
- Exclude development state and credentials from the deployment image.
- Verify model access and each required connector from the deployed process.
- Test a read-only job before approving any live notification.
- Keep health checks free of paid model calls and account-content reads.
- Document backup, restore, rollback and reconnect procedures.

Replit references:
- [Connectors](https://docs.replit.com/replitai/managing-connectors)
- [Publishing](https://docs.replit.com/features/publishing/overview)
- [SQL Database](https://docs.replit.com/features/data-and-storage/sql-database)
- [App Storage](https://docs.replit.com/features/data-and-storage/object-storage)
