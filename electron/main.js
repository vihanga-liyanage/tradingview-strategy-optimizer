const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { fork, spawn } = require("child_process");

let mainWindow = null;
let runnerProcess = null;
let setupProcess = null;
const projectRoot = path.resolve(__dirname, "..");
const configPath = path.join(projectRoot, "config.json");
const templatePath = path.join(projectRoot, "params_template.csv");
const paramsPath = path.join(projectRoot, "params.csv");

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function buildRunnerArgs(options = {}) {
  const args = [];
  if (options.sampleSize && Number(options.sampleSize) > 0) {
    args.push("--sample", String(Number(options.sampleSize)));
  }
  if (options.resumeFile && String(options.resumeFile).trim()) {
    args.push("--resume", String(options.resumeFile).trim());
  }
  if (options.noAdaptive) {
    args.push("--no-adaptive");
  }
  if (options.wipeMemory) {
    args.push("--wipe-memory");
  }
  return args;
}

function stopRunner() {
  if (!runnerProcess) return;

  const pid = runnerProcess.pid;
  const isWin = process.platform === "win32";
  if (isWin && pid) {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
  } else {
    runnerProcess.kill("SIGTERM");
  }
}

function startRunner(options) {
  if (runnerProcess) {
    throw new Error("Runner is already running.");
  }

  const runnerPath = path.join(projectRoot, "runner.js");
  const args = buildRunnerArgs(options);

  runnerProcess = fork(runnerPath, args, {
    cwd: projectRoot,
    silent: true,
  });

  sendToRenderer("runner-status", {
    running: true,
    pid: runnerProcess.pid,
    args,
  });

  runnerProcess.stdout.on("data", (chunk) => {
    sendToRenderer("runner-log", {
      stream: "stdout",
      text: String(chunk),
    });
  });

  runnerProcess.stderr.on("data", (chunk) => {
    sendToRenderer("runner-log", {
      stream: "stderr",
      text: String(chunk),
    });
  });

  runnerProcess.on("exit", (code, signal) => {
    sendToRenderer("runner-status", {
      running: false,
      code,
      signal,
    });
    runnerProcess = null;
  });

  runnerProcess.on("error", (error) => {
    sendToRenderer("runner-log", {
      stream: "stderr",
      text: `[electron] Runner error: ${error.message}\n`,
    });
  });
}

function isWindows() {
  return process.platform === "win32";
}

function startSetupTask(taskName) {
  if (setupProcess) {
    throw new Error("A setup task is already running.");
  }

  let child = null;
  if (taskName === "install-chromium") {
    const npxBin = isWindows() ? "npx.cmd" : "npx";
    child = spawn(npxBin, ["playwright", "install", "chromium"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else if (taskName === "save-session") {
    child = spawn(process.execPath, [path.join(projectRoot, "save-session.js")], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else if (taskName === "extract-params") {
    child = spawn(process.execPath, [path.join(projectRoot, "extract-params.js")], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else {
    throw new Error(`Unknown setup task: ${taskName}`);
  }

  setupProcess = child;
  sendToRenderer("setup-status", { running: true, taskName, pid: child.pid });

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    sendToRenderer("setup-log", { stream: "stdout", text });
    sendToRenderer("runner-log", { stream: "stdout", text: `[setup:${taskName}] ${text}` });
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    sendToRenderer("setup-log", { stream: "stderr", text });
    sendToRenderer("runner-log", { stream: "stderr", text: `[setup:${taskName}] ${text}` });
  });
  child.on("exit", (code, signal) => {
    sendToRenderer("setup-status", { running: false, taskName, code, signal });
    setupProcess = null;
  });
  child.on("error", (error) => {
    sendToRenderer("setup-log", { stream: "stderr", text: `${error.message}\n` });
  });
}

function stopSetupTask() {
  if (!setupProcess) return;
  const pid = setupProcess.pid;
  if (isWindows() && pid) {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
  } else {
    setupProcess.kill("SIGTERM");
  }
}

function sendSetupEnter() {
  if (!setupProcess || !setupProcess.stdin) return;
  setupProcess.stdin.write("\n");
}

function splitCsvLine(line) {
  const out = [];
  let curr = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        curr += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(curr);
      curr = "";
      continue;
    }
    curr += ch;
  }
  out.push(curr);
  return out;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/\r/g, "");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    header.forEach((h, idx) => {
      row[h] = String(cols[idx] ?? "").trim();
    });
    return row;
  });
}

