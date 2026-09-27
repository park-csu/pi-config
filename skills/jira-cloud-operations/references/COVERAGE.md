# ACLI Jira coverage

The installed ACLI version is the source of truth. Discover live coverage with:

```bash
acli jira --help
acli jira <group> --help
acli jira <group> <command> --help
```

Current top-level Jira groups include:

- `workitem`: view/search/create/edit/assign/transition/archive/delete, comments,
  attachments, links, watchers, and bulk variants exposed by the CLI;
- `board`: search/view/create/delete, projects, and sprints;
- `sprint`: view/create/update/delete and list work items;
- `project`: list/view/create/update/archive/restore/delete;
- `field`: custom-field lifecycle commands;
- `filter`: list/search/view/update, columns, favourites, and ownership;
- `dashboard`: search.

## Boundaries

- This skill targets Jira Cloud features exposed by `acli jira`.
- Jira Service Management requests, approvals, Assets/CMDB, Operations alerts,
  on-call, services, workflow schemes, permission schemes, screens, and other
  REST-only administration are not covered unless a future ACLI version exposes
  a corresponding command.
- Confluence, Rovo Dev, and Atlassian administration are separate ACLI groups and
  are outside this skill.
- Jira Server/Data Center is outside this skill.
- Product licensing, Jira permissions, scopes, deployment rollouts, and plan tier
  can make a command unavailable.
- Avoid commands marked deprecated in `--help`.

Prefer `--json` for machine-readable output. Pagination and available fields vary
by leaf command, so inspect that command's help rather than assuming shared flags.

Official command reference:
<https://developer.atlassian.com/cloud/acli/reference/commands/jira>
