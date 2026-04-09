/**
 * 개발자 A 담당: 데이터 시각화 및 UI 제어
 * 역할: Storage를 감시하여 분석 결과를 사이드 패널에 실시간으로 반영
 */

// ── 헬퍼 함수 (API 명세서 및 체크리스트 기준) ──

const labelMap = {
  human: "Human",
  uncertain: "판별 보류",
  ai: "AI 의심",
  gpt: "GPT 추정",
  claude: "Claude 추정",
  gemini: "Gemini 추정",
  deepseek: "DeepSeek 추정",
};

function pct(val) {
  return (val * 100).toFixed(1) + "%";
}

function riskColor(level) {
  return { low: "#6b7280", medium: "#d97706", high: "#dc2626" }[level] ?? "#6b7280";
}

// ── 카드 생성 로직 ──

function createCard(result) {
  // API 명세서 응답 필드 추출 [cite: 75, 390]
  const { pred_label, confidence, ai_score, risk_level, top2, author_id } = result;

  const card = document.createElement("div");
  card.className = "card";

  const color = riskColor(risk_level);

  card.innerHTML = `
    <div class="card-top">
      <div class="pred-label">${labelMap[pred_label] ?? pred_label}</div>
      <div class="risk-badge risk-badge--${risk_level}">${risk_level}</div>
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
        <div class="bar-fill" style="width:${pct(ai_score)};background:${color};"></div>
      </div>
    </div>

    <hr class="divider" />

    <div class="top2-section">
      <div class="top2-title">Top 2 후보</div>
      ${(top2 || []).map((item, i) => `
        <div class="top2-item">
          <span class="top2-name">${labelMap[item[0]] ?? item[0]}</span>
          <div class="top2-bar-bg">
            <div class="top2-bar-fill ${i === 0 ? 'top2-bar-fill--first' : ''}"
                 style="width:${pct(item[1])};"></div>
          </div>
          <span class="top2-pct">${pct(item[1])}</span>
        </div>
      `).join("")}
    </div>

    ${author_id ? `
      <div class="author-row">
        <span class="author-handle">${author_id}</span>
      </div>
    ` : ""}
  `;

  return card;
}

// ── 데이터 로드 및 렌더링 ──

async function updateUI() {
  const listElement = document.getElementById("resultList");
  const emptyElement = document.getElementById("emptyState");

  // Storage에서 모든 데이터 가져오기
  const allData = await chrome.storage.local.get(null);
  
  // comment_id가 포함된 분석 결과객체들만 필터링 (Object -> Array)
  const results = Object.values(allData).filter(item => item && item.pred_label);

  // 체크리스트 기준: human(정상)은 제외하고 표시 [cite: 112, 113]
  const filtered = results.filter(r => r.pred_label !== "human");

  if (filtered.length === 0) {
    emptyElement.style.display = "flex";
    listElement.innerHTML = "";
    return;
  }

  emptyElement.style.display = "none";
  listElement.innerHTML = "";
  
  // 최신 결과가 위로 오도록 정렬 (선택 사항)
  filtered.reverse().forEach(r => listElement.appendChild(createCard(r)));
}

// ── 초기화 및 이벤트 리스너 ──

// 페이지 로드 시 최초 실행
document.addEventListener("DOMContentLoaded", updateUI);

// Storage 변경 감지 (background.js가 새 결과를 저장할 때마다 실행)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    updateUI();
  }
});
