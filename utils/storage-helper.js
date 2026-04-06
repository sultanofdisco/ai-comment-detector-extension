/**
 * 개발자 A 담당: Storage 관리 도구
 * 역할: chrome.storage.local의 비동기 처리를 단순화하고 데이터 무결성을 보장함
 */

const storageHelper = {
  // 1. 데이터 저장 (JSON 객체 형태)
  async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return true;
    } catch (e) {
      console.error(`Storage Set Error [${key}]:`, e);
      return false;
    }
  },

  // 2. 데이터 가져오기
  async get(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key] || null;
    } catch (e) {
      console.error(`Storage Get Error [${key}]:`, e);
      return null;
    }
  },

  // 3. 모든 분석 결과 가져오기 (Sidepanel에서 유용)
  async getAllResults() {
    try {
      const allData = await chrome.storage.local.get(null);
      // API 명세서의 결과 필드(pred_label)가 있는 데이터만 필터링
      return Object.values(allData).filter(item => item && item.pred_label);
    } catch (e) {
      console.error("Storage GetAll Error:", e);
      return [];
    }
  },

  // 4. 특정 데이터 삭제
  async remove(key) {
    await chrome.storage.local.remove(key);
  },

  // 5. 전체 초기화 (테스트 시 유용)
  async clear() {
    await chrome.storage.local.clear();
    console.log("Storage 초기화 완료");
  }
};

// 다른 파일에서 불러올 수 있도록 내보내기 (ES 모듈 방식 기준)
export default storageHelper;