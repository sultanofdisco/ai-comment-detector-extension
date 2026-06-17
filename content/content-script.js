const ANALYZED_ATTR = "data-ai-analyzed";
const BADGE_CLASS = "ai-detector-badge";
const XAI_TRIGGER_CLASS = "ai-detector-xai-trigger";
const ACCOUNT_BUTTON_CLASS = "ai-detector-account-button";
const ACCOUNT_REPLY_PILL_CLASS = "ai-detector-account-reply-pill";
const ACCOUNT_VIEW_PANEL_ID = "ai-detector-account-view";
const ACCOUNT_VIEW_QUERY_PARAM = "ai_detector_account_view";
const ACCOUNT_VIEW_SAMPLE_LIMIT = 8;
const WITH_REPLIES_PATH_REGEX = /^\/([A-Za-z0-9_]{1,15})\/with_replies\/?$/;
const STATUS_PATH_REGEX = /\/status\/(\d+)/;
const HANDLE_TEXT_REGEX = /^@[A-Za-z0-9_]{1,15}$/;
const HANDLE_MATCH_REGEX = /@[A-Za-z0-9_]{1,15}/g;
const MESSAGE_RETRY_DELAY_MS = 800;
const ACCOUNT_PROFILE_AI_THRESHOLD = 0.7;
const ANALYZE_QUEUE_MAX_CONCURRENT = 2;
let extensionContextInvalidated = false;
let observer;
const aiScorePromises = new Map();
const pendingArticleAnalyses = [];
let activeArticleAnalysisCount = 0;
let activeAccountViewRunId = 0;

function shouldTreatAsContextInvalidation(message) {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes("extension context invalidated");
}

function isRetryableRuntimeError(message) {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("a listener indicated an asynchronous response by returning true") ||
    normalized.includes("message channel closed before a response was received") ||
    normalized.includes("the message port closed before a response was received") ||
    normalized.includes("receiving end does not exist")
  );
}

function isRuntimeAvailable() {
  if (extensionContextInvalidated) {
    return false;
  }

  try {
    return (
      typeof chrome !== "undefined" &&
      Boolean(chrome?.runtime?.id) &&
      typeof chrome.runtime.sendMessage === "function"
    );
  } catch (error) {
    invalidateExtensionContext(error?.message ?? error);
    return false;
  }
}

function invalidateExtensionContext(reason) {
  if (extensionContextInvalidated) {
    return;
  }

  extensionContextInvalidated = true;
  observer?.disconnect?.();
  console.warn("[AI Detector] extension context is no longer available:", reason);
}

function sendRuntimeMessage(message, retryCount = 1) {
  return new Promise((resolve, reject) => {
    const attemptSend = (remainingRetries) => {
      if (!isRuntimeAvailable()) {
        reject(new Error("Extension runtime unavailable."));
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            const errorMessage = runtimeError.message ?? "Unknown runtime error.";
            if (remainingRetries > 0 && isRetryableRuntimeError(errorMessage)) {
              window.setTimeout(() => attemptSend(remainingRetries - 1), MESSAGE_RETRY_DELAY_MS);
              return;
            }

            if (shouldTreatAsContextInvalidation(errorMessage)) {
              invalidateExtensionContext(errorMessage);
            }

            reject(new Error(errorMessage));
            return;
          }

          resolve(response);
        });
      } catch (error) {
        const errorMessage = error?.message ?? String(error);
        if (shouldTreatAsContextInvalidation(errorMessage)) {
          invalidateExtensionContext(errorMessage);
        }
        reject(error instanceof Error ? error : new Error(errorMessage));
      }
    };

    attemptSend(retryCount);
  });
}

