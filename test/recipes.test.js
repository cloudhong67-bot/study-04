// 2단계 레시피: 대조 로직 단위 테스트 + /api/recipes/generate API 테스트 (가짜 chat)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY ??= 'test-key';
process.env.OPENROUTER_API_KEY ??= 'test-key';
const { matchesOwned, isPantry, violatesDietary, finalizeRecipes, generateRequestSchema, generateResponseSchema } = await import('../src/lib/recipes.js');
const { startApp } = await import('./helpers.js');

const recipe = (title, names, extra = {}) => ({
  title,
  summary: '',
  cuisine: '한식',
  servings: 2,
  timeMinutes: 20,
  difficulty: '쉬움',
  ingredients: names.map((name) => ({ name, amount: '' })),
  steps: ['만든다.'],
  tips: '',
  ...extra,
});
const request = (overrides = {}) => generateRequestSchema.parse({ ingredients: ['달걀', '대파', '두부', '애호박', '마늘'], ...overrides });

describe('보유 재료 대조', () => {
  test('같은 이름, 꾸밈말이 붙은 이름은 보유로 본다', () => {
    const owned = ['달걀', '대파', '마늘', '애호박'];
    assert.ok(matchesOwned('달걀', owned));
    assert.ok(matchesOwned('계란', owned), '동의어');
    assert.ok(matchesOwned('다진 마늘', owned));
    assert.ok(matchesOwned('송송 썬 대파', owned));
    assert.ok(matchesOwned('다진마늘', owned));
    assert.ok(matchesOwned('호박', owned), "'애호박' 보유 → '호박' 인정");
  });

  test('한 글자 재료는 다른 재료와 헷갈리지 않는다', () => {
    assert.equal(matchesOwned('파프리카', ['파']), false);
    assert.equal(matchesOwned('양파', ['파']), false);
    assert.ok(matchesOwned('파', ['파']));
    assert.equal(matchesOwned('부침가루', ['달걀', '두부']), false);
  });

  test('기본 양념은 부족한 재료로 세지 않는다', () => {
    for (const name of ['소금', '후추', '후춧가루', '설탕', '식용유', '간장', '진간장', '물', '맛소금']) {
      assert.ok(isPantry(name), name);
    }
    for (const name of ['고추장', '된장', '참기름', '굴소스', '물엿']) {
      assert.equal(isPantry(name), false, name);
    }
  });
});

describe('식단 조건', () => {
  test('채식: 고기·해산물·가공품이 들어가면 위반', () => {
    assert.ok(violatesDietary(recipe('닭가슴살 샐러드', ['닭가슴살', '양상추']), ['채식']));
    assert.ok(violatesDietary(recipe('어묵볶음', ['어묵', '양파']), ['채식']));
    assert.ok(violatesDietary(recipe('김치찌개', ['김치', '돼지고기']), ['채식']));
    assert.ok(violatesDietary(recipe('굴전', ['굴', '부침가루']), ['채식']));
    assert.equal(violatesDietary(recipe('두부조림', ['두부', '간장', '대파']), ['채식']), false);
    assert.equal(violatesDietary(recipe('양배추 볶음', ['양배추', '물']), ['채식']), false);
  });

  test('매운 음식 제외 / 모르는 조건은 걸러내지 않음', () => {
    assert.ok(violatesDietary(recipe('떡볶이', ['떡', '고추장']), ['매운 음식 제외']));
    assert.equal(violatesDietary(recipe('떡볶이', ['떡', '고추장']), ['저염식']), false);
  });
});

