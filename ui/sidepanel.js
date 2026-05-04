const CACHE_SCHEMA_VERSION = "2026-04-12-v5";

const labelMap = {
  human: "Human",
  uncertain: "Uncertain",
  ai: "AI",
  gpt: "GPT",
  claude: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
};

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function riskColor(level) {
  return { low: "#6b7280", medium: "#d97706", high: "#dc2626" }[level] ?? "#6b7280";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateText(value, limit = 160) {
  const text = String(value ?? "").trim();
  if (!text) return "(No comment text cached)";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}...`;
}

function ensureToast() {
  let toast = document.getElementById("fpToast");
  if (toast) return toast;

  toast = document.createElement("div");
  toast.id = "fpToast";
  toast.style.cssText = `
    position: sticky;
    top: 12px;
    z-index: 20;
    margin-bottom: 12px;
    padding: 10px 12px;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    background: #111827;
    color: #f9fafb;
    font-family: 'Noto Sans KR', sans-serif;
    font-size: 12px;
    display: none;
  `;

  document.body.insertBefore(toast, document.body.firstChild);
  return toast;
}

function showToast(message, isError = false) {
  const toast = ensureToast();
  toast.textContent = message;
  toast.style.display = "block";
  toast.style.background = isError ? "#7f1d1d" : "#111827";
  toast.style.borderColor = isError ? "#b91c1c" : "#374151";

  window.clearTimeout(showToast._timerId);
  showToast._timerId = window.setTimeout(() => {
    toast.style.display = "none";
  }, 2600);
}

async function exportFalsePositive(result) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "FP_EXPORT_REQUEST",
        payload: {
          cache_key: result._cache_key,
          comment_id: result.comment_id ?? null,
          author_id: result.author_id ?? "",
          text: result.text ?? "",
          url: result.url ?? "",
          timestamp: result.timestamp ?? null,
          root_post_id: result.root_post_id ?? null,
          root_post_author_id: result.root_post_author_id ?? "",
          root_post_text: result.root_post_text ?? "",
          root_post_url: result.root_post_url ?? "",
          root_post_timestamp: result.root_post_timestamp ?? null,
          pred_label: result.pred_label,
          confidence: result.confidence,
          ai_score: result.ai_score,
          risk_level: result.risk_level,
          export_source: "sidepanel-card",
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (response?.status !== "success" || !response.data) {
          reject(new Error(response?.message ?? "FP export failed."));
          return;
        }

        resolve(response.data);
      }
    );
  });
}

function buildTop2Markup(top2) {
  return (top2 || [])
    .map(
      (item, index) => `
        <div class="top2-item">
          <span class="top2-name">${escapeHtml(labelMap[item[0]] ?? item[0])}</span>
          <div class="top2-bar-bg">
            <div class="top2-bar-fill ${index === 0 ? "top2-bar-fill--first" : ""}"
                 style="width:${pct(item[1])};"></div>
          </div>
          <span class="top2-pct">${pct(item[1])}</span>
        </div>
      `
    )
    .join("");
}

function createCard(result) {
  const {
    pred_label,
    confidence,
    ai_score,
    risk_level,
    top2,
    author_id,
    text,
    url,
    root_post_text,
    _fp_exported_at,
    _fp_export_status,
  } = result;

  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.style.cursor = "pointer";
  card.style.borderColor = _fp_exported_at ? "#065f46" : "";

  const previewText = truncateText(text);
  const rootPreviewText = truncateText(root_post_text || "(Root post not cached yet)", 120);
  const footerText = _fp_exported_at
    ? `Saved to FP CSV (${_fp_export_status ?? "saved"})`
    : "Click this card to append the comment to the FP CSV.";

  card.innerHTML = `
    <div class="card-top">
      <div class="pred-label">${escapeHtml(labelMap[pred_label] ?? pred_label)}</div>
      <div class="risk-badge risk-badge--${escapeHtml(risk_level)}">${escapeHtml(risk_level)}</div>
    </div>

    <div class="stat-row">
      <span class="stat-label">confidence</span>
      <span class="stat-value">${pct(confidence)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">ai_score</span>
      <span class="stat-value">${pct(ai_score)}</span>
    </div>

    <div class="bar-wrap">
      <div class="bar-bg">
        <div class="bar-fill" style="width:${pct(ai_score)};background:${riskColor(risk_level)};"></div>
      </div>
    </div>

    <div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:#111827;color:#d1d5db;line-height:1.5;">
      ${escapeHtml(previewText)}
    </div>

    <div style="margin-top:8px;padding:10px 12px;border-radius:8px;background:#151515;color:#9ca3af;line-height:1.5;">
      <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Root Post</div>
      ${escapeHtml(rootPreviewText)}
    </div>

    <hr class="divider" />

    <div class="top2-section">
      <div class="top2-title">Top 2</div>
      ${buildTop2Markup(top2)}
    </div>

    ${author_id ? `
      <div class="author-row">
        <span class="author-handle">${escapeHtml(author_id)}</span>
      </div>
    ` : ""}

    <div style="margin-top:10px;padding-top:10px;border-top:1px solid #2a2a2a;font-size:11px;color:${_fp_exported_at ? "#86efac" : "#9ca3af"};line-height:1.4;">
      ${escapeHtml(footerText)}
      ${url ? `<div style="margin-top:6px;word-break:break-all;color:#6b7280;">${escapeHtml(url)}</div>` : ""}
    </div>
  `;

  const handleExport = async () => {
    if (!result.text?.trim()) {
      showToast("No cached comment text was found for this result.", true);
      return;
    }

    if (card.dataset.exporting === "true") {
      return;
    }

    card.dataset.exporting = "true";
    const oldOpacity = card.style.opacity;
    card.style.opacity = "0.72";

    try {
      const exportResult = await exportFalsePositive(result);
      showToast(
        exportResult.status === "duplicate"
          ? "This comment was already in the FP CSV."
          : "Saved the comment to the FP CSV."
      );
    } catch (error) {
      showToast(error.message, true);
    } finally {
      card.dataset.exporting = "false";
      card.style.opacity = oldOpacity;
    }
  };

  card.addEventListener("click", handleExport);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleExport();
    }
  });

  return card;
}

async function updateUI() {
  const listElement = document.getElementById("resultList");
  const emptyElement = document.getElementById("emptyState");

  const allData = await chrome.storage.local.get(null);
  const results = Object.values(allData).filter(
    (item) => item && item.pred_label && item._schema_version === CACHE_SCHEMA_VERSION
  );
  const filtered = results.filter((item) => item.pred_label !== "human");

  if (filtered.length === 0) {
    emptyElement.style.display = "flex";
    listElement.innerHTML = "";
    return;
  }

  emptyElement.style.display = "none";
  listElement.innerHTML = "";

  filtered
    .sort((left, right) => {
      const leftTime = Date.parse(left._cached_at ?? 0);
      const rightTime = Date.parse(right._cached_at ?? 0);
      return rightTime - leftTime;
    })
    .forEach((result) => listElement.appendChild(createCard(result)));
}

document.addEventListener("DOMContentLoaded", () => {
  ensureToast();
  updateUI();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    updateUI();
  }
});
