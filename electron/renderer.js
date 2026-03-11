const statusText = document.getElementById("statusText");
const logsEl = document.getElementById("logs");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearLogsBtn = document.getElementById("clearLogsBtn");
const sampleSizeInput = document.getElementById("sampleSize");
const resumeFileInput = document.getElementById("resumeFile");
const noAdaptiveInput = document.getElementById("noAdaptive");
const wipeMemoryInput = document.getElementById("wipeMemory");
const chartUrlInput = document.getElementById("chartUrl");
const saveChartBtn = document.getElementById("saveChartBtn");
const saveParamsBtn = document.getElementById("saveParamsBtn");
const paramList = document.getElementById("paramList");
const installChromiumBtn = document.getElementById("installChromiumBtn");
const saveSessionBtn = document.getElementById("saveSessionBtn");
const sendEnterBtn = document.getElementById("sendEnterBtn");
const extractParamsBtn = document.getElementById("extractParamsBtn");
const stopSetupBtn = document.getElementById("stopSetupBtn");
const refreshResultsBtn = document.getElementById("refreshResultsBtn");
const resultsList = document.getElementById("resultsList");

let templateRows = [];
let currentMap = {};

function appendLog(text, stream = "stdout") {
  const prefix = stream === "stderr" ? "[ERR] " : "";
  logsEl.textContent += `${prefix}${text}`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setRunningState(running, pid = null) {
  if (running) {
    statusText.textContent = `Running${pid ? ` (PID ${pid})` : ""}`;
    statusText.className = "status-running";
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    statusText.textContent = "Idle";
    statusText.className = "status-idle";
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function getStartOptions() {
  const sampleValue = sampleSizeInput.value.trim();
  return {
    sampleSize: sampleValue ? Number(sampleValue) : null,
    resumeFile: resumeFileInput.value.trim() || null,
    noAdaptive: Boolean(noAdaptiveInput.checked),
    wipeMemory: Boolean(wipeMemoryInput.checked),
  };
}

function parseOptionList(raw) {
  return String(raw || "")
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);
}

function inferNumericMode(current) {
  if (current.options) return "list";
  if (current.start && current.end && current.start !== current.end) return "range";
  return "single";
}

function defaultNumericValue(row) {
  return row.start || "";
}

function renderParamList() {
  const html = templateRows.map((row, idx) => {
    const current = currentMap[row.parameter] || {};
    const enabled = Boolean(currentMap[row.parameter]);
    const mode = inferNumericMode(current);
    const defaultVal = defaultNumericValue(row);
    const options = parseOptionList(row.options || current.options);

    let controlsHtml = "";
    if (row.type === "numeric") {
      controlsHtml = `
        <div class="control-grid">
          <label>Mode
            <select data-role="mode" data-idx="${idx}">
              <option value="single" ${mode === "single" ? "selected" : ""}>Single</option>
              <option value="range" ${mode === "range" ? "selected" : ""}>Range</option>
              <option value="list" ${mode === "list" ? "selected" : ""}>List</option>
            </select>
          </label>
          <label>Single
            <input data-role="single" data-idx="${idx}" type="text" value="${current.start || defaultVal}" />
          </label>
          <label>Start
            <input data-role="start" data-idx="${idx}" type="text" value="${current.start || defaultVal}" />
          </label>
          <label>End
            <input data-role="end" data-idx="${idx}" type="text" value="${current.end || defaultVal}" />
          </label>
          <label>Step
            <input data-role="step" data-idx="${idx}" type="text" value="${current.step || row.step || "1"}" />
          </label>
          <label>List (|)
            <input data-role="list" data-idx="${idx}" type="text" value="${current.options || ""}" placeholder="20|30|40" />
          </label>
        </div>
      `;
    } else {
      controlsHtml = `
        <div class="options-box" data-role="options-box" data-idx="${idx}">
          ${options.map((opt) => {
            const selected = parseOptionList(current.options || row.options).includes(opt);
            return `<label class="inline"><input data-role="opt" data-idx="${idx}" type="checkbox" value="${opt}" ${selected ? "checked" : ""}/> ${opt}</label>`;
          }).join("") || `<input data-role="rawOptions" data-idx="${idx}" type="text" value="${current.options || ""}" placeholder="option1|option2" />`}
        </div>
      `;
    }

    return `
      <article class="param-card" data-idx="${idx}">
        <div class="param-top">
          <label class="inline">
            <input data-role="enabled" data-idx="${idx}" type="checkbox" ${enabled ? "checked" : ""} />
            <strong>${row.label}</strong>
          </label>
          <span class="meta">${row.parameter} • ${row.type}</span>
        </div>
        ${controlsHtml}
      </article>
    `;
  }).join("");

  paramList.innerHTML = html;
}

async function refreshResults() {
  const files = await window.optimizerApp.listResults();
  if (!files.length) {
    resultsList.innerHTML = `<div class="result-meta">No results files yet.</div>`;
    return;
  }
  resultsList.innerHTML = files.map((f) => `
    <div class="result-row">
      <div>
        <div class="result-title">${f.name}</div>
        <div class="result-meta">${new Date(f.modifiedAt).toLocaleString()} • ${formatBytes(f.sizeBytes)}</div>
      </div>
      <div class="result-actions">
        <button data-open-result="${f.name}">Open</button>
        <button data-reveal-result="${f.name}">Show</button>
      </div>
    </div>
  `).join("");

  resultsList.querySelectorAll("[data-open-result]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.getAttribute("data-open-result");
      const res = await window.optimizerApp.openResult(name);
      if (!res.ok) appendLog(`Could not open ${name}: ${res.error}\n`, "stderr");
    });
  });

  resultsList.querySelectorAll("[data-reveal-result]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.getAttribute("data-reveal-result");
      await window.optimizerApp.revealResult(name);
    });
  });
}