function clampProbability(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(1, numeric));
}

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

  if (handleSpan?.innerText?.trim()) {
    return handleSpan.innerText.trim();
  }

  const handleAnchor = authorEl
    ? [...authorEl.querySelectorAll('a[href^="/"]')].find((anchor) =>
        /^\/[A-Za-z0-9_]{1,15}\/?$/.test(anchor.getAttribute("href") ?? "")
      )
    : null;

  if (!handleAnchor) {
    return "";
  }

  const href = handleAnchor.getAttribute("href") ?? "";
  const normalizedHref = href.replace(/\/+$/, "");
  return normalizedHref ? `@${normalizedHref.replace("/", "")}` : "";
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

function collectUniqueHandles(text, seenHandles, output, excludedHandles = new Set()) {
  const matches = String(text ?? "").match(HANDLE_MATCH_REGEX) ?? [];
  for (const handle of matches) {
    if (excludedHandles.has(handle)) continue;
    if (seenHandles.has(handle)) continue;
    seenHandles.add(handle);
    output.push(handle);
  }
}

function normalizeVisibleText(value) {
  return String(value ?? "")
    .replaceAll("\u00A0", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPercent(value) {
  return `${(clampProbability(value) * 100).toFixed(1)}%`;
}

function getRepliesTimelineHandle() {
  const match = window.location.pathname.match(WITH_REPLIES_PATH_REGEX);
  return match ? `@${match[1]}` : null;
}

function getTriggeredAccountViewHandle() {
  const handle = getRepliesTimelineHandle();
  if (!handle) {
    return null;
  }

  const url = new URL(window.location.href);
  return url.searchParams.get(ACCOUNT_VIEW_QUERY_PARAM) === "1" ? handle : null;
}

function clearAccountViewTrigger() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ACCOUNT_VIEW_QUERY_PARAM)) {
    return;
  }

  url.searchParams.delete(ACCOUNT_VIEW_QUERY_PARAM);
  window.history.replaceState({}, "", url.toString());
}

function buildAccountCommentLookupKey(handle, commentId, text) {
  return commentId ?? `${handle}::${normalizeVisibleText(text)}`;
}

function buildAccountRepliesViewUrl(handle) {
  const baseUrl = globalThis.AccountAnalyzer?.buildRepliesUrl
    ? globalThis.AccountAnalyzer.buildRepliesUrl(handle)
    : new URL(`/${String(handle ?? "").replace(/^@/, "")}/with_replies`, window.location.origin).toString();
  const url = new URL(baseUrl);
  url.searchParams.set(ACCOUNT_VIEW_QUERY_PARAM, "1");
  return url.toString();
}

function formatLanguageDistribution(languageDistribution) {
  return Object.entries(languageDistribution ?? {})
    .sort((left, right) => right[1] - left[1])
    .map(([languageCode, count]) => `${languageCode}: ${count}`)
    .join(", ");
}

function shouldRenderAccountProfileButton(result) {
  return Boolean(result?.author_id) && result.pred_label !== "human";
}

async function detectAI(commentText) {
  const normalizedText = normalizeVisibleText(commentText);
  if (!normalizedText) {
    return 0;
  }

  if (aiScorePromises.has(normalizedText)) {
    return aiScorePromises.get(normalizedText);
  }

  const scorePromise = sendRuntimeMessage(
    {
      type: "DETECT_AI_SCORE_REQUEST",
      payload: {
        text: normalizedText,
      },
    },
    1
  )
    .then((response) => {
      if (response?.status !== "success" || !response.data) {
        throw new Error(response?.message ?? "Text-only AI detection failed.");
      }

      return clampProbability(response.data.aiScore ?? 0);
    })
    .catch((error) => {
      aiScorePromises.delete(normalizedText);
      throw error;
    });

  aiScorePromises.set(normalizedText, scorePromise);
  return scorePromise;
}

function extractVisiblePrefixBeforeBody(article, bodyText) {
  const articleText = normalizeVisibleText(article?.innerText);
  const normalizedBody = normalizeVisibleText(bodyText);
  if (!articleText || !normalizedBody) {
    return "";
  }

  const bodyIndex = articleText.indexOf(normalizedBody);
  if (bodyIndex <= 0) {
    return "";
  }

  return articleText.slice(0, bodyIndex).trim();
}

