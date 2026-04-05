/**
 * 개발자 A 담당: 데이터 흐름 및 서버 통신 관리
 * 주요 기능: /health 체크, /predict 호출, 중복 방지 캐싱, 결과 저장
 */

const SERVER_BASE_URL = "http://127.0.0.1:8000"; // API 명세서 기준 로컬 주소 [cite: 13, 246]

// 1. 서버 상태 체크 (/health) [cite: 44, 201]
async function checkServerHealth() {
    try {
        const response = await fetch(`${SERVER_BASE_URL}/health`);
        if (response.ok) {
            const data = await response.json();
            console.log("서버 상태 정상:", data.status); // [cite: 311]
        } else {
            console.error("서버 연결 실패 (Status):", response.status);
        }
    } catch (error) {
        console.error("네트워크 오류: 서버가 실행 중인지 확인하세요. [cite: 159]");
    }
}

// 확장 프로그램 시작 시 1회 실행 [cite: 55]
chrome.runtime.onInstalled.addListener(() => {
    checkServerHealth();
});

// 2. 메시지 리스너 (Content Script로부터 데이터 수신)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "ANALYZE_REQUEST") {
        handleAnalyzeRequest(request.payload, sendResponse);
        return true; // 비동기 응답을 위해 true 반환
    }
});

// 3. 분석 요청 처리 함수
async function handleAnalyzeRequest(payload, sendResponse) {
    const { comment_id, text } = payload;

    // 중복 요청 방지: 이미 분석된 데이터인지 storage 확인 [cite: 61, 135]
    const cache = await chrome.storage.local.get(comment_id);
    if (cache[comment_id]) {
        console.log("캐시된 결과 반환:", comment_id);
        sendResponse({ status: "success", data: cache[comment_id] });
        return;
    }

    try {
        // 서버 API 호출 (/predict) [cite: 57, 299]
        const response = await fetch(`${SERVER_BASE_URL}/predict`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json" // [cite: 15, 249]
            },
            body: JSON.stringify({
                comment_id: payload.comment_id, // [cite: 180]
                author_id: payload.author_id,   // [cite: 181]
                text: payload.text,             // [cite: 182]
                url: payload.url,               // [cite: 183]
                timestamp: payload.timestamp     // [cite: 184]
            })
        });

        if (!response.ok) {
            throw new Error(`서버 응답 오류: ${response.status} [cite: 190]`);
        }

        const result = await response.json();

        // 분석 결과 저장 (storage.local) [cite: 136, 205]
        // 결과 필드: pred_label, confidence, ai_score, risk_level 등 [cite: 78, 79, 80, 85]
        await chrome.storage.local.set({ [comment_id]: result });

        sendResponse({ status: "success", data: result });

    } catch (error) {
        console.error("분석 실패:", error);
        sendResponse({ status: "error", message: error.message }); // [cite: 155]
    }
}