function buildSelectedRows() {
  const out = [];
  templateRows.forEach((row, idx) => {
    const enabled = paramList.querySelector(`input[data-role="enabled"][data-idx="${idx}"]`)?.checked;
    if (!enabled) return;

    if (row.type === "numeric") {
      const mode = paramList.querySelector(`select[data-role="mode"][data-idx="${idx}"]`)?.value || "single";
      const single = paramList.querySelector(`input[data-role="single"][data-idx="${idx}"]`)?.value?.trim() || "";
      const start = paramList.querySelector(`input[data-role="start"][data-idx="${idx}"]`)?.value?.trim() || "";
      const end = paramList.querySelector(`input[data-role="end"][data-idx="${idx}"]`)?.value?.trim() || "";
      const step = paramList.querySelector(`input[data-role="step"][data-idx="${idx}"]`)?.value?.trim() || "1";
      const list = paramList.querySelector(`input[data-role="list"][data-idx="${idx}"]`)?.value?.trim() || "";

      if (mode === "single") {
        out.push({ parameter: row.parameter, label: row.label, type: row.type, defaultValue: single, options: "", start: single, end: single, step: "1" });
      } else if (mode === "range") {
        out.push({ parameter: row.parameter, label: row.label, type: row.type, defaultValue: start, options: "", start, end, step });
      } else {
        const first = list.split("|").map((v) => v.trim()).filter(Boolean)[0] || single || row.start || "";
        out.push({ parameter: row.parameter, label: row.label, type: row.type, defaultValue: first, options: list, start: first, end: first, step: "1" });
      }
    } else {
      const selected = Array.from(paramList.querySelectorAll(`input[data-role="opt"][data-idx="${idx}"]:checked`)).map((el) => el.value.trim()).filter(Boolean);
      const rawOptions = paramList.querySelector(`input[data-role="rawOptions"][data-idx="${idx}"]`)?.value?.trim() || "";
      const options = selected.length ? selected.join("|") : rawOptions;
      const first = options.split("|").map((v) => v.trim()).filter(Boolean)[0] || "";
      out.push({ parameter: row.parameter, label: row.label, type: row.type, defaultValue: first, options, start: "", end: "", step: "" });
    }
  });
  return out;
}

