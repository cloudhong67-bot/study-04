// 업로드 이미지 전처리: 회전 보정 → 긴 변 1280px 이하로 축소 → JPEG 변환(EXIF 제거) → base64 data URL
// OpenRouter 무료 엔드포인트는 이미지 URL을 받지 않으므로 항상 data URL로 보낸다.
import sharp from 'sharp';
import { errors } from './errors.js';

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_SIDE = 1280;
// 파일은 10MB 이하여도 픽셀 수가 매우 큰 이미지(단색 PNG 등)는 디코딩에 메모리·CPU를 많이 쓴다.
// 5천만 화소(예: 8660x5773)면 휴대폰 기본 촬영(1200만~5000만 화소)은 통과한다. 브라우저가 1280px로 줄여 보내므로 화면 사용자는 영향이 없다.
export const MAX_INPUT_PIXELS = 50_000_000;

export async function toDataUrl(buffer) {
  let jpeg;
  try {
    jpeg = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // EXIF 방향대로 회전한 뒤, 출력에는 메타데이터를 넣지 않는다
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (err) {
    if (/pixel limit/i.test(err.message)) throw errors.imageTooLarge('사진 해상도가 너무 커요. 5천만 화소 이하로 줄여서 올려 주세요.');
    // 미리 빌드된 sharp는 HEIC를 읽지 못한다. 브라우저가 JPEG로 바꿔 보내지 못한 경우 여기로 온다.
    throw errors.invalidImage('사진을 읽지 못했어요. HEIC 사진이라면 JPEG로 바꿔서 올려 주세요.');
  }
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}
