const ANALYZED_ATTR = "data-ai-analyzed";
const BADGE_CLASS = "ai-detector-badge";
const STATUS_PATH_REGEX = /\/status\/(\d+)/;

function getCurrentStatusId() {
  const match = window.location.pathname.match(STATUS_PATH_REGEX);
  return match ? match[1] : null;
}

function isStatusPage() {
  return Boolean(getCurrentStatusId());
}

function extractAuthorId(article) {
  const authorEl = article.querySelector('[data-testid="User-Name"]');
  const handleSpan = authorEl
    ? [...authorEl.querySelectorAll("span")].find((span) => span.innerText.startsWith("@"))
    : null;

  return handleSpan?.innerText?.trim() ?? "";
}

function extractStatusLink(article) {
  const timeLink = article.querySelector("time")?.closest('a[href*="/status/"]');
  if (timeLink) {
    return timeLink;
  }

  return article.querySelector('a[href*="/status/"]');
}

function extractStatusId(article) {
  const statusLink = extractStatusLink(article);
  const statusMatch = statusLink?.href?.match(/\/status\/(\d+)/);
  return statusMatch ? statusMatch[1] : null;
}

function extractArticleData(article) {
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = textEl?.innerText?.trim();
  if (!text) return null;

  const author_id = extractAuthorId(article);
  const statusLink = extractStatusLink(article);
  const comment_id = extractStatusId(article);
  const url = statusLink?.href ?? window.location.href;
  const timeEl = article.querySelector("time");
  const timestamp = timeEl?.getAttribute("datetime") ?? new Date().toISOString();

  return { comment_id, author_id, text, url, timestamp };
}

function getRootPostContext() {
  const rootStatusId = getCurrentStatusId();
  if (!rootStatusId) {
    return {
      root_post_id: null,
      root_post_author_id: "",
      root_post_text: "",
      root_post_url: window.location.href,
      root_post_timestamp: null,
    };
  }

  const rootArticle = [...document.querySelectorAll("article")].find(
    (article) => extractStatusId(article) === rootStatusId
  );
  const rootData = rootArticle ? extractArticleData(rootArticle) : null;

  return {
    root_post_id: rootData?.comment_id ?? rootStatusId,
    root_post_author_id: rootData?.author_id ?? "",
    root_post_text: rootData?.text ?? "",
    root_post_url: rootData?.url ?? window.location.href,
    root_post_timestamp: rootData?.timestamp ?? null,
  };
}

function extractCommentData(article) {
  const commentData = extractArticleData(article);
  if (!commentData) return null;

  return {
    ...commentData,
    ...getRootPostContext(),
  };
}

function requestAnalysis(article, commentData) {
  article.setAttribute(ANALYZED_ATTR, "pending");

  chrome.runtime.sendMessage(
    { type: "ANALYZE_REQUEST", payload: commentData },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[AI Detector] sendMessage failed:", chrome.runtime.lastError.message);
        article.setAttribute(ANALYZED_ATTR, "error");
        return;
      }

      if (response?.status === "success" && response.data) {
        article.setAttribute(ANALYZED_ATTR, "done");
        renderBadge(article, response.data);
      } else {
        article.setAttribute(ANALYZED_ATTR, "error");
      }
    }
  );
}

function getLabelText(predLabel) {
  const labelMap = {
    uncertain: "Uncertain",
    ai: "AI",
    gpt: "AI / GPT",
    claude: "AI / Claude",
    gemini: "AI / Gemini",
    deepseek: "AI / DeepSeek",
  };

  return labelMap[predLabel] ?? "AI";
}

function getRiskColor(riskLevel) {
  const colorMap = {
    low: "#6b7280",
    medium: "#d97706",
    high: "#dc2626",
  };

  return colorMap[riskLevel] ?? "#6b7280";
}

function buildBadgeTitle(result) {
  const base = `ai_score: ${(result.ai_score * 100).toFixed(1)}% / confidence: ${(result.confidence * 100).toFixed(1)}%`;
  if (result._fp_exported_at) {
    return `${base}\nSaved to FP CSV at ${result._fp_exported_at}`;
  }

  return `${base}\nClick to save this comment as a false positive candidate.`;
}

function updateBadgeAfterExport(badge, result, feedbackData) {
  badge.textContent = `${getLabelText(result.pred_label)} ${(result.ai_score * 100).toFixed(1)}% / FP saved`;
  badge.title = `Saved to ${feedbackData.file_path}\n${feedbackData.exported_at}`;
  badge.dataset.fpExported = "true";
}

function exportFalsePositive(result, badge) {
  if (badge.dataset.fpExporting === "true") return;

  badge.dataset.fpExporting = "true";
  const previousText = badge.textContent;
  badge.textContent = "Saving FP...";
  const liveRootContext = getRootPostContext();

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
        root_post_id: liveRootContext.root_post_id ?? result.root_post_id ?? null,
        root_post_author_id: liveRootContext.root_post_author_id ?? result.root_post_author_id ?? "",
        root_post_text: liveRootContext.root_post_text ?? result.root_post_text ?? "",
        root_post_url: liveRootContext.root_post_url ?? result.root_post_url ?? "",
        root_post_timestamp: liveRootContext.root_post_timestamp ?? result.root_post_timestamp ?? null,
        pred_label: result.pred_label,
        confidence: result.confidence,
        ai_score: result.ai_score,
        risk_level: result.risk_level,
        export_source: "content-badge",
      },
    },
    (response) => {
      badge.dataset.fpExporting = "false";

      if (chrome.runtime.lastError) {
        console.warn("[AI Detector] FP export failed:", chrome.runtime.lastError.message);
        badge.textContent = previousText;
        return;
      }

      if (response?.status !== "success" || !response.data) {
        console.warn("[AI Detector] FP export failed:", response?.message ?? "Unknown error");
        badge.textContent = previousText;
        return;
      }

      updateBadgeAfterExport(badge, result, response.data);
    }
  );
}

function renderBadge(article, result) {
  article.querySelector(`.${BADGE_CLASS}`)?.remove();

  const { pred_label, ai_score, risk_level } = result;
  if (pred_label === "human") return;

  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.title = buildBadgeTitle(result);
  badge.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 8px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    background-color: ${getRiskColor(risk_level)};
    vertical-align: middle;
    cursor: pointer;
    user-select: none;
  `;

  const baseText = `${getLabelText(pred_label)} ${(ai_score * 100).toFixed(1)}%`;
  badge.textContent = result._fp_exported_at ? `${baseText} / FP saved` : baseText;

  badge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    exportFalsePositive(result, badge);
  });

  const authorEl = article.querySelector('[data-testid="User-Name"]');
  if (authorEl) {
    authorEl.appendChild(badge);
  } else {
    article.prepend(badge);
  }
}

function processArticle(article) {
  if (article.hasAttribute(ANALYZED_ATTR)) return;
  if (!isStatusPage()) return;

  const data = extractCommentData(article);
  if (!data) return;

  const rootStatusId = getCurrentStatusId();
  if (!data.comment_id || data.comment_id === rootStatusId) {
    article.setAttribute(ANALYZED_ATTR, "skipped");
    return;
  }

  requestAnalysis(article, data);
}

function scanAllArticles() {
  document.querySelectorAll("article").forEach(processArticle);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;

      if (node.tagName === "ARTICLE") {
        processArticle(node);
      }

      node.querySelectorAll?.("article").forEach(processArticle);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

scanAllArticles();

console.log("[AI Detector] content-script loaded");
