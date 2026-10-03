// A stand-in for the fx CLI, run as `node fake-fx.mjs <subcommand>`. It never
// calls a model. Every invocation and every effort an ACP client selects is
// appended to FAKE_FX_LOG as one JSON line.
//
// - `models --json` / `status --json` print FAKE_FX_MODELS / FAKE_FX_STATUS and
//   exit with FAKE_FX_MODELS_EXIT / FAKE_FX_STATUS_EXIT (default 0). With
//   FAKE_FX_STALL=models (or status) that query never answers.
// - `acp` is a minimal ACP agent. FAKE_FX_ACP holds its models as
//   `[{ "id": "...", "efforts": ["low", ...] }]`; the first is current, and a
//   model with efforts gets a `thought_level` option offering `auto` and them.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const record = (entry) => {
  if (process.env.FAKE_FX_LOG) {
    appendFileSync(
      process.env.FAKE_FX_LOG,
      `${JSON.stringify({ pid: process.pid, ...entry })}\n`,
    );
  }
};
const [subcommand] = process.argv.slice(2);
record({ args: process.argv.slice(2) });

if (subcommand === "models" || subcommand === "status") {
  const name = subcommand.toUpperCase();
  if (process.env.FAKE_FX_STALL === subcommand) {
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(`${process.env[`FAKE_FX_${name}`] ?? ""}\n`);
    process.exitCode = Number(process.env[`FAKE_FX_${name}_EXIT`] ?? 0);
  }
} else if (subcommand === "acp") {
  serveAcp(JSON.parse(process.env.FAKE_FX_ACP ?? "[]"));
} else {
  process.stderr.write(`fake fx: unknown subcommand ${subcommand}\n`);
  process.exitCode = 2;
}

function serveAcp(models) {
  let sessionId;
  let model = models[0]?.id;
  let effort = "auto";
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const efforts = () =>
    models.find((entry) => entry.id === model)?.efforts ?? [];
  const configOptions = () => [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: models.map((entry) => ({ value: entry.id, name: entry.id })),
    },
    ...(efforts().length > 0
      ? [
          {
            id: "effort",
            name: "Reasoning Effort",
            category: "thought_level",
            type: "select",
            currentValue: effort,
            options: ["auto", ...efforts()].map((value) => ({
              value,
              name: value === "auto" ? "default" : value,
            })),
          },
        ]
      : []),
  ];
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
      case "initialize":
        reply({
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [],
          agentInfo: { name: "fake-fx", version: "1" },
        });
        break;
      case "session/new":
        sessionId = randomUUID();
        record({ event: "session/new", sessionId });
        reply({ sessionId, configOptions: configOptions() });
        break;
      case "session/set_config_option":
        if (message.params.configId === "model") {
          model = message.params.value;
          effort = "auto";
        } else if (message.params.configId === "effort") {
          if (!["auto", ...efforts()].includes(message.params.value)) {
            send({
              id: message.id,
              error: { code: -32602, message: "unknown effort" },
            });
            break;
          }
          effort = message.params.value;
          record({ event: "effort", model, effort });
        }
        reply({ configOptions: configOptions() });
        break;
      case "session/prompt":
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `model:${model}; effort:${effort}`,
              },
            },
          },
        });
        reply({ stopReason: "end_turn" });
        break;
      case "session/cancel":
        break;
      default:
        send({
          id: message.id,
          error: { code: -32601, message: "Unknown method" },
        });
    }
  });
}
