# caffeine

Prevents the computer from sleeping while the pi agent is running. The
inhibitor starts on `agent_start` and remains active through tool calls,
automatic retries, compaction retries, and queued follow-ups. It is released
on `agent_settled` or `session_shutdown`.

Supported platforms:

- Linux: `systemd-inhibit`
- macOS: `caffeinate`
- Windows: `SetThreadExecutionState` through Windows PowerShell

When enabled, `☕ on` appears at the far right of pi's model footer line.

- `/caffeine on` enables automatic sleep prevention.
- `/caffeine off` disables it and immediately releases an active inhibitor.
- `/caffeine` displays the current state.

Sleep prevention is `off` by default.

The package name is **caffeine**.
