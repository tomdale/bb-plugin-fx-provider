// Hold a model probe in initialization, even after stdin closes. No model or
// account is contacted. The lifecycle test owns and cleans up this process.
import { renameSync, writeFileSync } from "node:fs";

// Model discovery asks the fx CLI first (`<launch args> models --json`).
// Failing those queries sends discovery to the ACP probe this fixture stalls.
if (["models", "status"].includes(process.argv[3])) process.exit(1);

const pidFile = process.argv[2];
writeFileSync(`${pidFile}.tmp`, String(process.pid));
renameSync(`${pidFile}.tmp`, pidFile);
process.stdin.resume();
setInterval(() => {}, 1000);
