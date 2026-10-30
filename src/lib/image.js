// 업로드 이미지 전처리: 회전 보정 → 긴 변 1280px 이하로 축소 → JPEG 변환(EXIF 제거) → base64 data URL
// OpenRouter 무료 엔드포인트는 이미지 URL을 받지 않으므로 항상 data URL로 보낸다.
import sharp from 'sharp';
import { errors } from './errors.js';

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_SIDE = 1280;

export async function toDataUrl(buffer) {
  let jpeg;
  try {
    jpeg = await sharp(buffer)
      .rotate() // EXIF 방향대로 회전한 뒤, 출력에는 메타데이터를 넣지 않는다
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    // 미리 빌드된 sharp는 HEIC를 읽지 못한다. 브라우저가 JPEG로 바꿔 보내지 못한 경우 여기로 온다.
    throw errors.invalidImage('이미지를 읽을 수 없습니다. HEIC 사진이라면 JPEG로 바꿔서 올려 주세요.');
  }
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}
