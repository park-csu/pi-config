import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";

export const STAGING_ROOT = join(tmpdir(), "pi-visual-tools");
export type Session = { workDir: string; bodyPath: string; cwd: string };

export function run(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{
  code: number | null; stdout: string; stderr: string; timedOut: boolean;
}> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: { ...process.env, PATH: ["/usr/local/bin", "/opt/homebrew/bin", process.env.PATH].filter(Boolean).join(":") } });
    let stdout = "", stderr = "", timedOut = false;
    const append = (target: "stdout" | "stderr", data: Buffer) => {
      const value = data.toString();
      if (target === "stdout") stdout = (stdout + value).slice(-32_000);
      else stderr = (stderr + value).slice(-32_000);
    };
    const stop = () => { timedOut = Boolean(signal?.aborted) || timedOut; child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", d => append("stdout", d));
    child.stderr.on("data", d => append("stderr", d));
    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(result);
    };
    child.once("error", e => finish({ code: null, stdout, stderr: stderr + String(e), timedOut }));
    child.once("close", code => finish({ code, stdout, stderr, timedOut }));
  });
}

export async function writeBody(group: string, filename: string, source: string, cwd: string): Promise<Session> {
  mkdirSync(STAGING_ROOT, { recursive: true });
  const workDir = await mkdtemp(join(STAGING_ROOT, `${group}-${process.pid}-`));
  mkdirSync(workDir, { recursive: true });
  const bodyPath = join(workDir, filename);
  writeFileSync(bodyPath, source, "utf8");
  return { workDir, bodyPath, cwd };
}

export function applyEdit(current: string, oldText: string, newText: string) {
  if (!oldText) throw new Error("`old_text` must be non-empty.");
  if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.");
  const first = current.indexOf(oldText);
  if (first < 0) throw new Error("`old_text` not found in the current source — match it exactly.");
  if (current.indexOf(oldText, first + 1) >= 0) throw new Error("`old_text` appears more than once — add surrounding context to make it unique.");
  return { updated: current.slice(0, first) + newText + current.slice(first + oldText.length), index: first };
}

export function snippetAround(content: string, index: number): string {
  const lines = content.split("\n"), line = content.slice(0, index).split("\n").length - 1;
  return lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 3)).join("\n").slice(0, 2000);
}

export function publish(source: string, slug: string, cwd: string) {
  const dir = join(cwd, "viz");
  mkdirSync(dir, { recursive: true });
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "viz";
  for (let attempt = 0; attempt < 5; attempt++) {
    const filename = `viz-${clean}-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    const path = join(dir, filename);
    try {
      copyFileSync(source, path, constants.COPYFILE_EXCL);
      return { filename, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not choose a unique viz filename.");
}

export function cleanup(session?: Session): void {
  if (session) rmSync(session.workDir, { recursive: true, force: true });
}

export function createQueue() {
  let tail = Promise.resolve();
  return async function<T>(work: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  };
}

export { existsSync, mkdirSync, readFileSync, writeFileSync, join };
