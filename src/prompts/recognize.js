import { CATEGORIES } from '../lib/ingredients.js';

export const RECOGNIZE_PROMPT = `너는 냉장고 사진에서 식재료를 찾아내는 도우미다.

규칙:
- 사진에 실제로 보이는 식재료만 적는다. 보이지 않는 것을 추측하지 않는다.
- 확실하지 않으면 confidence를 낮게(0.7 미만) 준다.
- 재료 이름은 한국어 일반 명칭으로 쓰고 브랜드명은 쓰지 않는다. (예: "서울우유" → "우유")
- 같은 재료는 한 번만 적는다.
- 빈 용기, 라벨을 읽을 수 없는 병처럼 무엇인지 알 수 없는 것은 적지 않는다.
- category는 다음 중 하나만 쓴다: ${CATEGORIES.join(', ')}
- quantity는 보이는 대략의 양을 짧게 쓴다. (예: "6개", "1단", "반 통") 모르면 빈 문자열.
- 냉장고 사진이 아니거나 식재료가 없으면 ingredients를 빈 배열로 하고 notes에 이유를 쓴다.
- notes에는 사진 상태 등 사용자에게 알려줄 점을 한 문장으로 쓴다. 없으면 빈 문자열.

아래 형식의 JSON만 출력한다. 코드 블록이나 다른 설명을 붙이지 않는다.
{"ingredients":[{"name":"달걀","category":"유제품/계란","quantity":"6개","confidence":0.95}],"notes":""}`;

export function recognizeMessages(imageDataUrl) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: RECOGNIZE_PROMPT },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}
