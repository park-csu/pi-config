# ACLI authentication

ACLI owns Jira authentication. This skill does not read Pi's `auth.json` or Jira
environment variables.

Check the active account and site before every operation:

```bash
acli jira auth status
```

For interactive OAuth login:

```bash
acli jira auth login --web
```

For API-token login, create a token at
<https://id.atlassian.com/manage-profile/security/api-tokens> and pass it through
standard input, never as a command-line value:

```bash
acli jira auth login --site example.atlassian.net \
  --email user@example.com --token < token.txt
```

Use ACLI's account commands when multiple Jira accounts are configured:

```bash
acli jira auth status
acli jira auth switch
acli jira auth logout
```

## Credential hygiene

- Prefer browser OAuth for interactive use.
- Do not commit token files, paste tokens into chat, or add tokens to command
  arguments or URLs.
- Use a least-privileged account/token and revoke temporary tokens after use.
- Jira API permissions mirror Jira UI permissions. Authentication does not bypass
  project, issue security, or administrator restrictions.

Official ACLI login reference:
<https://developer.atlassian.com/cloud/acli/reference/commands/jira-auth-login>