function extractLeadingReplyMentions(article, textEl) {
  if (!article || !textEl) {
    return "";
  }

  const bodyText = textEl.innerText?.trim() ?? "";
  const mentions = [];
  const seenHandles = new Set();
  const authorHandle = extractAuthorId(article);
  const bodyHandles = new Set(String(bodyText).match(HANDLE_MATCH_REGEX) ?? []);
  const excludedHandles = new Set(authorHandle ? [authorHandle, ...bodyHandles] : [...bodyHandles]);
  const visiblePrefix = extractVisiblePrefixBeforeBody(article, bodyText);

  if (visiblePrefix) {
    collectUniqueHandles(visiblePrefix, seenHandles, mentions, excludedHandles);
  }

  if (mentions.length > 0) {
    return mentions.join(" ");
  }

  const candidateAnchors = [...article.querySelectorAll('a[href^="/"]')].filter((anchor) => {
    const text = anchor.innerText?.trim();
    if (!text || !HANDLE_TEXT_REGEX.test(text)) {
      return false;
    }
    if (anchor.closest('[data-testid="User-Name"]')) {
      return false;
    }
    if (textEl.contains(anchor)) {
      return false;
    }
    const href = anchor.getAttribute("href") ?? "";
    if (href.includes("/status/")) {
      return false;
    }
    return true;
  });

  for (const anchor of candidateAnchors) {
    collectUniqueHandles(anchor.innerText, seenHandles, mentions, excludedHandles);
  }

  if (mentions.length > 0) {
    return mentions.join(" ");
  }

  const fallbackContainers = [];
  let sibling = textEl.previousElementSibling;
  while (sibling && fallbackContainers.length < 4) {
    fallbackContainers.push(sibling);
    sibling = sibling.previousElementSibling;
  }

  for (const container of fallbackContainers.reverse()) {
    if (container.closest('[data-testid="User-Name"]')) {
      continue;
    }
    collectUniqueHandles(container.innerText, seenHandles, mentions, excludedHandles);
  }

  return mentions.join(" ");
}

function buildTextWithLeadingMentions(leadingMentions, bodyText) {
  return [leadingMentions?.trim(), bodyText?.trim()].filter(Boolean).join(" ").trim();
}

function extractArticleData(article) {
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = textEl?.innerText?.trim();
  if (!text) return null;
  const reply_mentions_text = extractLeadingReplyMentions(article, textEl);
  const text_with_reply_mentions = buildTextWithLeadingMentions(reply_mentions_text, text);

  const author_id = extractAuthorId(article);
  const statusLink = extractStatusLink(article);
  const comment_id = extractStatusId(article);
  const url = statusLink?.href ?? window.location.href;
  const timeEl = article.querySelector("time");
  const timestamp = timeEl?.getAttribute("datetime") ?? new Date().toISOString();

  return {
    comment_id,
    author_id,
    text,
    reply_mentions_text,
    text_with_reply_mentions,
    url,
    timestamp,
  };
}

