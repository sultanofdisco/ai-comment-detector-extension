const SERVER_BASE_URL = "http://127.0.0.1:8000";
const CACHE_SCHEMA_VERSION = "2026-05-12-v10";
const CACHE_TTL_MS = 1000 * 60 * 30;
const REQUEST_TIMEOUT_MS = 1000 * 20;
const PREDICT_REQUEST_TIMEOUT_MS = 1000 * 60;
const MAX_CONCURRENT_PREDICT_REQUESTS = 2;

let activePredictRequestCount = 0;
const predictRequestQueue = [];

function toErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallbackMessage;
}

function respondSafely(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (error) {
    console.warn("[AI Detector] failed to send runtime response:", error);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function drainPredictRequestQueue() {
  while (
    activePredictRequestCount < MAX_CONCURRENT_PREDICT_REQUESTS &&
    predictRequestQueue.length > 0
  ) {
    const queuedTask = predictRequestQueue.shift();
    if (!queuedTask) {
      return;
    }

    activePredictRequestCount += 1;

    void Promise.resolve()
      .then(() => queuedTask.task())
      .then(queuedTask.resolve, queuedTask.reject)
      .finally(() => {
        activePredictRequestCount = Math.max(0, activePredictRequestCount - 1);
        drainPredictRequestQueue();
      });
  }
}

function enqueuePredictRequest(task) {
  return new Promise((resolve, reject) => {
    predictRequestQueue.push({ task, resolve, reject });
    drainPredictRequestQueue();
  });
}

async function parseJsonBody(response, fallbackMessage) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(fallbackMessage);
  }
}

async function parseErrorDetail(response, fallbackMessage) {
  try {
    const errorBody = await response.json();
    if (errorBody?.detail) {
      return String(errorBody.detail);
    }
  } catch (parseError) {
    console.warn("[AI Detector] failed to parse error response:", parseError);
  }

  return fallbackMessage;
}

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
    const response = await fetchWithTimeout(`${SERVER_BASE_URL}/health`, {}, 5000);
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
    stage1_text: payload.text_with_reply_mentions ?? payload.text ?? "",
    reply_mentions_text: payload.reply_mentions_text ?? "",
    text_with_reply_mentions: payload.text_with_reply_mentions ?? payload.text ?? "",
    url: payload.url ?? "",
    timestamp: payload.timestamp ?? null,
    root_post_id: payload.root_post_id ?? null,
    root_post_author_id: payload.root_post_author_id ?? "",
    root_post_text: payload.root_post_text ?? "",
    root_post_reply_mentions_text: payload.root_post_reply_mentions_text ?? "",
    root_post_text_with_reply_mentions:
      payload.root_post_text_with_reply_mentions ?? payload.root_post_text ?? "",
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

async function requestPrediction(payload) {
  return enqueuePredictRequest(async () => {
    const response = await fetchWithTimeout(
      `${SERVER_BASE_URL}/predict`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment_id: payload.comment_id ?? null,
          author_id: payload.author_id ?? "",
          text: payload.text,
          stage1_text:
            payload.text_with_reply_mentions ?? payload.stage1_text ?? payload.text,
          post_text: payload.root_post_text ?? payload.post_text ?? "",
          url: payload.url ?? "",
          timestamp: payload.timestamp ?? null,
        }),
      },
      PREDICT_REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const detail = await parseErrorDetail(response, `server returned ${response.status}`);
      throw new Error(detail);
    }

    return parseJsonBody(response, "Failed to parse /predict response.");
  });
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
  purgeStaleResultCache().catch((error) => {
    console.error("[AI Detector] failed to purge stale cache on install:", error);
  });
  checkServerHealth().catch((error) => {
    console.error("[AI Detector] failed to check server health on install:", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  purgeStaleResultCache().catch((error) => {
    console.error("[AI Detector] failed to purge stale cache on startup:", error);
  });
});

function completeAsyncMessage(sendResponse, handlerPromise, fallbackMessage) {
  void handlerPromise
    .then((data) => {
      respondSafely(sendResponse, { status: "success", data });
    })
    .catch((error) => {
      console.error("[AI Detector] async message handling failed:", error);
      respondSafely(sendResponse, {
        status: "error",
        message: toErrorMessage(error, fallbackMessage),
      });
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "ANALYZE_REQUEST") {
    completeAsyncMessage(
      sendResponse,
      handleAnalyzeRequest(request.payload),
      "Unhandled analyze error."
    );
    return true;
  }

  if (request.type === "DETECT_AI_SCORE_REQUEST") {
    completeAsyncMessage(
      sendResponse,
      handleDetectAiScoreRequest(request.payload),
      "Unhandled text-only detect error."
    );
    return true;
  }

  if (request.type === "FP_EXPORT_REQUEST") {
    completeAsyncMessage(
      sendResponse,
      handleFalsePositiveExport(request.payload),
      "Unhandled FP export error."
    );
    return true;
  }

  return false;
});

async function handleAnalyzeRequest(payload) {
  const cacheKey = buildCacheKey(payload);
  const cache = await chrome.storage.local.get(cacheKey);

  if (isUsableCache(cache[cacheKey])) {
    console.log("[AI Detector] returning cached result:", cacheKey);
    return cache[cacheKey];
  }

  if (cache[cacheKey]) {
    await chrome.storage.local.remove(cacheKey);
  }

  const result = await requestPrediction(payload);
  const enrichedResult = buildStoredResult(payload, result, cacheKey);

  await chrome.storage.local.set({ [cacheKey]: enrichedResult });
  return enrichedResult;
}

async function handleDetectAiScoreRequest(payload) {
  const text = String(payload?.text ?? "").trim();
  if (!text) {
    throw new Error("Comment text is required.");
  }

  const result = await requestPrediction({
    text,
    author_id: payload?.author_id ?? "__account_profile__",
    stage1_text: payload?.stage1_text ?? text,
    post_text: payload?.post_text ?? "",
    url: payload?.url ?? "",
    timestamp: payload?.timestamp ?? null,
  });

  return {
    aiScore: result.ai_score,
    confidence: result.confidence,
    predLabel: result.pred_label,
    riskLevel: result.risk_level,
  };
}

async function handleFalsePositiveExport(payload) {
  if (!payload?.text?.trim()) {
    throw new Error("Comment text is required.");
  }

  const response = await fetchWithTimeout(`${SERVER_BASE_URL}/feedback/false-positive`, {
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
    const detail = await parseErrorDetail(response, `server returned ${response.status}`);
    throw new Error(detail);
  }

  const feedbackResponse = await parseJsonBody(
    response,
    "Failed to parse false-positive export response."
  );
  await updateStoredFeedbackState(payload.cache_key ?? payload._cache_key ?? null, feedbackResponse);
  return feedbackResponse;
}
