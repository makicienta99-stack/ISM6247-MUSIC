// SongForge front-end. Talks only to our own /api/* Netlify Function,
// which holds the SunoAPI key server-side.

const $ = (s) => document.querySelector(s);
const STORE_KEY = "songforge.tasks.v1";
const PW_KEY = "songforge.pw";
const POLL_MS = 6000;
const MAX_POLL_MS = 15 * 60 * 1000;
const FAILED = ["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR", "GENERATE_LYRICS_FAILED"];

const STATUS_TEXT = {
  PENDING: "Queued…",
  TEXT_SUCCESS: "Writing music…",
  FIRST_SUCCESS: "Almost done — preview ready",
  SUCCESS: "Ready",
  CREATE_TASK_FAILED: "Could not start",
  GENERATE_AUDIO_FAILED: "Generation failed",
  SENSITIVE_WORD_ERROR: "Blocked: content not allowed",
  CALLBACK_EXCEPTION: "Ready",
};

const IDEAS = [
  "Upbeat cumbia about weekend markets in Cusco",
  "Lo-fi chill beat for studying late at night",
  "Epic cinematic orchestral trailer music",
  "Acoustic love song with soft female vocals",
  "Energetic pop anthem about graduating college",
  "Smooth jazz with saxophone for a cozy café",
];
const STYLES = ["pop", "reggaeton", "lo-fi", "rock", "cumbia", "R&B", "EDM", "acoustic", "jazz", "hip hop", "cinematic"];

// ---------- state ----------
let mode = "simple";
let vocalGender = "";
let tasks = load();
const pollers = new Map();
let currentTrackId = null;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(tasks.slice(0, 60))); } catch { /* ignore */ }
}
function getPw() { try { return sessionStorage.getItem(PW_KEY) || ""; } catch { return ""; } }
function setPw(v) { try { sessionStorage.setItem(PW_KEY, v); } catch { /* ignore */ } }

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", "x-app-password": getPw(), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await askPassword();
    throw new Error("Password required — please try again.");
  }
  if (!res.ok) throw new Error(friendlyError(data));
  return data;
}

function friendlyError(d) {
  const map = {
    401: "The server's API key was rejected. Check SUNO_API_KEY in Netlify.",
    413: "Your prompt is too long — try shortening it.",
    429: "Out of SunoAPI credits. Top up at sunoapi.org.",
    430: "Too many requests right now. Wait a moment and try again.",
    455: "SunoAPI is under maintenance. Try again shortly.",
  };
  return map[d.code] || d.msg || "Something went wrong. Please try again.";
}

function askPassword() {
  return new Promise((resolve) => {
    const dlg = $("#pwDialog");
    if (dlg.open) return resolve();
    $("#pwInput").value = "";
    dlg.showModal();
    dlg.addEventListener("close", () => { setPw($("#pwInput").value); refreshCredits(); resolve(); }, { once: true });
  });
}

async function refreshCredits() {
  try {
    const { credits } = await api("credits");
    $("#credits").textContent = `${Number(credits).toLocaleString()} credits`;
  } catch {
    $("#credits").textContent = "credits unavailable";
  }
}

// ---------- form UI ----------
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    mode = t.dataset.mode;
    document.querySelectorAll(".tab").forEach((x) => {
      x.classList.toggle("active", x === t);
      x.setAttribute("aria-selected", x === t);
    });
    $(".mode-simple").hidden = mode !== "simple";
    $(".mode-custom").hidden = mode !== "custom";
    syncInstrumental();
  })
);

function chips(container, items, onPick) {
  items.forEach((label) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = label;
    b.addEventListener("click", () => onPick(label));
    container.appendChild(b);
  });
}
chips($("#ideaChips"), IDEAS, (v) => { $("#prompt").value = v; $("#prompt").focus(); });
chips($("#styleChips"), STYLES, (v) => {
  const el = $("#style");
  const parts = el.value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.includes(v)) parts.push(v);
  el.value = parts.join(", ");
});

$("#vocalGender").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  vocalGender = b.dataset.v;
  $("#vocalGender").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
});
$("#styleWeight").addEventListener("input", (e) => ($("#swOut").textContent = e.target.value));
$("#weird").addEventListener("input", (e) => ($("#wOut").textContent = e.target.value));

