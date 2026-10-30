// 목록 정렬과 커서. 두 드라이버가 같이 쓴다.
// 정렬: savedAt 내림차순, 같으면 id 내림차순 (cosmos 쿼리의 ORDER BY와 같아야 한다)
// 커서: 마지막 항목의 (savedAt, id). 중간에 항목이 지워져도 다음 페이지가 밀리지 않는다.
export function compareNewestFirst(a, b) {
  if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function encodeCursor({ savedAt, id }) {
  return Buffer.from(JSON.stringify({ savedAt, id })).toString('base64url');
}

// 잘못된 커서는 null (처음부터)
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const { savedAt, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof savedAt === 'string' && typeof id === 'string') return { savedAt, id };
  } catch {}
  return null;
}

// 목록 항목(요약). 목록 화면에는 본문(재료·조리 순서)이 필요 없으므로 두 드라이버 모두 이 필드만 돌려준다.
// cosmos.js의 SELECT 프로젝션과 필드·순서가 같아야 한다. API 목록 응답 형식(PRD_step3 6장)도 이것이다.
export function toListItem({ id, savedAt, recipe }) {
  return { id, title: recipe.title, summary: recipe.summary, timeMinutes: recipe.timeMinutes, difficulty: recipe.difficulty, savedAt };
}
