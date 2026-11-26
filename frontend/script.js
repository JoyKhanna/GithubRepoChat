/**
 * script.js — Chrome Extension Popup Logic
 * GitHub Repo Chat — Gemini RAG
 */

const API_BASE = "http://localhost:8000";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const statusBadge      = document.getElementById("statusBadge");
const statusText       = document.getElementById("statusText");
const repoDetected     = document.getElementById("repoDetected");
const repoDetectedText = document.getElementById("repoDetectedText");
const repoUrlInput     = document.getElementById("repoUrlInput");
const settingsToggle   = document.getElementById("settingsToggle");
const settingsPanel    = document.getElementById("settingsPanel");
const indexBtn         = document.getElementById("indexBtn");
const indexBtnText     = document.getElementById("indexBtnText");
const indexBtnIcon     = document.getElementById("indexBtnIcon");
const messages         = document.getElementById("messages");
const emptyState       = document.getElementById("emptyState");
const chatInput        = document.getElementById("chatInput");
const sendBtn          = document.getElementById("sendBtn");
const toast            = document.getElementById("toast");

const repoHeaderToggle   = document.getElementById("repoHeaderToggle");
const repoControls       = document.getElementById("repoControls");

// Settings
const modelSelect   = document.getElementById("modelSelect");
const topK          = document.getElementById("topK");
const chunkSize     = document.getElementById("chunkSize");
const chunkOverlap  = document.getElementById("chunkOverlap");

const extMultiSelect   = document.getElementById("extMultiSelect");
const extTagsContainer = document.getElementById("extTagsContainer");
const extTagInput      = document.getElementById("extTagInput");
const extDropdown      = document.getElementById("extDropdown");
const selectAllExtsBtn = document.getElementById("selectAllExts");
const clearExtsBtn     = document.getElementById("clearExts");

// ─── Reactive state ──────────────────────────────────────────────────────────
let currentRepoUrl = "";
let isIndexed      = false;
let isIndexing     = false;
let isChatting     = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract owner/repo from a GitHub URL. Returns null if not a repo URL. */
function parseGithubUrl(url) {
  const m = url.match(/https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9._-]+)/);
  if (!m) return null;
  const repo = m[2].replace(/\.git$/, "").replace(/\/$/, "");
  return { owner: m[1], repo };
}

function showToast(msg, type = "info", duration = 3000) {
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), duration);
}

function setStatus(state) {
  // state: "idle" | "indexed" | "loading"
  statusBadge.className = "header-badge";
  const dot = statusBadge.querySelector(".badge-dot");
  dot.className = "badge-dot";

  if (state === "indexed") {
    statusBadge.classList.add("indexed");
    statusText.textContent = "Indexed ✓";
  } else if (state === "loading") {
    statusBadge.classList.add("loading");
    statusText.textContent = "Indexing…";
    dot.classList.add("pulse");
  } else {
    statusText.textContent = "Not indexed";
  }
}

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  sendBtn.disabled   = !enabled;
  if (enabled) chatInput.placeholder = "Ask about the repository…";
  else chatInput.placeholder = "Index a repository first…";
}

/** Auto-grow textarea */
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = chatInput.scrollHeight + "px";
});

/** Send on Enter (not Shift+Enter) */
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});

repoHeaderToggle.addEventListener("click", () => {
  repoHeaderToggle.classList.toggle("open");
  repoControls.classList.toggle("collapsed");
});

// ─── Settings toggle ─────────────────────────────────────────────────────────
settingsToggle.addEventListener("click", () => {
  const open = settingsPanel.classList.toggle("open");
  settingsToggle.classList.toggle("open", open);
});

// ─── On popup load ────────────────────────────────────────────────────────────
(async () => {
  // 1. Try to get GitHub URL from active tab via content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const parsed = parseGithubUrl(tab.url);
      if (parsed) {
        // We are on a GitHub repo page → show detected badge
        const fullUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
        currentRepoUrl = fullUrl;
        repoDetectedText.textContent = `${parsed.owner}/${parsed.repo}`;
        repoDetected.style.display = "flex";
        repoUrlInput.style.display = "none";

        // Check if already indexed
        await checkStatus(parsed.owner, parsed.repo);
      } else {
        // Not on a repo page — show manual input
        showManualInput();
      }
    } else {
      showManualInput();
    }
  } catch {
    showManualInput();
  }
})();

function showManualInput() {
  repoUrlInput.style.display = "block";
  repoDetected.style.display = "none";
  repoUrlInput.addEventListener("input", () => {
    currentRepoUrl = repoUrlInput.value.trim();
  });
}

