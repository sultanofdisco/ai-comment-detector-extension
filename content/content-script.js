// ================================================================
// content-script.js — 개발자 B 담당
// X(트위터) 댓글 추출 → background(A)로 전송 → 배지 렌더링
// ================================================================

// ---------------------------------------------------------------
// 0. 상수
// ---------------------------------------------------------------
const ANALYZED_ATTR = "data-ai-analyzed";   // 중복 방지용 마킹
const BADGE_CLASS    = "ai-detector-badge";
const STATUS_PATH_REGEX = /\/status\/(\d+)/;

function getCurrentStatusId() {
  const match = window.location.pathname.match(STATUS_PATH_REGEX);
  return match ? match[1] : null;
}

function isStatusPage() {
  return Boolean(getCurrentStatusId());
}

// ---------------------------------------------------------------
// 1. 트위터 DOM에서 댓글 데이터 추출
// ---------------------------------------------------------------

/**
 * article 요소 하나로부터 댓글 객체를 뽑아낸다.
 * @param {Element} article
 * @returns {{ comment_id, author_id, text, url, timestamp } | null}
 */
function extractCommentData(article) {
  // 1-1. 댓글 텍스트
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = textEl?.innerText?.trim();
  if (!text) return null;   // 텍스트 없으면 스킵

  // 1-2. 작성자 핸들 (@username)
  //   User-Name 안에 display name + @handle 둘 다 들어있으므로
  //   @로 시작하는 span만 추려서 handle을 뽑는다
  const authorEl = article.querySelector('[data-testid="User-Name"]');
  const handleSpan = authorEl
    ? [...authorEl.querySelectorAll("span")].find(s => s.innerText.startsWith("@"))
    : null;
  const author_id = handleSpan?.innerText?.trim() ?? "";

  // 1-3. 댓글 고유 ID — 트윗 URL에 포함된 숫자 ID
  //   <a href="/username/status/1234567890"> 형식의 링크에서 추출
  const statusLink = article.querySelector('a[href*="/status/"]');
  const statusMatch = statusLink?.href?.match(/\/status\/(\d+)/);
  const comment_id = statusMatch ? statusMatch[1] : null;

  // 1-4. 현재 페이지 URL
  const url = window.location.href;

  // 1-5. 타임스탬프 — <time> 태그의 datetime 속성
  const timeEl = article.querySelector("time");
  const timestamp = timeEl?.getAttribute("datetime") ?? new Date().toISOString();

  return { comment_id, author_id, text, url, timestamp };
}

// ---------------------------------------------------------------
// 2. A(background)로 분석 요청 전송 + 응답으로 배지 렌더링
// ---------------------------------------------------------------

/**
 * 댓글 데이터를 background로 보내고 결과를 받으면 배지를 붙인다.
 * @param {Element} article
 * @param {object} commentData
 */
function requestAnalysis(article, commentData) {
  // 중복 요청 방지 마킹
  article.setAttribute(ANALYZED_ATTR, "pending");

  chrome.runtime.sendMessage(
    { type: "ANALYZE_REQUEST", payload: commentData },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[AI Detector] sendMessage 실패:", chrome.runtime.lastError.message);
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

// ---------------------------------------------------------------
// 3. 배지 렌더링
// ---------------------------------------------------------------

/**
 * 분석 결과에 따라 댓글 article 안에 배지를 삽입한다.
 * @param {Element} article
 * @param {{ pred_label, confidence, ai_score, risk_level }} result
 */
function renderBadge(article, result) {
  // 이미 배지 있으면 제거 후 재생성
  article.querySelector(`.${BADGE_CLASS}`)?.remove();

  const { pred_label, ai_score, risk_level } = result;

  // human이면 배지 없음
  if (pred_label === "human") return;

  // 라벨 텍스트
  const labelMap = {
    uncertain: "판별 보류",
    ai:       "AI 의심",
    gpt:      "AI 의심 / GPT 추정",
    claude:   "AI 의심 / Claude 추정",
    gemini:   "AI 의심 / Gemini 추정",
    deepseek: "AI 의심 / DeepSeek 추정",
  };
  const labelText = labelMap[pred_label] ?? "AI 의심";

  // 메인 배지는 최종 confidence가 아니라 1차 ai_score를 보여준다.
  const pct = (ai_score * 100).toFixed(1);

  // risk_level → 색상
  const colorMap = {
    low:    "#6b7280",   // 회색
    medium: "#d97706",   // 노랑
    high:   "#dc2626",   // 빨강
  };
  const color = colorMap[risk_level] ?? "#6b7280";

  // 배지 엘리먼트 생성
  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.title = `ai_score: ${(result.ai_score * 100).toFixed(1)}% / confidence: ${(result.confidence * 100).toFixed(1)}%`;
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
    background-color: ${color};
    vertical-align: middle;
    cursor: default;
    user-select: none;
  `;
  badge.textContent = `${labelText} ${pct}%`;

  // 작성자 이름 줄 옆에 붙이기
  //   User-Name 컨테이너 찾아서 그 안 마지막에 삽입
  const authorEl = article.querySelector('[data-testid="User-Name"]');
  if (authorEl) {
    authorEl.appendChild(badge);
  } else {
    // fallback: article 상단에 삽입
    article.prepend(badge);
  }
}

// ---------------------------------------------------------------
// 4. 새 댓글 감지 → 처리 파이프라인
// ---------------------------------------------------------------

/**
 * article 하나를 받아서 아직 분석 안 했으면 전체 파이프라인 실행
 * @param {Element} article
 */
function processArticle(article) {
  // 이미 분석했거나 진행 중이면 스킵
  if (article.hasAttribute(ANALYZED_ATTR)) return;
  if (!isStatusPage()) return;

  const data = extractCommentData(article);
  if (!data) return;
  const rootStatusId = getCurrentStatusId();

  // 메인 게시글은 댓글 분석 대상에서 제외한다.
  if (!data.comment_id || data.comment_id === rootStatusId) {
    article.setAttribute(ANALYZED_ATTR, "skipped");
    return;
  }

  requestAnalysis(article, data);
}

/**
 * 현재 DOM에 있는 모든 article을 순회
 */
function scanAllArticles() {
  document.querySelectorAll("article").forEach(processArticle);
}

// ---------------------------------------------------------------
// 5. MutationObserver — 무한 스크롤 대응
//    트위터는 React 기반이라 DOM이 동적으로 바뀜
// ---------------------------------------------------------------
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;

      // 추가된 노드 자체가 article인 경우
      if (node.tagName === "ARTICLE") {
        processArticle(node);
      }

      // 추가된 노드 안에 article이 있는 경우
      node.querySelectorAll?.("article").forEach(processArticle);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// ---------------------------------------------------------------
// 6. 초기 실행 — 페이지 로드 시 이미 있는 댓글 처리
// ---------------------------------------------------------------
scanAllArticles();

console.log("[AI Detector] content-script 로드 완료");