function writeCsv(filePath, header, rows) {
  const head = header.join(",");
  const body = rows
    .map((row) => header.map((h) => csvEscape(row[h] ?? "")).join(","))
    .join("\n");
  const text = `${head}\n${body}${body ? "\n" : ""}`;
  fs.writeFileSync(filePath, text, "utf8");
}

function normalizeTemplateRows(rows) {
  return rows.map((r) => ({
    parameter: r.parameter || "",
    label: r.label || "",
    type: (r.type || "").toLowerCase(),
    options: r.options || "",
    start: r.start || "",
    end: r.end || "",
    step: r.step || "",
  })).filter((r) => r.parameter && r.label && r.type);
}

function loadTemplateAndCurrentParams() {
  const templateRows = normalizeTemplateRows(readCsv(templatePath));
  const currentRows = fs.existsSync(paramsPath) ? readCsv(paramsPath) : [];
  const currentMap = {};
  for (const row of currentRows) {
    if (row.parameter) currentMap[row.parameter] = row;
  }
  return { templateRows, currentMap };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#0f1116",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("runner:get-state", () => {
  return {
    running: Boolean(runnerProcess),
    pid: runnerProcess?.pid || null,
  };
});

ipcMain.handle("runner:start", async (_event, options) => {
  startRunner(options || {});
  return { ok: true };
});

ipcMain.handle("runner:stop", async () => {
  stopRunner();
  return { ok: true };
});

ipcMain.handle("setup:get-state", async () => ({
  running: Boolean(setupProcess),
  pid: setupProcess?.pid || null,
}));

ipcMain.handle("setup:start-task", async (_event, taskName) => {
  startSetupTask(String(taskName || ""));
  return { ok: true };
});

ipcMain.handle("setup:stop-task", async () => {
  stopSetupTask();
  return { ok: true };
});

ipcMain.handle("setup:send-enter", async () => {
  sendSetupEnter();
  return { ok: true };
});

ipcMain.handle("app:load-setup", async () => {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const { templateRows, currentMap } = loadTemplateAndCurrentParams();
  return {
    chartUrl: cfg.chartUrl || "",
    templateRows,
    currentMap,
  };
});

ipcMain.handle("app:save-chart-url", async (_event, chartUrl) => {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  cfg.chartUrl = String(chartUrl || "").trim();
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { ok: true };
});

ipcMain.handle("app:save-params", async (_event, selectedRows) => {
  const header = ["parameter", "label", "type", "defaultValue", "options", "start", "end", "step"];
  const rows = (selectedRows || []).map((r) => ({
    parameter: String(r.parameter || "").trim(),
    label: String(r.label || "").trim(),
    type: String(r.type || "").trim(),
    defaultValue: String(r.defaultValue ?? "").trim(),
    options: String(r.options ?? "").trim(),
    start: String(r.start ?? "").trim(),
    end: String(r.end ?? "").trim(),
    step: String(r.step ?? "").trim(),
  })).filter((r) => r.parameter && r.label && r.type);

  writeCsv(paramsPath, header, rows);
  return { ok: true, count: rows.length };
});

ipcMain.handle("results:list", async () => {
  const files = fs.readdirSync(projectRoot)
    .filter((f) => /^results_.*\.csv$/i.test(f))
    .map((name) => {
      const fullPath = path.join(projectRoot, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        fullPath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  return files;
});

ipcMain.handle("results:open", async (_event, name) => {
  const fullPath = path.join(projectRoot, String(name || ""));
  const err = await shell.openPath(fullPath);
  return { ok: !err, error: err || null };
});

ipcMain.handle("results:reveal", async (_event, name) => {
  const fullPath = path.join(projectRoot, String(name || ""));
  shell.showItemInFolder(fullPath);
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  stopRunner();
  stopSetupTask();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
