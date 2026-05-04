const SERVER_BASE_URL = "http://127.0.0.1:8000";
const CACHE_SCHEMA_VERSION = "2026-04-12-v5";
const CACHE_TTL_MS = 1000 * 60 * 30;

function isUsableCache(entry) {
  if (!entry || !entry.pred_label) return false;
  if (entry._schema_version !== CACHE_SCHEMA_VERSION) return false;
  if (!entry._cached_at) return false;

  const cachedAt = Date.parse(entry._cached_at);
  if (Number.isNaN(cachedAt)) return false;

  return Date.now() - cachedAt <= CACHE_TTL_MS;
}

async function purgeStaleResultCache() {
  const allEntries = await chrome.storage.local.get(null);
  const staleKeys = Object.entries(allEntries)
    .filter(([, value]) => value && value.pred_label && !isUsableCache(value))
    .map(([key]) => key);

  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
    console.log("[AI Detector] purged stale cache entries:", staleKeys.length);
  }
}

async function checkServerHealth() {
  try {
    const response = await fetch(`${SERVER_BASE_URL}/health`);
    if (!response.ok) {
      console.error("[AI Detector] health check failed:", response.status);
      return;
    }

    const data = await response.json();
    console.log("[AI Detector] server status:", data.status);
  } catch (error) {
    console.error("[AI Detector] server is unreachable:", error);
  }
}

function buildCacheKey(payload) {
  return (
    payload.comment_id ??
    `${payload.author_id ?? "unknown"}::${payload.timestamp ?? "no-time"}::${(payload.text ?? "").slice(0, 30)}`
  );
}

function buildStoredResult(payload, result, cacheKey) {
  return {
    ...result,
    comment_id: payload.comment_id ?? result.comment_id ?? null,
    author_id: payload.author_id ?? "",
    text: payload.text ?? "",
    url: payload.url ?? "",
    timestamp: payload.timestamp ?? null,
    root_post_id: payload.root_post_id ?? null,
    root_post_author_id: payload.root_post_author_id ?? "",
    root_post_text: payload.root_post_text ?? "",
    root_post_url: payload.root_post_url ?? "",
    root_post_timestamp: payload.root_post_timestamp ?? null,
    _cache_key: cacheKey,
    _schema_version: CACHE_SCHEMA_VERSION,
    _cached_at: new Date().toISOString(),
    _fp_exported_at: result._fp_exported_at ?? null,
    _fp_export_status: result._fp_export_status ?? null,
    _fp_export_path: result._fp_export_path ?? null,
    _fp_export_dedupe_key: result._fp_export_dedupe_key ?? null,
  };
}

async function updateStoredFeedbackState(cacheKey, feedbackResponse) {
  if (!cacheKey) return;

  const current = await chrome.storage.local.get(cacheKey);
  const currentEntry = current[cacheKey];
  if (!currentEntry || !currentEntry.pred_label) return;

  await chrome.storage.local.set({
    [cacheKey]: {
      ...currentEntry,
      _fp_exported_at: feedbackResponse.exported_at,
      _fp_export_status: feedbackResponse.status,
      _fp_export_path: feedbackResponse.file_path,
      _fp_export_dedupe_key: feedbackResponse.dedupe_key,
    },
  });
}

chrome.runtime.onInstalled.addListener(() => {
  purgeStaleResultCache();
  checkServerHealth();
});

chrome.runtime.onStartup.addListener(() => {
  purgeStaleResultCache();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "ANALYZE_REQUEST") {
    handleAnalyzeRequest(request.payload, sendResponse);
    return true;
  }

  if (request.type === "FP_EXPORT_REQUEST") {
    handleFalsePositiveExport(request.payload, sendResponse);
    return true;
  }

  return false;
});

async function handleAnalyzeRequest(payload, sendResponse) {
  const cacheKey = buildCacheKey(payload);
  const cache = await chrome.storage.local.get(cacheKey);

  if (isUsableCache(cache[cacheKey])) {
    console.log("[AI Detector] returning cached result:", cacheKey);
    sendResponse({ status: "success", data: cache[cacheKey] });
    return;
  }

  if (cache[cacheKey]) {
    await chrome.storage.local.remove(cacheKey);
  }

  try {
    const response = await fetch(`${SERVER_BASE_URL}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comment_id: payload.comment_id,
        author_id: payload.author_id,
        text: payload.text,
        url: payload.url,
        timestamp: payload.timestamp,
      }),
    });

    if (!response.ok) {
      throw new Error(`server returned ${response.status}`);
    }

    const result = await response.json();
    const enrichedResult = buildStoredResult(payload, result, cacheKey);

    await chrome.storage.local.set({ [cacheKey]: enrichedResult });
    sendResponse({ status: "success", data: enrichedResult });
  } catch (error) {
    console.error("[AI Detector] analysis failed:", error);
    sendResponse({ status: "error", message: error.message });
  }
}

async function handleFalsePositiveExport(payload, sendResponse) {
  if (!payload?.text?.trim()) {
    sendResponse({ status: "error", message: "Comment text is required." });
    return;
  }

  try {
    const response = await fetch(`${SERVER_BASE_URL}/feedback/false-positive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cache_key: payload.cache_key ?? payload._cache_key ?? null,
        comment_id: payload.comment_id ?? null,
        author_id: payload.author_id ?? "",
        text: payload.text,
        url: payload.url ?? "",
        timestamp: payload.timestamp ?? null,
        root_post_id: payload.root_post_id ?? null,
        root_post_author_id: payload.root_post_author_id ?? "",
        root_post_text: payload.root_post_text ?? "",
        root_post_url: payload.root_post_url ?? "",
        root_post_timestamp: payload.root_post_timestamp ?? null,
        pred_label: payload.pred_label,
        confidence: payload.confidence,
        ai_score: payload.ai_score,
        risk_level: payload.risk_level,
        export_source: payload.export_source ?? "extension",
      }),
    });

    if (!response.ok) {
      let detail = `server returned ${response.status}`;

      try {
        const errorBody = await response.json();
        if (errorBody?.detail) {
          detail = errorBody.detail;
        }
      } catch (parseError) {
        console.warn("[AI Detector] failed to parse FP export error response:", parseError);
      }

      throw new Error(detail);
    }

    const feedbackResponse = await response.json();
    await updateStoredFeedbackState(payload.cache_key ?? payload._cache_key ?? null, feedbackResponse);
    sendResponse({ status: "success", data: feedbackResponse });
  } catch (error) {
    console.error("[AI Detector] FP export failed:", error);
    sendResponse({ status: "error", message: error.message });
  }
}