describe('finalizeRecipes', () => {
  test('owned·missingIngredients를 서버가 다시 계산하고 id를 붙인다', () => {
    const [r] = finalizeRecipes([recipe('두부 달걀 부침', ['두부', '계란', '부침가루', '소금'])], request());
    assert.match(r.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(r.ingredients.map((i) => [i.name, i.owned, i.basic]), [
      ['두부', true, false], ['계란', true, false], ['부침가루', false, false], ['소금', true, true],
    ]);
    assert.deepEqual(r.missingIngredients, ['부침가루']);
  });

  test('부족한 재료가 2개를 넘으면 빼고, 적은 순으로 정렬하고, 개수를 맞춘다', () => {
    const out = finalizeRecipes([
      recipe('A', ['두부', '베이컨', '치즈']),
      recipe('B', ['두부', '달걀']),
      recipe('C', ['소고기', '버섯', '당근']),
      recipe('D', ['대파', '부추']),
      recipe('E', ['마늘', '애호박']),
    ], request({ count: 3 }));
    assert.deepEqual(out.map((r) => r.title), ['B', 'E', 'D']);
  });

  test('제외할 요리와 중복 요리는 뺀다 (띄어쓰기 무시)', () => {
    const out = finalizeRecipes(
      [recipe('두부 조림', ['두부']), recipe('달걀찜', ['달걀']), recipe('달걀 찜', ['달걀']), recipe('파전', ['대파'])],
      request({ excludeTitles: ['두부조림'] }),
    );
    assert.deepEqual(out.map((r) => r.title), ['달걀찜', '파전']);
  });

  test('식단 조건을 어긴 레시피는 뺀다', () => {
    const out = finalizeRecipes(
      [recipe('햄 달걀볶음', ['햄', '달걀']), recipe('두부 달걀볶음', ['두부', '달걀'])],
      request({ preferences: { dietary: ['채식'] } }),
    );
    assert.deepEqual(out.map((r) => r.title), ['두부 달걀볶음']);
  });
});

describe('POST /api/recipes/generate', () => {
  let nextReplies = [];
  const calls = [];
  async function fakeChat(messages, options) {
    calls.push({ messages, options });
    return { text: nextReplies.shift(), model: 'fake-model' };
  }

  let app;
  let cookie;
  before(async () => {
    app = await startApp({ chat: fakeChat });
    cookie = await app.signup();
  });
  after(() => app.close());

  const post = (body) => fetch(`${app.baseUrl}/api/recipes/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const modelReply = (...recipes) => JSON.stringify({ recipes });

  test('정상 생성: 조건을 프롬프트에 넣고, 서버 후처리 결과를 돌려준다', async () => {
    calls.length = 0;
    nextReplies = ['```json\n' + modelReply(
      recipe('두부 달걀 부침', ['두부', '달걀', '부침가루', '소금']),
      recipe('대파 달걀볶음', ['대파', '달걀', '식용유']),
      { title: '깨진 레시피' },
    ) + '\n```'];
    const res = await post({
      ingredients: ['달걀', '대파', '두부'],
      preferences: { servings: 1, maxTimeMinutes: 15, difficulty: '쉬움', dietary: ['매운 음식 제외'], cuisine: '한식' },
      count: 2,
      excludeTitles: ['김치찌개'],
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.recipes.map((r) => r.title), ['대파 달걀볶음', '두부 달걀 부침']);
    assert.deepEqual(data.recipes[1].missingIngredients, ['부침가루']);
    assert.equal(data.model, 'fake-model');

    const userPrompt = calls[0].messages[1].content;
    for (const text of ['달걀, 대파, 두부', '레시피 개수: 3개', '1인분', '15분', '쉬움', '매운 음식 제외', '한식', '김치찌개']) {
      assert.ok(userPrompt.includes(text), `프롬프트에 '${text}' 포함`);
    }
    assert.equal(calls[0].options.timeoutMs, 120000);
  });

  test('JSON이 깨지면 1회 다시 요청하고, 그래도 실패하면 502 MODEL_ERROR', async () => {
    calls.length = 0;
    nextReplies = ['레시피입니다!', modelReply(recipe('달걀찜', ['달걀']))];
    assert.equal((await post({ ingredients: ['달걀'] })).status, 200);
    assert.equal(calls.length, 2);

    nextReplies = ['오류', '또 오류'];
    const res = await post({ ingredients: ['달걀'] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'MODEL_ERROR');
  });

  test('남는 레시피가 없으면 422 NO_RECIPES', async () => {
    nextReplies = [modelReply(recipe('소고기 무국', ['소고기', '무', '국간장', '참기름']))];
    const res = await post({ ingredients: ['달걀'] });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'NO_RECIPES');
  });

  test('입력이 잘못되면 400 INVALID_REQUEST', async () => {
    for (const body of [
      {},
      { ingredients: [] },
      { ingredients: Array.from({ length: 51 }, (_, i) => `재료${i}`) },
      { ingredients: ['달걀'], count: 6 },
      { ingredients: ['달걀'], preferences: { difficulty: '매우 어려움' } },
      { ingredients: ['달걀'], preferences: { servings: 0 } },
      '{깨진 json',
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const { error } = await res.json();
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.message, '요청을 처리하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.', 'zod 영어 원문을 사용자에게 보내지 않는다');
    }
  });
});

