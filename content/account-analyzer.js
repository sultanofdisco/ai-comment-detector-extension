const ACCOUNT_PROFILE_HANDLE_REGEX = /^@[A-Za-z0-9_]{1,15}$/;
const ACCOUNT_PROFILE_HANDLE_MATCH_REGEX = /@[A-Za-z0-9_]{1,15}/g;
const DEFAULT_KOREAN_AI_THRESHOLD = 0.7;
const HIGH_RATIO_TOP_K = 5;
const DEFAULT_RECENT_COMMENT_SAMPLE_LIMIT = 10;
const DEFAULT_CURRENT_PAGE_TARGET_COMMENT_COUNT = 8;
const DEFAULT_CURRENT_PAGE_SCAN_TIMEOUT_MS = 15000;
const DEFAULT_CURRENT_PAGE_SCROLL_PAUSE_MS = 700;
const DEFAULT_CURRENT_PAGE_SCROLL_STEPS = 4;
const DEFAULT_REPLY_SCAN_TIMEOUT_MS = 45000;
const DEFAULT_REPLY_SCAN_INTERVAL_MS = 700;
const DEFAULT_REPLY_SCROLL_PAUSE_MS = 1400;
const DEFAULT_REPLY_SCROLL_STEPS = 8;
const HIDDEN_IFRAME_ID = "ai-detector-account-replies-frame";

const REPLYING_TO_LABEL_REGEX =
  /(replying to|in reply to|답글|답장|회신|回复|回覆|en réponse à|respondiendo a|rispondendo a|antwort an)/i;

const ISO639_3_TO_SHORT = {
  ara: "ar",
  arb: "ar",
  ben: "bn",
  bul: "bg",
  cat: "ca",
  ces: "cs",
  cmn: "zh",
  cym: "cy",
  dan: "da",
  deu: "de",
  ell: "el",
  eng: "en",
  est: "et",
  fin: "fi",
  fra: "fr",
  guj: "gu",
  heb: "he",
  hin: "hi",
  hrv: "hr",
  hun: "hu",
  ind: "id",
  ita: "it",
  jpn: "ja",
  kan: "kn",
  kor: "ko",
  lit: "lt",
  lvs: "lv",
  mar: "mr",
  nld: "nl",
  nob: "no",
  pes: "fa",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rus: "ru",
  slk: "sk",
  slv: "sl",
  spa: "es",
  srp: "sr",
  swe: "sv",
  tam: "ta",
  tel: "te",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  urd: "ur",
  vie: "vi",
  zho: "zh",
};

