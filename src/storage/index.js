// 저장소 선택. 모든 드라이버는 같은 인터페이스를 구현한다 (test/storage.test.js의 계약 테스트로 확인).
//
//   save(clientId, entry)              → { entry, created }   같은 id가 있으면 기존 항목, created=false
//   list(clientId, { cursor, limit })  → { items, nextCursor } 최신순(savedAt, id 내림차순)
//                                        items는 요약 { id, title, summary, timeMinutes, difficulty, savedAt } (order.js toListItem)
//   get(clientId, id)                  → entry | null
//   remove(clientId, id)               → boolean
//   count(clientId)                    → number
//
// 다른 clientId의 항목은 없는 것처럼 동작해야 한다.
// clientId는 레시피 주인의 사용자 ID다 (로그인 도입 전 브라우저 ID를 쓰던 이름을 그대로 둔다. Cosmos 파티션 키 /clientId).
//
//   users.create(user)                → { user, created }   같은 이메일이 있으면 created=false
//   users.findByEmail(email)          → user | null          email은 정규화(소문자)된 값
//   user = { id: 이메일(정규화), userId, email, passwordHash, createdAt }
import { createFileStorage } from './file.js';

export async function createStorage({ driver, dataDir, cosmos }) {
  if (driver === 'file') return createFileStorage({ dataDir });
  if (driver === 'cosmos') {
    // file 모드에서는 Azure SDK를 불러오지 않는다
    const { createCosmosStorage } = await import('./cosmos.js');
    return createCosmosStorage(cosmos);
  }
  throw new Error(`알 수 없는 STORAGE_DRIVER: ${driver}`);
}
