import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_EVENT = "pi-caffeine:status";
const REASON = "Pi agent is running";

function spawnInhibitor(): ChildProcess | undefined {
	switch (process.platform) {
		case "darwin":
			// -i prevents idle system sleep for the lifetime of caffeinate.
			return spawn("caffeinate", ["-i"], {
				stdio: ["ignore", "ignore", "ignore"],
			});

		case "linux":
			// cat stays alive while its stdin is open. Closing stdin releases both
			// the command and systemd's inhibitor lock without leaving a child behind.
			return spawn(
				"systemd-inhibit",
				[
					"--what=idle:sleep",
					"--who=pi",
					`--why=${REASON}`,
					"--mode=block",
					"cat",
				],
				{ stdio: ["pipe", "ignore", "ignore"] },
			);

		case "win32": {
			// SetThreadExecutionState is scoped to this PowerShell process. It waits
			// on stdin and explicitly clears the requirement before exiting.
			const script = [
				'Add-Type -Name Power -Namespace PiCaffeine -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\'',
				"[PiCaffeine.Power]::SetThreadExecutionState(0x80000001) | Out-Null",
				"[Console]::In.ReadLine() | Out-Null",
				"[PiCaffeine.Power]::SetThreadExecutionState(0x80000000) | Out-Null",
			].join("; ");
			return spawn(
				"powershell.exe",
				["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
				{ stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
			);
		}

		default:
			return undefined;
	}
}

export default function piCaffeine(pi: ExtensionAPI) {
	let inhibitor: ChildProcess | undefined;
	let agentActive = false;
	let enabled = false;
	let warnedUnsupported = false;

	const publishStatus = (ctx: ExtensionContext) => {
		pi.events.emit(STATUS_EVENT, { enabled, ctx });
	};

	const stop = () => {
		const child = inhibitor;
		inhibitor = undefined;
		if (!child) return;

		if (process.platform === "darwin") {
			child.kill();
			return;
		}

		// Linux's `cat` and Windows' ReadLine both exit cleanly on stdin EOF.
		child.stdin?.end();
		const forceKill = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}, 500);
		forceKill.unref();
		child.once("exit", () => clearTimeout(forceKill));
	};

	const start = (ctx: ExtensionContext) => {
		if (inhibitor) return;

		const child = spawnInhibitor();
		if (!child) {
			if (!warnedUnsupported) {
				ctx.ui.notify(
					`caffeine does not support platform "${process.platform}"`,
					"warning",
				);
				warnedUnsupported = true;
			}
			return;
		}

		inhibitor = child;
		// A command that exits during startup can close the pipe before stop()
		// writes EOF. The child exit/error handlers below report the real failure.
		child.stdin?.on("error", () => undefined);

		child.once("error", (error) => {
			if (inhibitor !== child) return;
			inhibitor = undefined;
			ctx.ui.notify(`caffeine could not prevent sleep: ${error.message}`, "warning");
		});

		child.once("exit", (code, signal) => {
			if (inhibitor !== child) return;
			inhibitor = undefined;
			if (agentActive) {
				const result = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
				ctx.ui.notify(`caffeine stopped unexpectedly (${result})`, "warning");
			}
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		publishStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentActive = true;
		if (enabled) start(ctx);
	});

	// agent_end can be followed by retries, compaction, or queued follow-ups.
	// Keep the inhibitor until the complete run has actually settled.
	pi.on("agent_settled", async () => {
		agentActive = false;
		stop();
	});

	pi.on("session_shutdown", async () => {
		agentActive = false;
		stop();
	});

	pi.registerCommand("caffeine", {
		description: "Control sleep prevention: /caffeine [on|off]",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on", description: "Enable sleep prevention" },
				{ value: "off", label: "off", description: "Disable sleep prevention" },
			].filter((option) => option.value.startsWith(prefix.trim().toLowerCase()));
			return options.length > 0 ? options : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "on") {
				enabled = true;
				if (agentActive) start(ctx);
				publishStatus(ctx);
				ctx.ui.notify("caffeine: on", "info");
				return;
			}

			if (action === "off") {
				enabled = false;
				stop();
				publishStatus(ctx);
				ctx.ui.notify("caffeine: off", "info");
				return;
			}

			if (action) {
				ctx.ui.notify("Usage: /caffeine [on|off]", "error");
				return;
			}

			ctx.ui.notify(
				!enabled
					? "caffeine: off"
					: inhibitor
						? "caffeine: on (sleep is currently inhibited)"
						: "caffeine: on (waiting for the agent)",
				"info",
			);
		},
	});
}