function syncInstrumental() {
  const inst = $("#instrumental").checked;
  $("#lyrics").disabled = inst && mode === "custom";
  $("#lyrics").placeholder = inst ? "Instrumental — no lyrics needed" : "[Verse]\nWalking down the coast tonight...\n\n[Chorus]\n...";
}
$("#instrumental").addEventListener("change", syncInstrumental);

// AI lyrics helper
$("#aiLyricsBtn").addEventListener("click", () => {
  const box = $("#aiLyricsBox");
  box.hidden = !box.hidden;
  if (!box.hidden) $("#lyricsPrompt").focus();
});
$("#aiLyricsGo").addEventListener("click", async () => {
  const prompt = $("#lyricsPrompt").value.trim();
  if (!prompt) return $("#lyricsPrompt").focus();
  const btn = $("#aiLyricsGo");
  btn.disabled = true; btn.textContent = "Writing…";
  showError("");
  try {
    const { taskId } = await api("lyrics", { method: "POST", body: JSON.stringify({ prompt }) });
    const started = Date.now();
    while (Date.now() - started < 3 * 60 * 1000) {
      await sleep(4000);
      const r = await api(`lyrics-status?taskId=${encodeURIComponent(taskId)}`);
      if (r.status === "SUCCESS" && r.lyrics?.length) {
        const best = r.lyrics.find((x) => x.text) || r.lyrics[0];
        $("#lyrics").value = best.text;
        if (best.title && !$("#title").value) $("#title").value = best.title;
        $("#aiLyricsBox").hidden = true;
        return;
      }
      if (FAILED.includes(r.status)) throw new Error(r.errorMessage || STATUS_TEXT[r.status] || "Lyrics failed");
    }
    throw new Error("Lyrics are taking too long. Try again.");
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Generate";
  }
});

function showError(msg) { $("#error").textContent = msg; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- create ----------
$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const instrumental = $("#instrumental").checked;
  const body = { customMode: mode === "custom", instrumental, model: $("#model").value };

  if (mode === "simple") {
    body.prompt = $("#prompt").value.trim();
    if (!body.prompt) { showError("Describe the song you want."); return $("#prompt").focus(); }
  } else {
    body.title = $("#title").value.trim();
    body.style = $("#style").value.trim();
    body.lyrics = instrumental ? "" : $("#lyrics").value.trim();
    body.negativeTags = $("#negativeTags").value.trim();
    body.vocalGender = vocalGender;
    body.styleWeight = $("#styleWeight").value;
    body.weirdnessConstraint = $("#weird").value;
    if (!body.style && !body.lyrics) { showError("Add a style or some lyrics."); return $("#style").focus(); }
    if (!instrumental && !body.lyrics) { showError("Add lyrics, or switch on Instrumental."); return $("#lyrics").focus(); }
  }

  const btn = $("#createBtn");
  btn.disabled = true; btn.classList.add("loading");
  try {
    const { taskId } = await api("generate", { method: "POST", body: JSON.stringify(body) });
    const task = {
      taskId,
      createdAt: Date.now(),
      label: body.title || body.prompt || body.style || "New song",
      instrumental,
      status: "PENDING",
      tracks: [],
    };
    tasks.unshift(task);
    save();
    render();
    poll(task);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false; btn.classList.remove("loading");
  }
});

// ---------- polling ----------
function isDone(t) {
  return t.status === "SUCCESS" || FAILED.includes(t.status) ||
    (t.status === "CALLBACK_EXCEPTION" && t.tracks.some((x) => x.audioUrl));
}

function poll(task) {
  if (pollers.has(task.taskId) || isDone(task)) return;
  const tick = async () => {
    try {
      const r = await api(`status?taskId=${encodeURIComponent(task.taskId)}`);
      task.status = r.status;
      task.error = r.errorMessage;
      if (r.tracks?.length) task.tracks = r.tracks;
      save();
      render();
      if (task.status === "SUCCESS" || task.status === "FIRST_SUCCESS") refreshCredits();
    } catch (e) {
      task.error = e.message;
    }
    if (isDone(task) || Date.now() - task.createdAt > MAX_POLL_MS) {
      pollers.delete(task.taskId);
      if (!isDone(task)) { task.status = "TIMEOUT"; task.error = "Timed out waiting for SunoAPI."; save(); render(); }
      return;
    }
    pollers.set(task.taskId, setTimeout(tick, POLL_MS));
  };
  pollers.set(task.taskId, setTimeout(tick, 1500));
}