function getRootPostContext() {
  const rootStatusId = getCurrentStatusId();
  if (!rootStatusId) {
    return {
      root_post_id: null,
      root_post_author_id: "",
      root_post_text: "",
      root_post_reply_mentions_text: "",
      root_post_text_with_reply_mentions: "",
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
    root_post_reply_mentions_text: rootData?.reply_mentions_text ?? "",
    root_post_text_with_reply_mentions: rootData?.text_with_reply_mentions ?? "",
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

function finalizeQueuedArticleAnalysis() {
  activeArticleAnalysisCount = Math.max(0, activeArticleAnalysisCount - 1);
  drainArticleAnalysisQueue();
}

function drainArticleAnalysisQueue() {
  while (
    activeArticleAnalysisCount < ANALYZE_QUEUE_MAX_CONCURRENT &&
    pendingArticleAnalyses.length > 0
  ) {
    const nextTask = pendingArticleAnalyses.shift();
    if (!nextTask) {
      return;
    }

    activeArticleAnalysisCount += 1;
    void runQueuedArticleAnalysis(nextTask.article, nextTask.commentData).finally(
      finalizeQueuedArticleAnalysis
    );
  }
}

function enqueueArticleAnalysis(article, commentData) {
  article.setAttribute(ANALYZED_ATTR, "queued");
  pendingArticleAnalyses.push({ article, commentData });
  drainArticleAnalysisQueue();
}

function runQueuedArticleAnalysis(article, commentData) {
  article.setAttribute(ANALYZED_ATTR, "pending");

  if (!isRuntimeAvailable()) {
    article.setAttribute(ANALYZED_ATTR, "error");
    return Promise.resolve();
  }

  return sendRuntimeMessage({ type: "ANALYZE_REQUEST", payload: commentData }, 1)
    .then((response) => {
      if (response?.status === "success" && response.data) {
        article.setAttribute(ANALYZED_ATTR, "done");
        renderBadge(article, response.data);
        renderXAITrigger(article, response.data);
        return;
      }

      if (response?.message) {
        console.warn("[AI Detector] analyze request failed:", response.message);
      }
      article.setAttribute(ANALYZED_ATTR, "error");
    })
    .catch((error) => {
      console.warn("[AI Detector] sendMessage failed:", error?.message ?? error);
      article.setAttribute(ANALYZED_ATTR, "error");
    });
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

function buildAccountProfileSummary(profile) {
  const languageSummary =
    formatLanguageDistribution(profile.languageDistribution) || "no language distribution";

  return [
    `Account verdict: ${profile.verdict}`,
    `Languages: ${profile.uniqueLanguageCount} (${languageSummary})`,
    `Korean comments: ${profile.koreanCommentCount}`,
    `Korean mean/max: ${(profile.aiSuspicion.mean * 100).toFixed(1)}% / ${(profile.aiSuspicion.max * 100).toFixed(1)}%`,
    `Korean high ratio > ${(ACCOUNT_PROFILE_AI_THRESHOLD * 100).toFixed(0)}% (top 5 replies): ${(profile.aiSuspicion.highRatioAboveThreshold * 100).toFixed(1)}%`,
  ].join("\n");
}

function buildAccountButtonTitle(profile) {
  if (!profile) {
    return "Open this account's with_replies page and run a visual AI analysis.";
  }

  return `Open the visual replies view for this account.\n${buildAccountProfileSummary(profile)}`;
}

function setAccountButtonState(button, state, profile = null) {
  button.dataset.state = state;
  button.dataset.hasProfile = profile ? "true" : "false";
  button.disabled = state === "loading";

  if (state === "loading") {
    button.textContent = "Opening...";
    button.title = "Opening the with_replies analysis view.";
    return;
  }

  if (state === "error") {
    button.textContent = "Retry";
    button.title = "Failed to open the visual replies view. Click to try again.";
    return;
  }

  button.textContent = "Account";
  button.title = buildAccountButtonTitle(profile);
}

function updateBadgeWithAccountProfile(article, result, profile) {
  const badge = article.querySelector(`.${BADGE_CLASS}`);
  if (!badge) {
    return;
  }

  badge.title = `${buildBadgeTitle(result)}\n${buildAccountProfileSummary(profile)}`;
}

async function storeAccountProfile(handle, profile) {
  const allEntries = await chrome.storage.local.get(null);
  const updates = {};
  const profileUpdatedAt = new Date().toISOString();

  for (const [cacheKey, value] of Object.entries(allEntries)) {
    if (!value?.pred_label || value.author_id !== handle) {
      continue;
    }

    updates[cacheKey] = {
      ...value,
      account_profile: profile,
      account_profile_updated_at: profileUpdatedAt,
    };
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function buildAccountViewStatusMessage(progress, handle) {
  if (!progress || typeof progress !== "object") {
    return `Analyzing recent replies for ${handle}...`;
  }

  if (progress.stage === "collect") {
    return `Collecting recent replies for ${handle}: ${progress.collectedCount} found`;
  }

  if (progress.stage === "language") {
    return `Detecting languages: ${progress.processedCount}/${progress.totalCount}`;
  }

  if (progress.stage === "score") {
    return `Scoring Korean replies: ${progress.processedCount}/${progress.totalCount}`;
  }

  return `Analyzing recent replies for ${handle}...`;
}

function getAccountViewVerdictColor(verdict) {
  return {
    suspicious: "#f87171",
    borderline: "#fbbf24",
    likely_human: "#34d399",
  }[verdict] ?? "#94a3b8";
}

function getAccountReplySampleTone(sample) {
  if (sample.aiScore == null) {
    return "muted";
  }

  if (sample.aiScore >= 0.85) {
    return "high";
  }

  if (sample.aiScore >= 0.5) {
    return "medium";
  }

  return "low";
}

function getAccountReplySampleMeta(sample) {
  const languageLabel = String(sample.languageCode ?? "und").toUpperCase();
  if (sample.aiScore == null) {
    return `${languageLabel} · not scored`;
  }

  return `${languageLabel} · ${formatPercent(sample.aiScore)}`;
}

function buildAccountViewRecentCommentsMarkup(handle, profile) {
  const recentComments = profile?.recentComments ?? [];
  if (recentComments.length === 0) {
    return `<div class="ai-detector-account-view__empty">No recent reply samples were collected yet.</div>`;
  }

  return recentComments
    .map((comment, index) => {
      const commentKey = buildAccountCommentLookupKey(handle, comment.commentId, comment.text);
      const tone = getAccountReplySampleTone(comment);
      const scoreMarkup =
        comment.aiScore == null
          ? `<span class="ai-detector-account-view__sample-score ai-detector-account-view__sample-score--muted">Skipped</span>`
          : `<span class="ai-detector-account-view__sample-score ai-detector-account-view__sample-score--${tone}">${escapeHtml(formatPercent(comment.aiScore))}</span>`;

      return `
        <button
          type="button"
          class="ai-detector-account-view__sample"
          data-comment-key="${escapeHtml(commentKey)}"
          title="Scroll to this reply in the timeline."
        >
          <div class="ai-detector-account-view__sample-top">
            <span class="ai-detector-account-view__sample-index">#${index + 1}</span>
            <span class="ai-detector-account-view__sample-meta">${escapeHtml(getAccountReplySampleMeta(comment))}</span>
            ${scoreMarkup}
          </div>
          <div class="ai-detector-account-view__sample-text">${escapeHtml(comment.text)}</div>
        </button>
      `;
    })
    .join("");
}

function buildAccountViewMarkup(handle, renderState) {
  const statusMarkup = renderState.errorMessage
    ? `<div class="ai-detector-account-view__status ai-detector-account-view__status--error">${escapeHtml(renderState.errorMessage)}</div>`
    : `<div class="ai-detector-account-view__status">${escapeHtml(renderState.statusMessage ?? `Analyzing recent replies for ${handle}...`)}</div>`;

  const profile = renderState.profile ?? null;
  const summaryMarkup = profile
    ? `
      <div class="ai-detector-account-view__summary">
        <div class="ai-detector-account-view__summary-top">
          <div>
            <div class="ai-detector-account-view__eyebrow">AI Detector</div>
            <div class="ai-detector-account-view__title">${escapeHtml(handle)} recent replies</div>
          </div>
          <div class="ai-detector-account-view__verdict" style="border-color:${getAccountViewVerdictColor(profile.verdict)};color:${getAccountViewVerdictColor(profile.verdict)};">
            ${escapeHtml(profile.verdict)}
          </div>
        </div>
        <div class="ai-detector-account-view__stats">
          <span>${escapeHtml(String(profile.totalComments))} recent replies</span>
          <span>${escapeHtml(String(profile.uniqueLanguageCount))} languages</span>
          <span>${escapeHtml(String(profile.koreanCommentCount))} Korean</span>
          <span>mean ${escapeHtml(formatPercent(profile.aiSuspicion.mean))}</span>
          <span>max ${escapeHtml(formatPercent(profile.aiSuspicion.max))}</span>
          <span>top5&gt;70 ${escapeHtml(formatPercent(profile.aiSuspicion.highRatioAboveThreshold))}</span>
        </div>
        <div class="ai-detector-account-view__languages">
          ${escapeHtml(formatLanguageDistribution(profile.languageDistribution) || "No language distribution")}
        </div>
      </div>
      <div class="ai-detector-account-view__section-title">Recent replies</div>
      <div class="ai-detector-account-view__samples">
        ${buildAccountViewRecentCommentsMarkup(handle, profile)}
      </div>
    `
    : `
      <div class="ai-detector-account-view__summary">
        <div class="ai-detector-account-view__summary-top">
          <div>
            <div class="ai-detector-account-view__eyebrow">AI Detector</div>
            <div class="ai-detector-account-view__title">${escapeHtml(handle)} recent replies</div>
          </div>
        </div>
      </div>
    `;

  return `
    <div class="ai-detector-account-view__header">
      <div>
        <div class="ai-detector-account-view__eyebrow">Account view</div>
        <div class="ai-detector-account-view__handle">${escapeHtml(handle)}</div>
      </div>
      <div class="ai-detector-account-view__actions">
        <button type="button" data-action="refresh" ${renderState.isLoading ? "disabled" : ""}>Refresh</button>
        <button type="button" data-action="close">Close</button>
      </div>
    </div>
    ${statusMarkup}
    ${summaryMarkup}
  `;
}

function clearAccountReplyDecorations() {
  document.querySelectorAll(`.${ACCOUNT_REPLY_PILL_CLASS}`).forEach((element) => element.remove());
  document
    .querySelectorAll('article[data-ai-detector-account-comment-key]')
    .forEach((article) => {
      article.removeAttribute("data-ai-detector-account-comment-key");
      article.removeAttribute("data-ai-detector-account-tone");
    });
}

function renderAccountReplyPill(article, sample) {
  article.querySelector(`.${ACCOUNT_REPLY_PILL_CLASS}`)?.remove();

  const pill = document.createElement("span");
  const tone = getAccountReplySampleTone(sample);
  pill.className = `${ACCOUNT_REPLY_PILL_CLASS} ${ACCOUNT_REPLY_PILL_CLASS}--${tone}`;
  pill.textContent =
    sample.aiScore == null
      ? String(sample.languageCode ?? "und").toUpperCase()
      : `${String(sample.languageCode ?? "und").toUpperCase()} ${formatPercent(sample.aiScore)}`;
  pill.title =
    sample.aiScore == null
      ? `${sample.languageCode} reply: not scored`
      : `${sample.languageCode} reply scored ${formatPercent(sample.aiScore)}`;

  const authorEl = article.querySelector('[data-testid="User-Name"]');
  if (authorEl) {
    authorEl.appendChild(pill);
  } else {
    article.prepend(pill);
  }
}

function decorateRecentRepliesOnPage(handle, profile) {
  clearAccountReplyDecorations();

  const sampleMap = new Map(
    (profile?.recentComments ?? []).map((comment) => [
      buildAccountCommentLookupKey(handle, comment.commentId, comment.text),
      comment,
    ])
  );

  document.querySelectorAll("article").forEach((article) => {
    if (extractAuthorId(article) !== handle) {
      return;
    }

    const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim();
    if (!text) {
      return;
    }

    const commentId = extractStatusId(article);
    const commentKey = buildAccountCommentLookupKey(handle, commentId, text);
    const sample = sampleMap.get(commentKey);
    if (!sample) {
      return;
    }

    article.dataset.aiDetectorAccountCommentKey = commentKey;
    article.dataset.aiDetectorAccountTone = getAccountReplySampleTone(sample);
    renderAccountReplyPill(article, sample);
  });
}

function scrollToDecoratedReply(commentKey) {
  const article = [...document.querySelectorAll("article")].find(
    (candidate) => candidate.dataset.aiDetectorAccountCommentKey === commentKey
  );
  if (!article) {
    return;
  }

  article.scrollIntoView({ behavior: "smooth", block: "center" });
}

function getOrCreateAccountViewPanel() {
  let panel = document.getElementById(ACCOUNT_VIEW_PANEL_ID);
  if (panel) {
    return panel;
  }

  panel = document.createElement("aside");
  panel.id = ACCOUNT_VIEW_PANEL_ID;
  panel.className = "ai-detector-account-view";
  document.body.appendChild(panel);
  return panel;
}

function removeAccountViewPanel() {
  document.getElementById(ACCOUNT_VIEW_PANEL_ID)?.remove();
}

function renderAccountView(handle, renderState) {
  const panel = getOrCreateAccountViewPanel();
  panel.innerHTML = buildAccountViewMarkup(handle, renderState);

  panel.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
    void runAccountRepliesView(handle);
  });

  panel.querySelector('[data-action="close"]')?.addEventListener("click", () => {
    clearAccountReplyDecorations();
    clearAccountViewTrigger();
    removeAccountViewPanel();
  });

  panel.querySelectorAll("[data-comment-key]").forEach((button) => {
    button.addEventListener("click", () => {
      scrollToDecoratedReply(button.getAttribute("data-comment-key") ?? "");
    });
  });
}

async function runAccountRepliesView(handle) {
  if (!globalThis.AccountAnalyzer?.analyzeCurrentRepliesPage) {
    renderAccountView(handle, {
      isLoading: false,
      errorMessage: "The account timeline analyzer is unavailable.",
      profile: null,
      statusMessage: "",
    });
    return;
  }

  const runId = Date.now();
  activeAccountViewRunId = runId;
  renderAccountView(handle, {
    isLoading: true,
    errorMessage: "",
    profile: null,
    statusMessage: `Opening recent replies for ${handle}...`,
  });

  try {
    const profile = await globalThis.AccountAnalyzer.analyzeCurrentRepliesPage(handle, {
      detectAI,
      threshold: ACCOUNT_PROFILE_AI_THRESHOLD,
      recentCommentSampleLimit: ACCOUNT_VIEW_SAMPLE_LIMIT,
      targetCommentCount: ACCOUNT_VIEW_SAMPLE_LIMIT,
      replyScanTimeoutMs: 15000,
      replyScrollSteps: 4,
      replyScrollPauseMs: 700,
      onProgress(progress) {
        if (activeAccountViewRunId !== runId) {
          return;
        }

        renderAccountView(handle, {
          isLoading: true,
          errorMessage: "",
          profile: null,
          statusMessage: buildAccountViewStatusMessage(progress, handle),
        });
      },
    });

    if (activeAccountViewRunId !== runId) {
      return;
    }

    await storeAccountProfile(handle, profile);
    decorateRecentRepliesOnPage(handle, profile);
    renderAccountView(handle, {
      isLoading: false,
      errorMessage: "",
      profile,
      statusMessage: `Analyzed ${profile.totalComments} recent replies from ${handle}.`,
    });
  } catch (error) {
    if (activeAccountViewRunId !== runId) {
      return;
    }

    renderAccountView(handle, {
      isLoading: false,
      errorMessage: error?.message ?? "Failed to analyze the replies page.",
      profile: null,
      statusMessage: "",
    });
  }
}

function openAccountRepliesView(handle, button, profile = null) {
  if (!handle) {
    return;
  }

  if (button) {
    setAccountButtonState(button, "loading", profile);
  }

  window.location.assign(buildAccountRepliesViewUrl(handle));
}

function createAccountProfileButton(article, result) {
  if (!shouldRenderAccountProfileButton(result)) {
    return null;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = ACCOUNT_BUTTON_CLASS;
  button.dataset.authorId = result.author_id;
  setAccountButtonState(
    button,
    result.account_profile ? "ready" : "idle",
    result.account_profile ?? null
  );

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openAccountRepliesView(result.author_id, button, result.account_profile ?? null);
  });

  return button;
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

  if (!isRuntimeAvailable()) {
    badge.dataset.fpExporting = "false";
    badge.textContent = previousText;
    return;
  }

  void sendRuntimeMessage(
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
    1
  )
    .then((response) => {
      badge.dataset.fpExporting = "false";

      if (response?.status !== "success" || !response.data) {
        console.warn("[AI Detector] FP export failed:", response?.message ?? "Unknown error");
        badge.textContent = previousText;
        return;
      }

      updateBadgeAfterExport(badge, result, response.data);
    })
    .catch((error) => {
      badge.dataset.fpExporting = "false";
      badge.textContent = previousText;
      console.warn("[AI Detector] FP export failed:", error?.message ?? error);
    });
}

function renderXAITrigger(article, result) {
  article.querySelector(`.${XAI_TRIGGER_CLASS}`)?.remove();

  if (result.pred_label === "human" || !result.reason?.trim()) {
    return;
  }

  const trigger = document.createElement("span");
  trigger.className = XAI_TRIGGER_CLASS;

  const label = document.createElement("span");
  label.className = "ai-detector-xai-trigger__label";
  label.textContent = "XAI";

  const tooltip = document.createElement("span");
  tooltip.className = "ai-detector-xai-tooltip";
  tooltip.textContent = result.reason.trim();

  trigger.appendChild(label);
  trigger.appendChild(tooltip);

  const badge = article.querySelector(`.${BADGE_CLASS}`);
  if (badge) {
    badge.insertAdjacentElement("afterend", trigger);
    return;
  }

  const authorEl = article.querySelector('[data-testid="User-Name"]');
  if (authorEl) {
    authorEl.appendChild(trigger);
  }
}

function renderBadge(article, result) {
  article.querySelector(`.${BADGE_CLASS}`)?.remove();
  article.querySelector(`.${XAI_TRIGGER_CLASS}`)?.remove();
  article.querySelector(`.${ACCOUNT_BUTTON_CLASS}`)?.remove();

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

  const accountButton = createAccountProfileButton(article, result);

  const authorEl = article.querySelector('[data-testid="User-Name"]');
  if (authorEl) {
    authorEl.appendChild(badge);
    if (accountButton) {
      authorEl.appendChild(accountButton);
    }
  } else {
    article.prepend(badge);
    if (accountButton) {
      article.prepend(accountButton);
    }
  }

  if (result.account_profile) {
    updateBadgeWithAccountProfile(article, result, result.account_profile);
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

  enqueueArticleAnalysis(article, data);
}

function scanAllArticles() {
  document.querySelectorAll("article").forEach(processArticle);
}

function startStatusPageAnalysis() {
  observer = new MutationObserver((mutations) => {
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
}

function initializeContentScript() {
  const triggeredAccountHandle = getTriggeredAccountViewHandle();
  if (triggeredAccountHandle) {
    void runAccountRepliesView(triggeredAccountHandle);
    console.log("[AI Detector] account replies view loaded");
    return;
  }

  if (isStatusPage()) {
    startStatusPageAnalysis();
    console.log("[AI Detector] status-page analyzer loaded");
    return;
  }

  console.log("[AI Detector] content-script loaded");
}

initializeContentScript();