test('요청 제한: 레시피 생성은 IP당 분당 5회', async () => {
  const app = await startApp({ rateLimit: true });
  try {
    const cookie = await app.signup();
    const url = `${app.baseUrl}/api/recipes/generate`;
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
      statuses.push(res.status);
      if (res.status === 429) assert.equal((await res.json()).error.code, 'RATE_LIMITED');
    }
    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
  } finally {
    await app.close();
  }
});

describe('리뷰 수정 회귀', () => {

  test('재료 amount가 빠졌거나 null이면 빈 문자열 ("undefined"/"null" 아님), 숫자는 문자열로', () => {
    const { recipes: [r] } = generateResponseSchema.parse({
      recipes: [{ title: '달걀찜', ingredients: [{ name: '달걀' }, { name: '대파', amount: null }, { name: '물', amount: 200 }, { name: '소금', amount: ' 약간 ' }], steps: ['찐다.'] }],
    });
    assert.deepEqual(r.ingredients.map((i) => i.amount), ['', '', '200', '약간']);
  });

  test('동의어 재료: 원래 이름과 대표 이름 둘 다로 대조한다', () => {
    assert.ok(matchesOwned('송송 썬 쪽파', ['쪽파']), "'쪽파' 보유 → '송송 썬 쪽파'");
    assert.ok(matchesOwned('쪽파', ['쪽파']));
    assert.ok(matchesOwned('파', ['쪽파']), "'쪽파'의 대표 이름 '파'");
    assert.ok(matchesOwned('방울토마토', ['방울토마토']));
    assert.ok(matchesOwned('토마토', ['방울토마토']));
    assert.ok(matchesOwned('삶은 계란', ['달걀']));
    assert.equal(matchesOwned('대파', ['쪽파']), false, '대파와 쪽파는 다른 재료로 본다');
    assert.equal(matchesOwned('양파', ['쪽파']), false);
    assert.equal(matchesOwned('파프리카', ['쪽파']), false);
  });

  test("채식: '오리엔탈'·'오리지널'은 오리가 아니다, 오리고기는 위반", () => {
    assert.equal(violatesDietary(recipe('샐러드', ['양상추', '오리엔탈 드레싱']), ['채식']), false);
    assert.equal(violatesDietary(recipe('샐러드', ['오리지널 소스']), ['채식']), false);
    assert.ok(violatesDietary(recipe('오리 볶음', ['훈제 오리']), ['채식']));
    assert.ok(violatesDietary(recipe('오리 볶음', ['오리고기']), ['채식']));
  });

  // 알레르기에 쓰이는 조건: 흔한 재료 이름이 키워드를 빠져나가지 않는지
  const violations = {
    '견과류 제외': ['피넛버터', '땅콩버터', '캐슈넛', '헤이즐넛', '피칸', '마카다미아', '누텔라'],
    '유제품 제외': ['모짜렐라', '모차렐라 치즈', '리코타', '파마산', '사워크림', '휘핑크림', '크림치즈', '마스카포네', '분유'],
    채식: ['바지락', '전복', '가리비', '골뱅이', '주꾸미', '명란', '안초비', '피시소스', '치킨스톡', '사골 육수', '순대', '곱창', '새우젓', '해물믹스', '미트볼', '꽃게'],
  };
  for (const [rule, names] of Object.entries(violations)) {
    test(`${rule}: ${names.join(', ')}이 들어가면 위반`, () => {
      for (const name of names) assert.ok(violatesDietary(recipe('요리', [name]), [rule]), name);
    });
  }

  test('늘린 키워드가 흔한 채소·양념을 잘못 걸지 않는다', () => {
    const plain = ['양배추', '두부', '애호박', '감자', '고구마', '시금치', '콩나물', '버섯', '다시마', '미역', '김', '양파', '대파', '마늘', '된장', '참기름', '치킨무', '올리브유'];
    for (const rule of ['채식', '유제품 제외', '견과류 제외']) {
      for (const name of plain) assert.equal(violatesDietary(recipe('요리', [name]), [rule]), false, `${rule}: ${name}`);
    }
  });

  test('32KB가 넘는 레시피는 저장할 수 없으므로 생성 결과에서 뺀다', () => {
    const long = Array.from({ length: 25 }, () => '가'.repeat(450));
    const out = finalizeRecipes([recipe('긴 두부조림', ['두부'], { steps: long }), recipe('달걀찜', ['달걀'])], request());
    assert.deepEqual(out.map((r) => r.title), ['달걀찜']);
  });
});
