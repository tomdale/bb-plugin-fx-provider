// Loaded with `--import` into every Electron-as-Node process that the
// Electron runtime tests start. Starting the Electron executable without
// ELECTRON_RUN_AS_NODE launches the bb desktop app (or signals a running copy
// of it) instead of Node. The guard records each such launch as a JSON line in
// FX_TEST_ELECTRON_GUARD_LOG and substitutes a Node-mode process that exits at
// once with GUARD_EXIT_CODE. A regression therefore fails the way it does in
// the desktop app, with the child exiting before it speaks ACP, and no app
// window ever opens.
import { ChildProcess } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";

const GUARD_EXIT_CODE = 86;
const RUN_AS_NODE = "ELECTRON_RUN_AS_NODE=";

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const electron = process.versions.electron
  ? canonical(process.execPath)
  : undefined;

if (electron !== undefined) {
  // Electron drops NODE_OPTIONS from a Node-mode process whose parent is not
  // part of the same signed app, so the test passes `--import` to the bridge
  // on its command line. The bridge's own children (the model probe and the
  // ACP adapter) are part of the app, so the guard reaches them through
  // NODE_OPTIONS, which they inherit.
  const flag = `--import=${import.meta.url}`;
  const inherited = process.env.NODE_OPTIONS ?? "";
  if (!inherited.split(" ").includes(flag)) {
    process.env.NODE_OPTIONS = `${inherited} ${flag}`.trim();
  }

  // Every asynchronous child_process API reaches this method with the
  // resolved file, its argv (argv0 first) and the final environment.
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    const envPairs = options?.envPairs ?? [];
    const nodeMode = envPairs.some(
      (pair) => pair.startsWith(RUN_AS_NODE) && pair.length > RUN_AS_NODE.length,
    );
    if (
      !nodeMode &&
      typeof options?.file === "string" &&
      canonical(options.file) === electron
    ) {
      const log = process.env.FX_TEST_ELECTRON_GUARD_LOG;
      if (log) {
        appendFileSync(
          log,
          `${JSON.stringify({ parent: process.pid, args: options.args.slice(1) })}\n`,
        );
      }
      options = {
        ...options,
        args: [
          options.args[0],
          "-e",
          `process.stderr.write("electron-node-guard: blocked an Electron launch without ELECTRON_RUN_AS_NODE\\n"); process.exit(${GUARD_EXIT_CODE});`,
        ],
        envPairs: [
          ...envPairs.filter((pair) => !pair.startsWith(RUN_AS_NODE)),
          `${RUN_AS_NODE}1`,
        ],
      };
    }
    return spawn.call(this, options);
  };
}
