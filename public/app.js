// 냉장고를 부탁해 - 1단계 화면 (사진 업로드 → 재료 인식 → 목록 수정)
// 모델이 만든 문자열은 모두 textContent로 넣는다 (innerHTML 사용 금지).

const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품/계란', '반찬/절임', '소스/양념', '음료', '가공식품', '기타'];
const LOW_CONFIDENCE = 0.7;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const STORAGE_KEY = 'fridge-chef.recognition';
const LOADING_MESSAGES = ['사진을 살펴보는 중...', '재료를 찾는 중...', '재료 이름을 정리하는 중...', '거의 다 됐어요...'];

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('file-input'),
  preview: $('preview'),
  recognizeBtn: $('recognize-btn'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  error: $('error'),
  resultSection: $('result-section'),
  notes: $('notes'),
  groups: $('ingredient-groups'),
  addForm: $('add-form'),
  addName: $('add-name'),
  addCategory: $('add-category'),
  meta: $('meta'),
};

let state = loadState() ?? { ingredients: [], notes: '', meta: '' };
let selectedFile = null;

// ---------- 상태 저장 (새로고침해도 유지) ----------
function loadState() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveState() {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- 이미지 준비 ----------
// 브라우저가 읽을 수 있으면 긴 변 1600px JPEG로 바꿔 업로드 용량을 줄인다.
// iOS Safari는 HEIC를 읽을 수 있으므로 여기서 JPEG로 바뀐다 (서버의 sharp는 HEIC를 읽지 못함).
async function prepareImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return blob ?? file;
  } catch {
    return file; // 브라우저가 못 읽는 형식은 원본 그대로 보내고 서버 판단에 맡긴다
  }
}

// ---------- 화면 그리기 ----------
function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

function setLoading(on) {
  els.loading.hidden = !on;
  els.recognizeBtn.disabled = on || !selectedFile;
  els.fileInput.disabled = on;
  clearInterval(setLoading.timer);
  if (on) {
    let i = 0;
    els.loadingText.textContent = LOADING_MESSAGES[0];
    setLoading.timer = setInterval(() => {
      i = Math.min(i + 1, LOADING_MESSAGES.length - 1);
      els.loadingText.textContent = LOADING_MESSAGES[i];
    }, 4000);
  }
}

function render() {
  const { ingredients } = state;
  els.resultSection.hidden = ingredients.length === 0 && !state.meta;
  els.notes.textContent = state.notes ? `💡 ${state.notes}` : '';
  els.notes.hidden = !state.notes;
  els.meta.textContent = state.meta ? `${state.meta} · 재료 ${ingredients.length}개` : '';
  els.groups.replaceChildren();

  for (const category of CATEGORIES) {
    const items = ingredients.filter((item) => item.category === category);
    if (items.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'group';
    const title = document.createElement('h3');
    title.textContent = `${category} (${items.length})`;
    const chips = document.createElement('ul');
    chips.className = 'chips';
    for (const item of items) chips.append(renderChip(item));
    group.append(title, chips);
    els.groups.append(group);
  }
}

function renderChip(item) {
  const li = document.createElement('li');
  li.className = 'chip';
  if (item.confidence < LOW_CONFIDENCE) li.classList.add('low');

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'chip-name';
  name.textContent = item.name;
  name.title = '눌러서 이름 고치기';
  name.addEventListener('click', () => startEdit(li, item));
  li.append(name);

  if (item.quantity) {
    const qty = document.createElement('span');
    qty.className = 'qty';
    qty.textContent = item.quantity;
    li.append(qty);
  }
  if (item.confidence < LOW_CONFIDENCE) {
    const badge = document.createElement('span');
    badge.className = 'badge low';
    badge.textContent = '확인 필요';
    li.append(badge);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `${item.name} 삭제`);
  remove.addEventListener('click', () => {
    state.ingredients = state.ingredients.filter((i) => i !== item);
    commit();
  });
  li.append(remove);
  return li;
}

function startEdit(li, item) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = item.name;
  input.maxLength = 30;
  input.className = 'chip-edit';
  li.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== item.name) {
      if (hasIngredient(value, item)) {
        showError(`'${value}'는 이미 목록에 있어요.`);
      } else {
        item.name = value;
        item.confidence = 1; // 사용자가 확인한 재료
      }
    }
    commit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function hasIngredient(name, except) {
  return state.ingredients.some((i) => i !== except && i.name === name);
}

function commit() {
  saveState();
  render();
}

// ---------- 이벤트 ----------
els.addCategory.append(...CATEGORIES.map((c) => new Option(c, c)));
els.addCategory.value = '기타';

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  showError('');
  selectedFile = null;
  els.recognizeBtn.disabled = true;
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    showError('이미지는 10MB 이하만 올릴 수 있습니다.');
    return;
  }
  selectedFile = file;
  URL.revokeObjectURL(els.preview.src);
  els.preview.src = URL.createObjectURL(file);
  els.preview.hidden = false;
  els.recognizeBtn.disabled = false;
});

els.recognizeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  showError('');
  setLoading(true);
  try {
    const body = new FormData();
    body.append('image', await prepareImage(selectedFile), 'fridge.jpg');
    const res = await fetch('/api/ingredients/recognize', { method: 'POST', body });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message ?? `요청에 실패했습니다. (HTTP ${res.status})`);

    state = {
      ingredients: data.ingredients,
      notes: data.notes,
      meta: `인식 시간 ${(data.elapsedMs / 1000).toFixed(1)}초`,
    };
    commit();
    els.resultSection.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showError(err.message === 'Failed to fetch' ? '서버에 연결할 수 없습니다.' : err.message);
  } finally {
    setLoading(false);
  }
});

els.addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = els.addName.value.trim();
  if (!name) return;
  if (hasIngredient(name)) {
    showError(`'${name}'는 이미 목록에 있어요.`);
    return;
  }
  showError('');
  state.ingredients.push({ name, category: els.addCategory.value, quantity: '', confidence: 1 });
  state.meta ||= '직접 입력';
  els.addName.value = '';
  commit();
});

render();