let francModulePromise;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeAccountProfileText(value) {
  return String(value ?? "")
    .replaceAll("\u00A0", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectUniqueReplyHandles(text, seenHandles, output, excludedHandles = new Set()) {
  const matches = String(text ?? "").match(ACCOUNT_PROFILE_HANDLE_MATCH_REGEX) ?? [];
  for (const handle of matches) {
    if (excludedHandles.has(handle)) continue;
    if (seenHandles.has(handle)) continue;
    seenHandles.add(handle);
    output.push(handle);
  }
}

function extractAccountHandle(article) {
  const authorEl = article?.querySelector?.('[data-testid="User-Name"]');
  const handleSpan = authorEl
    ? [...authorEl.querySelectorAll("span")].find((span) =>
        ACCOUNT_PROFILE_HANDLE_REGEX.test(span.innerText?.trim() ?? "")
      )
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

function extractAccountCommentId(article) {
  const statusLink = extractAccountStatusLink(article);
  const match = statusLink?.href?.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function extractAccountStatusLink(article) {
  return (
    article?.querySelector?.("time")?.closest?.('a[href*="/status/"]') ??
    article?.querySelector?.('a[href*="/status/"]') ??
    null
  );
}

function extractAccountCommentUrl(article) {
  return extractAccountStatusLink(article)?.href ?? "";
}

function extractAccountCommentText(article) {
  const text = article?.querySelector?.('[data-testid="tweetText"]')?.innerText;
  return normalizeAccountProfileText(text);
}

function extractVisiblePrefixBeforeBody(article, bodyText) {
  const articleText = normalizeAccountProfileText(article?.innerText);
  const normalizedBody = normalizeAccountProfileText(bodyText);
  if (!articleText || !normalizedBody) {
    return "";
  }

  const bodyIndex = articleText.indexOf(normalizedBody);
  if (bodyIndex <= 0) {
    return "";
  }

  return articleText.slice(0, bodyIndex).trim();
}

function extractReplyMentionsText(article, handle, bodyText) {
  const normalizedBody = normalizeAccountProfileText(bodyText);
  if (!article || !normalizedBody) {
    return "";
  }

  const mentions = [];
  const seenHandles = new Set();
  const bodyHandles = new Set(String(normalizedBody).match(ACCOUNT_PROFILE_HANDLE_MATCH_REGEX) ?? []);
  const excludedHandles = new Set(handle ? [handle, ...bodyHandles] : [...bodyHandles]);
  const visiblePrefix = extractVisiblePrefixBeforeBody(article, normalizedBody);

  if (visiblePrefix) {
    collectUniqueReplyHandles(visiblePrefix, seenHandles, mentions, excludedHandles);
  }

  if (mentions.length > 0) {
    return mentions.join(" ");
  }

  const textEl = article.querySelector?.('[data-testid="tweetText"]');
  if (!textEl) {
    return "";
  }

  const candidateAnchors = [...article.querySelectorAll?.('a[href^="/"]') ?? []].filter((anchor) => {
    const text = anchor.innerText?.trim();
    if (!text || !ACCOUNT_PROFILE_HANDLE_REGEX.test(text)) {
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
    collectUniqueReplyHandles(anchor.innerText, seenHandles, mentions, excludedHandles);
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
    collectUniqueReplyHandles(container.innerText, seenHandles, mentions, excludedHandles);
  }

  return mentions.join(" ");
}

function clampProbability(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(1, numeric));
}

function roundMetric(value, digits = 4) {
  return Number(clampProbability(value).toFixed(digits));
}

function mapLanguageCode(code) {
  const normalized = String(code ?? "und").trim().toLowerCase();
  if (!normalized) {
    return "und";
  }

  return ISO639_3_TO_SHORT[normalized] ?? normalized;
}

function looksKorean(text) {
  return /[\uac00-\ud7a3\u3131-\u314e\u314f-\u3163]/.test(text);
}

async function loadFrancModule() {
  if (!francModulePromise) {
    const moduleUrl = chrome.runtime.getURL("content/vendor/franc-min/index.js");
    francModulePromise = import(moduleUrl);
  }

  return francModulePromise;
}

async function detectCommentLanguage(text) {
  const normalizedText = normalizeAccountProfileText(text);
  if (!normalizedText) {
    return "und";
  }

  const compactText = normalizedText.replace(/\s+/g, "");
  if (compactText.length < 3 && looksKorean(compactText)) {
    return "ko";
  }

  const { franc } = await loadFrancModule();
  const rawCode = franc(normalizedText, { minLength: 3 });
  const mappedCode = mapLanguageCode(rawCode);

  if ((mappedCode === "und" || mappedCode === "cmn") && looksKorean(normalizedText)) {
    return "ko";
  }

  return mappedCode;
}

function buildRepliesUrl(handle) {
  const normalizedHandle = String(handle ?? "").trim().replace(/^@/, "");
  return new URL(`/${normalizedHandle}/with_replies`, window.location.origin).toString();
}

function collectAccountTimelineEntriesFromDocument(sourceDocument, handle) {
  if (!sourceDocument || !ACCOUNT_PROFILE_HANDLE_REGEX.test(String(handle ?? "").trim())) {
    return [];
  }

  const seenCommentKeys = new Set();
  const comments = [];

  sourceDocument.querySelectorAll("article").forEach((article) => {
    if (extractAccountHandle(article) !== handle) {
      return;
    }

    const text = extractAccountCommentText(article);
    if (!text) {
      return;
    }

    const commentId = extractAccountCommentId(article);
    const replyMentionsText = extractReplyMentionsText(article, handle, text);
    const articleText = normalizeAccountProfileText(article.innerText);
    const isReplyLikely = Boolean(replyMentionsText) || REPLYING_TO_LABEL_REGEX.test(articleText);

    if (!isReplyLikely && !commentId) {
      return;
    }

    const dedupeKey = commentId ?? `${handle}::${text}`;
    if (seenCommentKeys.has(dedupeKey)) {
      return;
    }

    seenCommentKeys.add(dedupeKey);
    comments.push({
      commentId,
      text,
      url: extractAccountCommentUrl(article),
      replyMentionsText: replyMentionsText ?? "",
      isReplyLikely,
    });
  });

  return comments;
}

function collectAccountCommentsFromDocument(sourceDocument, handle) {
  const entries = collectAccountTimelineEntriesFromDocument(sourceDocument, handle);
  const strictReplies = entries.filter((entry) => entry.replyMentionsText);
  if (strictReplies.length > 0) {
    return strictReplies;
  }

  return entries.filter((entry) => entry.isReplyLikely || entry.commentId);
}

function getFrameDocument(iframe) {
  try {
    return iframe?.contentDocument ?? iframe?.contentWindow?.document ?? null;
  } catch (error) {
    return null;
  }
}

async function waitForRepliesPageToRender(iframe, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const frameDocument = getFrameDocument(iframe);
    if (frameDocument?.querySelectorAll("article").length) {
      return frameDocument;
    }

    await sleep(DEFAULT_REPLY_SCAN_INTERVAL_MS);
  }

  throw new Error("Timed out while waiting for the account replies page to render.");
}

async function waitForCommentsToRender(sourceDocument, handle, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const timelineEntries = collectAccountTimelineEntriesFromDocument(sourceDocument, handle);
    if (timelineEntries.length > 0) {
      return timelineEntries;
    }

    await sleep(DEFAULT_REPLY_SCAN_INTERVAL_MS);
  }

  throw new Error("Timed out while waiting for account replies to render.");
}

function createHiddenRepliesFrame(url) {
  document.getElementById(HIDDEN_IFRAME_ID)?.remove();

  const iframe = document.createElement("iframe");
  iframe.id = HIDDEN_IFRAME_ID;
  iframe.src = url;
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText = [
    "position: fixed",
    "left: -200vw",
    "top: 0",
    "width: 1280px",
    "height: 900px",
    "opacity: 0",
    "pointer-events: none",
    "border: 0",
    "z-index: -1",
    "background: #000",
  ].join("; ");
  document.body.appendChild(iframe);
  return iframe;
}

async function collectAccountComments(handle, options = {}) {
  const normalizedHandle = String(handle ?? "").trim();
  if (!ACCOUNT_PROFILE_HANDLE_REGEX.test(normalizedHandle)) {
    return [];
  }

  const replyScanTimeoutMs = options.replyScanTimeoutMs ?? DEFAULT_REPLY_SCAN_TIMEOUT_MS;
  const replyScrollSteps = options.replyScrollSteps ?? DEFAULT_REPLY_SCROLL_STEPS;
  const replyScrollPauseMs = options.replyScrollPauseMs ?? DEFAULT_REPLY_SCROLL_PAUSE_MS;
  const iframe = createHiddenRepliesFrame(buildRepliesUrl(normalizedHandle));

  try {
    const frameDocument = await waitForRepliesPageToRender(iframe, replyScanTimeoutMs);
    const collected = new Map();
    let previousCount = -1;
    let stableRounds = 0;

    for (let step = 0; step < replyScrollSteps; step += 1) {
      const currentComments = collectAccountCommentsFromDocument(frameDocument, normalizedHandle);
      for (const comment of currentComments) {
        const dedupeKey = comment.commentId ?? `${normalizedHandle}::${comment.text}`;
        collected.set(dedupeKey, comment);
      }

      if (collected.size === previousCount) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }

      previousCount = collected.size;

      if (stableRounds >= 2) {
        break;
      }

      const scrollingElement =
        frameDocument.scrollingElement ?? frameDocument.documentElement ?? null;
      const scrollHeight = scrollingElement?.scrollHeight ?? 0;

      iframe.contentWindow?.scrollTo(0, scrollHeight);
      scrollingElement?.scrollTo(0, scrollHeight);
      await sleep(replyScrollPauseMs);
    }

    return [...collected.values()];
  } finally {
    iframe.remove();
  }
}

async function collectAccountCommentsFromCurrentPage(handle, options = {}) {
  const normalizedHandle = String(handle ?? "").trim();
  if (!ACCOUNT_PROFILE_HANDLE_REGEX.test(normalizedHandle)) {
    return [];
  }

  const sourceDocument = options.sourceDocument ?? document;
  const scrollWindow = options.scrollWindow ?? window;
  const replyScanTimeoutMs = options.replyScanTimeoutMs ?? DEFAULT_CURRENT_PAGE_SCAN_TIMEOUT_MS;
  const replyScrollSteps = options.replyScrollSteps ?? DEFAULT_CURRENT_PAGE_SCROLL_STEPS;
  const replyScrollPauseMs = options.replyScrollPauseMs ?? DEFAULT_CURRENT_PAGE_SCROLL_PAUSE_MS;
  const targetCommentCount = Math.max(
    1,
    Math.floor(
      Number(options.targetCommentCount ?? DEFAULT_CURRENT_PAGE_TARGET_COMMENT_COUNT)
    )
  );
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  await waitForCommentsToRender(sourceDocument, normalizedHandle, replyScanTimeoutMs);

  const collected = new Map();
  let previousCount = -1;
  let stableRounds = 0;

  for (let step = 0; step < replyScrollSteps; step += 1) {
    const currentComments = collectAccountCommentsFromDocument(sourceDocument, normalizedHandle);
    for (const comment of currentComments) {
      const dedupeKey = comment.commentId ?? `${normalizedHandle}::${comment.text}`;
      collected.set(dedupeKey, comment);
    }

    onProgress?.({
      stage: "collect",
      collectedCount: collected.size,
      step: step + 1,
      totalSteps: replyScrollSteps,
    });

    if (collected.size >= targetCommentCount) {
      break;
    }

    if (collected.size === previousCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    previousCount = collected.size;

    if (stableRounds >= 2) {
      break;
    }

    const scrollingElement =
      sourceDocument.scrollingElement ?? sourceDocument.documentElement ?? null;
    const scrollHeight = scrollingElement?.scrollHeight ?? 0;

    scrollWindow?.scrollTo?.(0, scrollHeight);
    scrollingElement?.scrollTo?.(0, scrollHeight);
    await sleep(replyScrollPauseMs);
  }

  return [...collected.values()];
}

function incrementDistribution(distribution, languageCode) {
  distribution[languageCode] = (distribution[languageCode] ?? 0) + 1;
}

function determineAccountVerdict(mean, highRatioAboveThreshold, uniqueLanguageCount) {
  if (mean > 0.7 || highRatioAboveThreshold > 0.5) {
    return "suspicious";
  }

  if (mean > 0.5 || uniqueLanguageCount >= 4) {
    return "borderline";
  }

  return "likely_human";
}

function buildRecentCommentSample(comment, languageCode, aiScore, threshold) {
  return {
    commentId: comment.commentId ?? null,
    url: comment.url ?? "",
    text: comment.text,
    languageCode,
    aiScore: aiScore == null ? null : roundMetric(aiScore),
    exceedsThreshold: aiScore == null ? false : aiScore > threshold,
  };
}

async function analyzeCollectedComments(handle, comments, options = {}) {
  const normalizedHandle = String(handle ?? "").trim();
  const detectAI = options.detectAI;
  const threshold = clampProbability(
    options.threshold ?? DEFAULT_KOREAN_AI_THRESHOLD
  );
  const recentCommentSampleLimit = Math.max(
    1,
    Math.floor(Number(options.recentCommentSampleLimit ?? DEFAULT_RECENT_COMMENT_SAMPLE_LIMIT))
  );
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  if (!ACCOUNT_PROFILE_HANDLE_REGEX.test(normalizedHandle)) {
    throw new Error("A valid X handle is required for account analysis.");
  }

  if (typeof detectAI !== "function") {
    throw new Error("AccountAnalyzer.analyzeAccount requires a detectAI function.");
  }

  const languageDistribution = {};
  const annotatedComments = [];
  const koreanComments = [];

  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const languageCode = await detectCommentLanguage(comment.text);
    incrementDistribution(languageDistribution, languageCode);
    const annotatedComment = {
      source: comment,
      languageCode,
      aiScore: null,
    };
    annotatedComments.push(annotatedComment);

    onProgress?.({
      stage: "language",
      processedCount: index + 1,
      totalCount: comments.length,
    });

    if (languageCode === "ko") {
      koreanComments.push(annotatedComment);
    }
  }

  const koreanScores = [];
  const scoreCache = new Map();

  for (let index = 0; index < koreanComments.length; index += 1) {
    const annotatedComment = koreanComments[index];
    const scoreKey = annotatedComment.source.text;
    let scorePromise = scoreCache.get(scoreKey);

    if (!scorePromise) {
      scorePromise = Promise.resolve(detectAI(annotatedComment.source.text));
      scoreCache.set(scoreKey, scorePromise);
    }

    try {
      const score = clampProbability(await scorePromise);
      annotatedComment.aiScore = score;
      koreanScores.push(score);
    } catch (error) {
      console.warn("[AI Detector] account-level detectAI failed:", error);
    }

    onProgress?.({
      stage: "score",
      processedCount: index + 1,
      totalCount: koreanComments.length,
    });
  }

  const scoreTotal = koreanScores.reduce((sum, score) => sum + score, 0);
  const mean = koreanScores.length > 0 ? scoreTotal / koreanScores.length : 0;
  const max = koreanScores.length > 0 ? Math.max(...koreanScores) : 0;
  const highRatioSampleScores = annotatedComments
    .filter((comment) => comment.languageCode === "ko" && comment.aiScore != null)
    .slice(0, HIGH_RATIO_TOP_K)
    .map((comment) => comment.aiScore);
  const highCount = highRatioSampleScores.filter((score) => score > threshold).length;
  const highRatioAboveThreshold =
    highRatioSampleScores.length > 0 ? highCount / highRatioSampleScores.length : 0;
  const uniqueLanguageCount = Object.keys(languageDistribution).filter(
    (languageCode) => languageCode !== "und"
  ).length;
  const recentComments = annotatedComments
    .slice(0, recentCommentSampleLimit)
    .map((comment) =>
      buildRecentCommentSample(
        comment.source,
        comment.languageCode,
        comment.aiScore,
        threshold
      )
    );

  return {
    handle: normalizedHandle,
    totalComments: comments.length,
    languageDistribution,
    uniqueLanguageCount,
    koreanCommentCount: koreanComments.length,
    aiSuspicion: {
      mean: roundMetric(mean),
      max: roundMetric(max),
      highRatioAboveThreshold: roundMetric(highRatioAboveThreshold),
    },
    recentComments,
    verdict: determineAccountVerdict(
      mean,
      highRatioAboveThreshold,
      uniqueLanguageCount
    ),
  };
}

async function analyzeAccount(handle, options = {}) {
  const comments = await collectAccountComments(handle, options);
  return analyzeCollectedComments(handle, comments, options);
}

async function analyzeCurrentRepliesPage(handle, options = {}) {
  const comments = await collectAccountCommentsFromCurrentPage(handle, options);
  return analyzeCollectedComments(handle, comments, options);
}

globalThis.AccountAnalyzer = Object.freeze({
  DEFAULT_KOREAN_AI_THRESHOLD,
  analyzeAccount,
  analyzeCollectedComments,
  analyzeCurrentRepliesPage,
  collectAccountComments,
  collectAccountCommentsFromCurrentPage,
  collectAccountCommentsFromDocument,
  buildRepliesUrl,
  detectCommentLanguage,
});