// ─── Status check ────────────────────────────────────────────────────────────
async function checkStatus(owner, repo) {
  try {
    const res = await fetch(`${API_BASE}/status/${owner}/${repo}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.indexed) {
      isIndexed = true;
      setStatus("indexed");
      setChatEnabled(true);
      showToast(`✓ Repo already indexed (${data.chunk_count} chunks)`, "success");
    }
  } catch {
    // Backend not reachable — silent fail
  }
}

// ─── Index repository ─────────────────────────────────────────────────────────
indexBtn.addEventListener("click", async () => {
  // If no tab-detected URL, use manual input
  const urlToIndex = currentRepoUrl || repoUrlInput.value.trim();
  if (!urlToIndex || !parseGithubUrl(urlToIndex)) {
    showToast("Enter a valid GitHub repo URL", "error");
    return;
  }
  if (isIndexing) return;

  isIndexing = true;
  isIndexed  = false;
  setStatus("loading");
  setChatEnabled(false);

  // Spinner in button
  indexBtn.disabled = true;
  indexBtnIcon.innerHTML = `<span class="spinner"></span>`;
  indexBtnText.textContent = "Indexing…";

  indexBtnText.textContent = "Indexing…";

  const exts = selectedExts; // Using our dynamically managed array

  try {
    const res = await fetch(`${API_BASE}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_url:      urlToIndex,
        extensions:    exts,
        chunk_size:    parseInt(chunkSize.value),
        chunk_overlap: parseInt(chunkOverlap.value),
        top_k:         parseInt(topK.value),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const errDetail = data.detail;
      const errMsg = typeof errDetail === "string" ? errDetail : JSON.stringify(errDetail);
      throw new Error(errMsg || "Indexing failed");
    }

    isIndexed = true;
    currentRepoUrl = urlToIndex;
    setStatus("indexed");
    setChatEnabled(true);
    
    // Maximize space: collapse repo settings
    repoControls.classList.add("collapsed");
    repoHeaderToggle.style.display = "flex";
    repoHeaderToggle.classList.remove("open");

    showToast(`✓ Indexed ${data.chunk_count} chunks from ${data.file_count} files`, "success", 4000);
  } catch (err) {
    setStatus("idle");
    showToast(`Error: ${err.message}`, "error", 5000);
  } finally {
    isIndexing        = false;
    indexBtn.disabled = false;
    indexBtnIcon.textContent = "⚡";
    indexBtnText.textContent = "Index Repository";
  }
});

