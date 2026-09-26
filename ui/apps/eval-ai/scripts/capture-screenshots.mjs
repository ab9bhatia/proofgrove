import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const devtoolsPort = Number(process.env.CHROME_DEVTOOLS_PORT || "9333");
const baseUrl = process.env.PROOFGROVE_UI_URL || "http://127.0.0.1:33003";
const outputDir = path.resolve(
  process.env.PROOFGROVE_SCREENSHOT_DIR ||
    "services/ui/apps/eval-ai/docs/screenshots",
);
const datasetName = "Template Test Dataset";
const experimentId = "2b851e90-2da2-4d48-94f4-615811ce3231";
const runId = "2b851e90-2da2-4d48-94f4-615811ce3231";

const unsafeJsCharMap = {
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function escapeUnsafeChars(str) {
  return str.replace(/[<>/\b\f\n\r\t\0\u2028\u2029]/g, (ch) => unsafeJsCharMap[ch]);
}

const routes = [
  ["01-overview.png", "/"],
  ["02-datasets.png", "/datasets"],
  ["03-dataset-records.png", `/datasets/${encodeURIComponent(datasetName)}`],
  ["06-experiments.png", "/experiments"],
  ["07-experiment-detail.png", `/experiments/${experimentId}`],
  ["08-experiment-compare.png", `/experiments/${experimentId}/compare`],
  ["09-evaluate.png", "/evaluate"],
  ["10-agent-catalog.png", "/catalog/agents"],
  ["11-llm-catalog.png", "/catalog/llms"],
  ["12-metric-catalog.png", "/catalog/metrics"],
  ["13-quality-contract-catalog.png", "/catalog/quality-contracts"],
  ["14-quality-contracts.png", "/contracts"],
  ["15-run-detail.png", `/runs/${runId}`],
];

async function newTarget() {
  const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`Cannot create Chrome target: ${response.status}`);
  return response.json();
}

function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const events = new Map();

  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    const listeners = events.get(message.method) || [];
    events.delete(message.method);
    for (const resolve of listeners) resolve(message.params);
  };

  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function once(method) {
    return new Promise((resolve) => {
      const listeners = events.get(method) || [];
      listeners.push(resolve);
      events.set(method, listeners);
    });
  }

  return { ws, ready, send, once };
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function capture(client, filename) {
  const { contentSize } = await client.send("Page.getLayoutMetrics");
  const width = Math.max(1440, Math.ceil(contentSize.width));
  const height = Math.max(1000, Math.ceil(contentSize.height));
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  await writeFile(path.join(outputDir, filename), Buffer.from(data, "base64"));
}

async function navigate(client, route) {
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url: `${baseUrl}${route}` });
  await loaded;
  await wait(5000);
}

await mkdir(outputDir, { recursive: true });
const target = await newTarget();
const client = connect(target.webSocketDebuggerUrl);
await client.ready;
await client.send("Page.enable");
await client.send("Runtime.enable");
await client.send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1200,
  deviceScaleFactor: 1,
  mobile: false,
});

for (const [filename, route] of routes) {
  await navigate(client, route);
  await capture(client, filename);
  process.stdout.write(`${filename}\n`);

  if (filename === "03-dataset-records.png") {
    for (const [tabName, tabFilename] of [
      ["Validation", "04-dataset-validation.png"],
      ["History", "05-dataset-history.png"],
    ]) {
      await client.send("Runtime.evaluate", {
        expression: `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === ${escapeUnsafeChars(JSON.stringify(tabName))})?.click()`,
      });
      await wait(1000);
      await capture(client, tabFilename);
      process.stdout.write(`${tabFilename}\n`);
    }
  }
}

client.ws.close();
