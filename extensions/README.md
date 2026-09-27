# Local Pi packages

See [the consolidated OSS notices](../THIRD_PARTY_NOTICES.md) for upstream
attributions, dependency license texts, and unresolved licensing gaps.
Existing package-local LICENSE files remain required for standalone distribution.

Each plugin directory is a Pi package with its own `package.json`. User
`settings.json` registers the local paths; nothing has been published to npm.
`question` and `notify` vendor the installed Pi examples instead of loading
SDK installation paths. `cd` and the empty `codex-think` directory were removed.

`subagents` and observational memory require one shared `ui-kit` peer.
Both local development dependencies link to this checkout's `ui-kit`;
neither bundles a copy. With Pi core peers supplied by the host, restore these
development links using `npm install --ignore-scripts --legacy-peer-deps` in
each consumer directory. The OM relative development path is specific to this
checkout layout. Load `ui-kit` once through Pi's package list.

Package names and directories no longer have the `pi-` prefix; the existing
observational-memory repository/name is unchanged. Existing tool names,
configuration filenames, saved-state keys, and internal event IDs are retained
for compatibility. Historical run artifacts retain their original paths.

Reload Pi after migration;
older saved worker loadouts may still refer to the former extension paths.