// ---------- render ----------
function render() {
  const list = $("#songs");
  list.textContent = "";
  $("#empty").hidden = tasks.length > 0;
  const tpl = $("#songTpl");

  for (const task of tasks) {
    const rows = task.tracks.length ? task.tracks : [{ placeholder: true }, { placeholder: true }];
    rows.forEach((tr, i) => {
      const el = tpl.content.firstElementChild.cloneNode(true);
      const playable = tr.audioUrl || tr.streamUrl;
      const failed = FAILED.includes(task.status) || task.status === "TIMEOUT";
      const ready = Boolean(tr.audioUrl) && (task.status === "SUCCESS" || task.status === "CALLBACK_EXCEPTION");

      el.querySelector(".s-title").textContent = tr.title || `${truncate(task.label, 60)} · v${i + 1}`;
      el.querySelector(".s-tags").textContent = tr.tags || (tr.duration ? fmtDur(tr.duration) : new Date(task.createdAt).toLocaleString());
      const st = el.querySelector(".s-status");
      st.textContent = failed ? (task.error || STATUS_TEXT[task.status] || "Failed")
        : ready ? `Ready${tr.duration ? " · " + fmtDur(tr.duration) : ""}`
        : STATUS_TEXT[task.status] || "Working…";
      st.classList.toggle("ok", ready);
      st.classList.toggle("fail", failed);
      el.classList.toggle("pending", !failed && !ready);

      const img = el.querySelector("img");
      img.src = tr.imageUrl || "";
      const play = el.querySelector(".play");
      play.disabled = !playable;
      play.textContent = currentTrackId === tr.id && !$("#audio").paused ? "❚❚" : "▶";
      if (playable) play.addEventListener("click", () => playTrack(tr, task));
      if (currentTrackId && currentTrackId === tr.id) el.classList.add("playing");

      if (tr.audioUrl) {
        const dl = el.querySelector(".dl");
        dl.hidden = false; dl.href = tr.audioUrl;
        dl.setAttribute("download", `${safeName(tr.title || "song")}.mp3`);
      }
      if (tr.prompt && !task.instrumental) {
        const lb = el.querySelector(".lyr");
        const pre = el.querySelector(".s-lyrics");
        lb.hidden = false;
        pre.textContent = tr.prompt;
        lb.addEventListener("click", () => (pre.hidden = !pre.hidden));
      }
      list.appendChild(el);
    });
  }
}

function playTrack(tr, task) {
  const audio = $("#audio");
  const src = tr.audioUrl && task.status !== "FIRST_SUCCESS" ? tr.audioUrl : tr.streamUrl || tr.audioUrl;
  if (currentTrackId === tr.id) {
    audio.paused ? audio.play() : audio.pause();
    return;
  }
  currentTrackId = tr.id;
  audio.src = src;
  $("#player").hidden = false;
  $("#pTitle").textContent = tr.title || task.label;
  $("#pTags").textContent = tr.tags || "";
  $("#pCover").src = tr.imageUrl || "";
  audio.play().catch(() => {});
  render();
}
$("#audio").addEventListener("play", render);
$("#audio").addEventListener("pause", render);

$("#clearBtn").addEventListener("click", () => {
  if (!tasks.length || !confirm("Remove all songs from this list? (Files on SunoAPI are not affected.)")) return;
  pollers.forEach(clearTimeout); pollers.clear();
  tasks = []; save(); render();
});

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const safeName = (s) => s.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "song";
function fmtDur(sec) {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- boot ----------
(async function init() {
  render();
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    if (cfg.passwordRequired && !getPw()) await askPassword();
  } catch { /* offline or local static preview */ }
  refreshCredits();
  tasks.filter((t) => !isDone(t) && t.status !== "TIMEOUT").forEach(poll);
})();
