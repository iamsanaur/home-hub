# HomeHub plugin SDK

A plugin is a **manifest** (what it does, touches and risks) plus **handlers** (the code). The runtime enforces the manifest;
nothing outside it is callable. Source: `backend/firebase/functions/src/plugins/` (`manifest.ts`, `sdk.ts`, `runtime.ts`).
Working examples: `builtins/webhook.ts` (smallest), `builtins/telegram.ts` (channel), `builtins/googleCalendar.ts`
(read-only data), `builtins/homeAssistant.ts` (devices + sync).

## Anatomy

```ts
export const myPlugin = definePlugin({
  manifest: { manifestVersion: 1, id: "acme.thing", name: "…", version: "1.0.0", tier: "community", … },
  handlers: { healthCheck, tools: { do_thing: async (ctx, input) => … } },
});
```

`definePlugin` fails at load if a declared tool has no handler. Register built-ins in `catalog.ts` (`BUILTIN_PLUGINS`);
the manifest is validated at startup and the server refuses to boot with an invalid one.

## What a handler can do (`PluginContext`)

| Capability | Notes |
| --- | --- |
| `config` | Non-secret setup values chosen by the household |
| `secret(key)` | Declared secret fields only, resolved from Secret Manager at call time |
| `fetch(url)` | **Only** hosts in `manifest.network` (https) or a `userNetworkFields` URL; timeout and size limits applied |
| `store` | Key/value storage private to this integration |
| `reportDevice()` | Smart-home plugins report device state; the runtime maps it onto HomeHub devices |
| `log()`, `now()` | Structured log (secrets are never logged), injectable clock for tests |

There is no database handle, filesystem, shell or unrestricted network. A plugin cannot read household data except what
its own tools return, and its tool output is treated as **untrusted data** by the assistant.

## Manifest rules (enforced by `validateManifest`)

- Tool `risk` is `low|medium|high|critical`; `confirmation` is `none|confirm|approval`.
- Critical or physical-safety tools (locks, alarms, ovens, garage doors, valves…) **must** require `approval`.
- High-risk writes cannot use `confirmation: "none"`. Anything that sends data outside HomeHub (messages, bookings, purchases) should be `approval`.
- Network destinations are https allowlists. Config keys that look sensitive (`token`, `secret`, `password`, `apiKey`) must be `secret: true`.
- OAuth plugins must implement `disconnect` (token revocation).
- `minApiVersion` cannot exceed the server's `PLUGIN_API_VERSION` (currently 1).

## Versioning

- `version` is semver. **Patch**: fixes. **Minor**: new optional tools/config/events. **Major**: removed or changed tools, scopes, network hosts or data categories.
- Any change to tools, `network`, `auth.scopes` or `dataCategories` is a *permission change* and must be a major bump (or a reviewed minor bump that only adds read-only tools). Automatic re-consent prompts for existing households are **not built yet**: for now a permission change ships as a new plugin version that households reconnect.
- `manifestVersion` (the manifest format) and `minApiVersion` (the runtime) move independently of the plugin's own version.
- Never reuse a version number.

## Diagnostics

- Every plugin with `lifecycle.healthCheck` is probed from **Settings → Connections**; the result (ok / message) is shown to the household and never contains secrets.
- Every tool call is written to the integration audit log with its result (`succeeded`, `failed`, `denied`, `approval_required`) and appears in the household audit view; connect, pause, resume, disconnect and permission changes are audited too.
- Plugin errors surface as short, actionable messages. Write them for the person (“Telegram rejected the bot token”), and never echo URLs that contain credentials.
- Use the injectable `ctx.now()` and a fake `ctx.fetch` in unit tests; see `test/unit/channelsCalendar.test.ts`.

## Validating a manifest

```bash
npx tsx scripts/validate-plugin.ts path/to/manifest.json
```

Prints every error and warning and exits non-zero on errors. Run it in CI for any plugin repository.

## Publishing tiers

| Tier | Who | Review |
| --- | --- | --- |
| `first_party` | HomeHub | Normal code review |
| `verified_partner` | Companies with an agreement | Certification checklist + security review |
| `community` | Anyone | Listed as unverified; read-only tools only until reviewed |
| `custom` | A single household (e.g. signed webhook) | Never listed; limited to that household |

See `docs/plugin-certification.md` for the checklist. A marketplace listing service (browse, install, rate) is **not built**; today
plugins ship inside the server build and are listed by `catalog()`.