async function initialize() {
  const runState = await window.optimizerApp.getState();
  setRunningState(runState.running, runState.pid);
  const setupState = await window.optimizerApp.getSetupState();
  if (setupState.running) {
    appendLog(`[INFO] Setup task already running (PID ${setupState.pid})\n`);
  }

  const setup = await window.optimizerApp.loadSetup();
  chartUrlInput.value = setup.chartUrl || "";
  templateRows = setup.templateRows || [];
  currentMap = setup.currentMap || {};
  renderParamList();
  await refreshResults();

  window.optimizerApp.onRunnerLog((payload) => {
    appendLog(payload.text, payload.stream);
  });

  window.optimizerApp.onRunnerStatus((payload) => {
    setRunningState(payload.running, payload.pid);
    if (!payload.running) {
      appendLog(`\n[INFO] Runner exited (code=${payload.code}, signal=${payload.signal})\n`);
    }
  });

  window.optimizerApp.onSetupLog((payload) => {
    appendLog(payload.text, payload.stream);
  });

  window.optimizerApp.onSetupStatus((payload) => {
    if (!payload.running) {
      appendLog(`[INFO] Setup task "${payload.taskName}" exited (code=${payload.code}, signal=${payload.signal})\n`);
      if (payload.taskName === "extract-params") {
        appendLog("[INFO] Refreshing parameter builder after extract...\n");
        window.optimizerApp.loadSetup().then((newSetup) => {
          templateRows = newSetup.templateRows || [];
          currentMap = newSetup.currentMap || {};
          renderParamList();
        });
      }
    } else {
      appendLog(`[INFO] Setup task "${payload.taskName}" started (PID ${payload.pid})\n`);
    }
  });
}

startBtn.addEventListener("click", async () => {
  try {
    const options = getStartOptions();
    await window.optimizerApp.startRunner(options);
    appendLog(`[INFO] Started runner with options: ${JSON.stringify(options)}\n`);
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
  }
});

stopBtn.addEventListener("click", async () => {
  await window.optimizerApp.stopRunner();
  appendLog("[INFO] Stop requested.\n");
});

saveChartBtn.addEventListener("click", async () => {
  await window.optimizerApp.saveChartUrl(chartUrlInput.value);
  appendLog("[INFO] Saved chart URL to config.json\n");
});

saveParamsBtn.addEventListener("click", async () => {
  const rows = buildSelectedRows();
  const result = await window.optimizerApp.saveParams(rows);
  appendLog(`[INFO] Saved ${result.count} parameters to params.csv\n`);
});

installChromiumBtn.addEventListener("click", async () => {
  try {
    await window.optimizerApp.startSetupTask("install-chromium");
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
  }
});

saveSessionBtn.addEventListener("click", async () => {
  try {
    await window.optimizerApp.startSetupTask("save-session");
    appendLog("[INFO] Login in the opened browser, then click 'Press Enter For Save Session'.\n");
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
  }
});

sendEnterBtn.addEventListener("click", async () => {
  await window.optimizerApp.sendSetupEnter();
  appendLog("[INFO] Sent ENTER to setup task stdin.\n");
});

extractParamsBtn.addEventListener("click", async () => {
  try {
    await window.optimizerApp.startSetupTask("extract-params");
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
  }
});

stopSetupBtn.addEventListener("click", async () => {
  await window.optimizerApp.stopSetupTask();
  appendLog("[INFO] Stop requested for setup task.\n");
});

refreshResultsBtn.addEventListener("click", async () => {
  await refreshResults();
});

clearLogsBtn.addEventListener("click", () => {
  logsEl.textContent = "";
});

initialize().catch((error) => {
  appendLog(`Failed to initialize app: ${error.message}\n`, "stderr");
});
