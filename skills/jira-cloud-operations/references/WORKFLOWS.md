# Common workflows

Always inspect the leaf command's `--help`; installed ACLI flags can change.

## Read and search work items

```bash
acli jira workitem view ABC-123 \
  --fields key,summary,status,assignee,description --json

acli jira workitem search \
  --jql 'project = ABC ORDER BY updated DESC' \
  --fields key,summary,status,assignee,priority,updated \
  --limit 50 --json
```

Use `--paginate` only when all matching work items are required.

## Create a work item

Inspect the project and create flags first:

```bash
acli jira project view --help
acli jira workitem create --help
```

```bash
acli jira workitem create \
  --project ABC --type Task --summary "Concise summary" \
  --description "Description" --json
```

For fields not represented by direct flags, inspect a generated JSON template:

```bash
acli jira workitem create --generate-json
```

## Edit or assign

Read the current work item first, then edit only requested fields:

```bash
acli jira workitem view ABC-123 --json
acli jira workitem edit --key ABC-123 --summary "New summary" --yes --json
acli jira workitem assign --help
```

## Transition

```bash
acli jira workitem view ABC-123 --fields key,summary,status --json
acli jira workitem transition --help
acli jira workitem transition --key ABC-123 --status "Done" --yes --json
```

Verify the resulting status with `workitem view`.

## Comments

```bash
acli jira workitem comment create \
  --key ABC-123 --body "Deployment completed." --json
acli jira workitem comment list --key ABC-123 --limit 50 --json
```

## Attachments

```bash
acli jira workitem attachment --help
```

Inspect the nested attachment command before listing, adding, or deleting files.

## Boards and sprints

```bash
acli jira board search --project ABC --limit 50 --json
acli jira board view --help
acli jira board list-sprints --id 1 --state active,future --json
acli jira sprint view --help
acli jira sprint list-workitems \
  --board 1 --sprint 42 \
  --fields key,issuetype,summary,assignee,priority,status \
  --limit 50 --json
```

Inspect board and sprint state before mutations.

## Bulk and administrative operations

Before bulk, project, board, field, filter-owner, or other administrative changes:

1. Read the current resources.
2. Resolve JQL/filter/file selectors to the exact affected resources.
3. Present the exact impact and obtain explicit confirmation.
4. Execute once with `--yes` only where supported.
5. Verify with ACLI reads.

Do not automatically roll back with more writes unless the user approves the
rollback.