// ─── Chat ────────────────────────────────────────────────────────────────────

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(role, content, sources = []) {
  // Remove empty state
  if (emptyState) emptyState.style.display = "none";

  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "You" : (modelSelect ? modelSelect.value.split("-")[0].toUpperCase() : "GPT");

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  // Simple markdown-lite rendering
  bubble.innerHTML = simpleMarkdown(content);

  wrap.appendChild(meta);
  wrap.appendChild(bubble);

  // Sources accordion (assistant only)
  if (role === "assistant" && sources.length > 0) {
    const sourcesWrap = document.createElement("div");
    sourcesWrap.className = "sources";

    const toggle = document.createElement("div");
    toggle.className = "sources-toggle";
    toggle.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 7.775V16h14V7.775L8 1 1 7.775zm1 1.027L8 2.528l6 6.274V15H2V8.802z"/>
      </svg>
      ${sources.length} source${sources.length === 1 ? "" : "s"}
    `;

    const list = document.createElement("div");
    list.className = "sources-list";

    const seen = new Set();
    sources.forEach(s => {
      if (seen.has(s.source)) return;
      seen.add(s.source);
      const item = document.createElement("div");
      item.className = "source-item";
      item.innerHTML = `<span class="source-item-dot">▪</span>`;
      if (s.url) {
        item.innerHTML += `<a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.source}</a>`;
      } else {
        item.innerHTML += `<span>${s.source}</span>`;
      }
      list.appendChild(item);
    });

    toggle.addEventListener("click", () => list.classList.toggle("open"));

    sourcesWrap.appendChild(toggle);
    sourcesWrap.appendChild(list);
    wrap.appendChild(sourcesWrap);
  }

  messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function appendTypingIndicator() {
  if (emptyState) emptyState.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = "message assistant";
  wrap.id = "typingIndicator";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = "GPT";

  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  indicator.innerHTML = `
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  `;

  wrap.appendChild(meta);
  wrap.appendChild(indicator);
  messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

async function sendMessage() {
  const question = chatInput.value.trim();
  if (!question || isChatting || !isIndexed) return;

  isChatting = true;
  chatInput.value = "";
  chatInput.style.height = "auto";
  sendBtn.disabled = true;

  appendMessage("user", question);
  const typingEl = appendTypingIndicator();

  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_url: currentRepoUrl,
        question,
        model: modelSelect.value,
      }),
    });

    const data = await res.json();
    typingEl.remove();

    if (!res.ok) {
      const chatErrDetail = data.detail;
      throw new Error(typeof chatErrDetail === "string" ? chatErrDetail : JSON.stringify(chatErrDetail) || "Chat failed");
    }

    appendMessage("assistant", data.answer, data.sources || []);
  } catch (err) {
    typingEl.remove();
    appendMessage("assistant", `⚠️ Error: ${err.message}`);
  } finally {
    isChatting = false;
    sendBtn.disabled = false;
    chatInput.focus();
  }
}

sendBtn.addEventListener("click", sendMessage);

// ─── Simple markdown renderer (no dependency) ────────────────────────────────
function simpleMarkdown(text) {
  return text
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Code blocks
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Bold
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    // Headings
    .replace(/^### (.+)$/gm, "<strong style='font-size:13px;'>$1</strong>")
    .replace(/^## (.+)$/gm, "<strong style='font-size:14px;'>$1</strong>")
    .replace(/^# (.+)$/gm, "<strong style='font-size:15px;'>$1</strong>")
    // Bullet lists
    .replace(/^\s*[-*] (.+)$/gm, "• $1")
    // Numbered lists
    .replace(/^\d+\.\s+(.+)$/gm, (_, p) => `${_}`)
    // Line breaks
    .replace(/\n/g, "<br>");
}

// ─── Custom Multi-Select UI Logic ───────────────────────────────────────────
const ALL_EXTS = [
  ".py", ".js", ".ts", ".md", ".txt", ".json", ".yaml", ".yml", ".java", ".go", ".rs",
  ".cpp", ".c", ".h", ".cs", ".php", ".swift", ".kt", ".scala",
  ".html", ".css", ".scss", ".less", ".ini", ".cfg", ".toml", ".xml"
];
let selectedExts = [".py", ".md", ".txt"];

function renderExtTags() {
  extTagsContainer.innerHTML = "";
  selectedExts.forEach(ext => {
    const tag = document.createElement("div");
    tag.className = "ext-tag";
    tag.innerHTML = `<span>${ext}</span><span class="tag-remove" data-ext="${ext}">&times;</span>`;
    extTagsContainer.appendChild(tag);
  });
}

function renderExtDropdown(filter = "") {
  extDropdown.innerHTML = "";
  const available = ALL_EXTS.filter(e => !selectedExts.includes(e));
  
  const filtered = available.filter(e => e.toLowerCase().includes(filter.toLowerCase()));
  
  if (filtered.length === 0) {
    extDropdown.innerHTML = `<div class="dropdown-item" style="color:var(--text-dim); cursor:default;">No unused extensions</div>`;
  } else {
    filtered.forEach(ext => {
      const item = document.createElement("div");
      item.className = "dropdown-item";
      item.textContent = ext;
      item.addEventListener("mousedown", (e) => {
        // use mousedown to fire before input blur
        e.preventDefault();
        selectedExts.push(ext);
        extTagInput.value = "";
        extDropdown.classList.remove("show");
        renderExtTags();
      });
      extDropdown.appendChild(item);
    });
  }
}

// Remove tag delegated event
extTagsContainer.addEventListener("click", (e) => {
  if (e.target.classList.contains("tag-remove")) {
    const ext = e.target.getAttribute("data-ext");
    selectedExts = selectedExts.filter(x => x !== ext);
    renderExtTags();
    if (document.activeElement === extTagInput) {
      renderExtDropdown(extTagInput.value);
    }
  }
});

extTagInput.addEventListener("focus", () => {
  renderExtDropdown(extTagInput.value);
  extDropdown.classList.add("show");
});

extTagInput.addEventListener("blur", () => {
  extDropdown.classList.remove("show");
});

extTagInput.addEventListener("input", (e) => {
  renderExtDropdown(e.target.value);
});

selectAllExtsBtn.addEventListener("click", () => {
  selectedExts = [...ALL_EXTS];
  renderExtTags();
  if (document.activeElement === extTagInput) renderExtDropdown(extTagInput.value);
});

clearExtsBtn.addEventListener("click", () => {
  selectedExts = [];
  renderExtTags();
  if (document.activeElement === extTagInput) renderExtDropdown(extTagInput.value);
});

// Initialize on load
renderExtTags();
