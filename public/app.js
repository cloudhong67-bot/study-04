// 냉장고를 부탁해 - 화면
// 1단계: 사진 업로드 → 재료 인식 → 목록 수정
// 2단계: 조건 선택 → 레시피 추천 → 상세 보기 / 다른 레시피 보기
// 3단계: 레시피 저장 → 내 레시피 목록 / 상세 / 삭제
// 모델이 만든 문자열은 모두 textContent로 넣는다 (innerHTML 사용 금지).

const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품/계란', '반찬/절임', '소스/양념', '음료', '가공식품', '기타'];
const LOW_CONFIDENCE = 0.7;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 서버가 받는 크기(줄인 뒤 기준)
const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024; // 고른 원본 사진: 줄이기 전에 메모리를 너무 쓰지 않도록 큰 안전 한도만 둔다
const MAX_SIDE = 1280; // 서버(src/lib/image.js)와 같은 크기. 더 크게 보내도 서버가 다시 줄인다
const MAX_EXCLUDE = 20;
const MAX_INGREDIENTS = 50; // 서버 상한(레시피 생성·저장 요청의 재료 수)과 같다
const STORAGE_KEY = 'fridge-chef.state';
// 보통 걸리는 시간을 먼저 알려 주고, 오래 걸리면 "더 걸릴 수 있다"로 바꿔 멈춘 것처럼 보이지 않게 한다
const RECOGNIZE_MESSAGES = ['사진에서 재료를 찾고 있어요. 보통 5초 안에 끝나요.', '재료 이름을 정리하고 있어요...', '조금만 더 기다려 주세요. 사진이 복잡하면 더 걸릴 수 있어요.'];
const RECIPE_MESSAGES = ['레시피를 만들고 있어요. 보통 10초쯤 걸려요.', '어울리는 요리를 고르고 있어요...', '조리 순서를 쓰고 있어요...', '조금만 더 기다려 주세요. 길면 1분쯤 걸릴 수 있어요.'];

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('file-input'),
  preview: $('preview'),
  recognizeBtn: $('recognize-btn'),
  manualBtn: $('manual-btn'),
  error: $('error'),
  resultSection: $('result-section'),
  notes: $('notes'),
  groups: $('ingredient-groups'),
  addForm: $('add-form'),
  addName: $('add-name'),
  addCategory: $('add-category'),
  addError: $('add-error'),
  ingredientsEmpty: $('ingredients-empty'),
  meta: $('meta'),
  prefs: $('prefs'),
  prefsForm: $('prefs-form'),
  recipeBtn: $('recipe-btn'),
  recipesSection: $('recipes-section'),
  recipeErrorBox: $('recipe-error-box'),
  recipeError: $('recipe-error'),
  retryBtn: $('retry-btn'),
  recipeCards: $('recipe-cards'),
  recipeMeta: $('recipe-meta'),
  moreBtn: $('more-btn'),
  dialog: $('recipe-dialog'),
  saveBtn: $('save-btn'),
  deleteBtn: $('delete-btn'),
  dialogError: $('dialog-error'),
  findView: $('find-view'),
  savedView: $('saved-view'),
  tabFind: $('tab-find'),
  tabSaved: $('tab-saved'),
  savedCards: $('saved-cards'),
  savedEmpty: $('saved-empty'),
  savedMoreBtn: $('saved-more-btn'),
  savedErrorBox: $('saved-error-box'),
  savedError: $('saved-error'),
  toast: $('toast'),
};

const EMPTY_STATE = { ingredients: [], notes: '', meta: '', prefs: null, recipes: [], seenTitles: [], recipeMeta: '', savedIds: [] };
let state = { ...EMPTY_STATE, ...loadState() };
let selectedFile = null;
let lastRecipeRequest = null;
// 진행 중인 AI 작업: 'recognize' | 'recipes' | null. 한 번에 하나만 돌려 결과가 섞이지 않게 한다.
let busy = null;
// 레시피 요청 세대: 새 사진을 인식하면 올려서, 그 전에 보낸 요청의 응답은 버린다
let recipeGen = 0;
let recipeAbort = null;
// 내 레시피 목록 (서버에서 불러옴, 새로고침하면 다시 불러온다)
const saved = { items: [], nextCursor: null, loaded: false };
// 상세 창에 열린 레시피: { recipe, entry } (entry는 내 레시피에서 열었을 때만)
let openedRecipe = null;

// ---------- 로그인 ----------
// 세션은 HttpOnly 쿠키라 스크립트에서 읽지 않는다. 서버가 401을 주면 로그인 화면으로 보낸다.
function goToLogin() {
  location.replace('/login.html');
}

async function loadUser() {
  try {
    const { user } = await requestJson('/api/auth/me');
    $('user-email').textContent = user.email;
  } catch {
    // requestJson이 401이면 이미 로그인 화면으로 보냈다
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    sessionStorage.clear(); // 다음 사용자에게 화면 상태가 남지 않게
    goToLogin();
  }
}

// ---------- 상태 저장 (새로고침해도 유지) ----------
function loadState() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveState() {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function commit() {
  saveState();
  render();
}

// ---------- 공통 ----------
function makeLoader(box, textEl, messages) {
  let timer;
  return (on) => {
    box.hidden = !on;
    clearInterval(timer);
    if (!on) return;
    let i = 0;
    textEl.textContent = messages[0];
    timer = setInterval(() => {
      i = Math.min(i + 1, messages.length - 1);
      textEl.textContent = messages[i];
    }, 5000);
  };
}
const showRecognizeLoading = makeLoader($('loading'), $('loading-text'), RECOGNIZE_MESSAGES);
const showRecipeLoading = makeLoader($('recipe-loading'), $('recipe-loading-text'), RECIPE_MESSAGES);

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

// 화면 분기는 문구가 아니라 status·code로 한다 (문구는 바뀔 수 있다)
function apiError(message, status = 0, code = 'NETWORK') {
  return Object.assign(new Error(message), { status, code });
}

async function requestJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw apiError('', 0, 'ABORTED');
    throw apiError('서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
  }
  if (res.status === 401) {
    goToLogin();
    throw apiError('로그인이 필요해요.', 401, 'UNAUTHORIZED');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 서버 JSON이 아닌 응답(프록시 오류 등)이어도 상태 코드 숫자 대신 할 일을 알려 준다
    const fallback = res.status >= 500
      ? '서버에 잠시 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
      : '요청을 처리하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.';
    throw apiError(data?.error?.message ?? fallback, res.status, data?.error?.code ?? 'HTTP_ERROR');
  }
  return data;
}

// 저장 API (로그인한 사용자의 레시피)
function savedApi(path = '', { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  return requestJson(`/api/recipes${path}`, { method, headers, body: body && JSON.stringify(body) });
}

function showToast(message) {
  els.toast.textContent = message;
  // 이미 떠 있으면 닫았다 다시 열어 열린 상세 창보다 위에 오게 한다
  if (els.toast.matches(':popover-open')) els.toast.hidePopover();
  els.toast.showPopover();
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.hidePopover(), 2500);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- 1단계: 이미지 준비 ----------
// 브라우저가 읽을 수 있으면 긴 변 1280px JPEG로 바꿔 업로드 용량을 줄인다.
// iOS Safari는 HEIC를 읽을 수 있으므로 여기서 JPEG로 바뀐다 (서버의 sharp는 HEIC를 읽지 못함).
async function prepareImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
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
function render() {
  renderIngredients();
  renderRecipes();
}

function renderIngredients() {
  const { ingredients } = state;
  els.resultSection.hidden = ingredients.length === 0 && !state.meta;
  els.notes.textContent = state.notes ? `💡 ${state.notes}` : '';
  els.notes.hidden = !state.notes;
  els.meta.textContent = state.meta ? `${state.meta} · 재료 ${ingredients.length}개` : '';
  els.recipeBtn.hidden = ingredients.length === 0;
  els.ingredientsEmpty.hidden = ingredients.length > 0;
  els.groups.replaceChildren();

  for (const category of CATEGORIES) {
    const items = ingredients.filter((item) => item.category === category);
    if (items.length === 0) continue;

    const group = el('div', 'group');
    const chips = el('ul', 'chips');
    for (const item of items) chips.append(renderChip(item));
    group.append(el('h3', '', `${category} (${items.length})`), chips);
    els.groups.append(group);
  }
}

// 칩 버튼 → 재료. 고친 뒤 다시 그려진 같은 재료 칩으로 포커스를 돌려주는 데 쓴다
const chipItems = new WeakMap();

function renderChip(item) {
  const li = el('li', 'chip');
  if (item.confidence < LOW_CONFIDENCE) li.classList.add('low');

  const name = el('button', 'chip-name', item.name);
  name.type = 'button';
  name.title = '눌러서 이름 고치기';
  name.setAttribute('aria-label', `${item.name}, 이름 고치기`);
  // 이름을 눌러 고칠 수 있다는 걸 글 안내를 읽지 않아도 알 수 있게 연필 표시를 붙인다
  const pencil = el('span', 'edit-icon', '✎');
  pencil.setAttribute('aria-hidden', 'true');
  name.append(pencil);
  chipItems.set(name, item);
  name.addEventListener('click', () => startEdit(li, item));
  li.append(name);

  if (item.quantity) li.append(el('span', 'qty', item.quantity));
  if (item.confidence < LOW_CONFIDENCE) li.append(el('span', 'badge low', '? 확인 필요'));

  const remove = el('button', 'remove', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `${item.name} 삭제`);
  remove.addEventListener('click', () => {
    state.ingredients = state.ingredients.filter((i) => i !== item);
    commit();
  });
  li.append(remove);
  return li;
}

function startEdit(li, item) {
  const input = el('input', 'chip-edit');
  input.type = 'text';
  input.value = item.name;
  input.maxLength = 30;
  input.setAttribute('aria-label', '재료 이름 고치기 (Enter: 저장, Esc: 취소)');
  li.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save, refocus = false) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== item.name) {
      if (hasIngredient(value, item)) {
        showAddError(`'${value}'은(는) 이미 목록에 있어요. 다른 이름으로 고쳐 주세요.`);
      } else {
        item.name = value;
        item.confidence = 1; // 사용자가 확인한 재료
      }
    }
    commit();
    // 키보드로 끝냈으면 다시 그려진 같은 칩으로 포커스를 돌려 위치를 잃지 않게 한다
    if (refocus) [...els.groups.querySelectorAll('.chip-name')].find((b) => chipItems.get(b) === item)?.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // 돌아간 칩 버튼에 같은 Enter가 눌려 편집이 다시 열리지 않게
      finish(true, true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false, true);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function hasIngredient(name, except) {
  return state.ingredients.some((i) => i !== except && i.name === name);
}

// 기본 양념(basic)은 "보유 재료 n/m" 계산에서 뺀다.
function ownedSummary(recipe) {
  const main = recipe.ingredients.filter((i) => !i.basic);
  return { owned: main.filter((i) => i.owned).length, total: main.length };
}

function renderRecipes() {
  const { recipes } = state;
  els.recipesSection.hidden = recipes.length === 0 && els.recipeErrorBox.hidden && $('recipe-loading').hidden;
  els.recipeMeta.textContent = recipes.length ? state.recipeMeta : '';
  els.moreBtn.hidden = recipes.length === 0;
  els.recipeCards.replaceChildren();

  recipes.forEach((recipe, index) => {
    const li = el('li');
    const card = el('button', 'recipe-card');
    card.type = 'button';
    card.dataset.index = String(index);
    card.addEventListener('click', () => openRecipe(state.recipes[index], null, () => focusRecipeCard(index)));

    const { owned, total } = ownedSummary(recipe);
    const badges = el('p', 'badges');
    badges.append(
      el('span', 'badge', `⏱ ${recipe.timeMinutes}분`),
      el('span', `badge difficulty-${recipe.difficulty}`, recipe.difficulty),
      el('span', 'badge owned', `보유 재료 ${owned}/${total}`),
    );
    if (recipe.missingIngredients.length) {
      badges.append(el('span', 'badge missing', `구매 필요 ${recipe.missingIngredients.length}`));
    }
    if (state.savedIds.includes(recipe.id)) badges.append(el('span', 'badge saved', '✓ 저장됨'));
    card.append(el('h3', '', recipe.title), el('p', 'summary', recipe.summary), badges);
    li.append(card);
    els.recipeCards.append(li);
  });
}

// entry: 내 레시피에서 열었을 때의 저장 항목 (저장 시각, 당시 보유 재료)
// restoreFocus: 닫을 때 포커스를 돌려줄 곳. 닫으면 카드 목록을 다시 그리므로 원래 버튼 요소가 사라진다.
function openRecipe(recipe, entry = null, restoreFocus = null) {
  openedRecipe = { recipe, entry, restoreFocus };
  $('dialog-title').textContent = recipe.title;
  $('dialog-summary').textContent = recipe.summary;

  const badges = $('dialog-badges');
  badges.replaceChildren(
    el('span', 'badge', `${recipe.servings}인분`),
    el('span', 'badge', `⏱ ${recipe.timeMinutes}분`),
    el('span', `badge difficulty-${recipe.difficulty}`, recipe.difficulty),
  );
  if (recipe.cuisine) badges.append(el('span', 'badge', recipe.cuisine));

  // 가진 재료(✔)를 먼저, 부족한 재료(구매 필요)를 뒤에
  const sorted = [...recipe.ingredients].sort((a, b) => Number(b.owned) - Number(a.owned));
  $('dialog-ingredients').replaceChildren(...sorted.map((item) => {
    const li = el('li', item.owned ? 'owned' : 'missing');
    li.append(el('span', 'mark', item.owned ? '✔' : '✚'), el('span', 'name', item.name));
    if (item.amount) li.append(el('span', 'amount', item.amount));
    if (item.basic) li.append(el('span', 'badge', '기본 양념'));
    if (!item.owned) li.append(el('span', 'badge missing', '구매 필요'));
    return li;
  }));

  $('dialog-steps').replaceChildren(...recipe.steps.map((step) => el('li', '', step)));
  $('dialog-tips').textContent = recipe.tips;
  $('dialog-tips-box').hidden = !recipe.tips;

  const info = $('dialog-saved-info');
  info.hidden = !entry;
  info.textContent = entry
    ? `${formatDate(entry.savedAt)}에 저장 · 그때 가진 재료: ${entry.ownedIngredients.join(', ') || '없음'}`
    : '';
  showDialogError('');
  els.deleteBtn.hidden = !entry;
  els.deleteBtn.disabled = false;
  els.saveBtn.hidden = Boolean(entry);
  renderSaveButton();
  els.dialog.showModal();
  els.dialog.scrollTop = 0;
}

function renderSaveButton() {
  const isSaved = openedRecipe && state.savedIds.includes(openedRecipe.recipe.id);
  els.saveBtn.textContent = isSaved ? '저장됨 ✓' : '저장';
  els.saveBtn.disabled = Boolean(isSaved);
}

function showDialogError(message) {
  els.dialogError.textContent = message;
  els.dialogError.hidden = !message;
}

// ---------- 3단계: 저장 / 내 레시피 ----------
async function saveOpenedRecipe() {
  const { recipe } = openedRecipe;
  els.saveBtn.disabled = true;
  els.saveBtn.textContent = '저장하는 중...';
  showDialogError('');
  try {
    await savedApi('', { method: 'POST', body: { recipe, ownedIngredients: state.ingredients.map((i) => i.name) } });
    state.savedIds = [...new Set([...state.savedIds, recipe.id])];
    saved.loaded = false; // 내 레시피를 열 때 다시 불러온다
    commit();
    showToast('저장했어요. "내 레시피"에서 볼 수 있어요.');
  } catch (err) {
    showDialogError(err.message);
  } finally {
    renderSaveButton();
  }
}

async function deleteOpenedRecipe() {
  const { recipe } = openedRecipe;
  if (!confirm(`'${recipe.title}' 레시피를 삭제할까요? 삭제하면 되돌릴 수 없어요.`)) return;
  els.deleteBtn.disabled = true;
  showDialogError('');
  try {
    await savedApi(`/${encodeURIComponent(recipe.id)}`, { method: 'DELETE' });
  } catch (err) {
    // 이미 지워졌으면(다른 탭 등) 목록에서만 빼면 된다
    if (err.code !== 'NOT_FOUND') {
      showDialogError(err.message);
      els.deleteBtn.disabled = false;
      return;
    }
  }
  saved.items = saved.items.filter((item) => item.id !== recipe.id);
  state.savedIds = state.savedIds.filter((id) => id !== recipe.id);
  openedRecipe.restoreFocus = () => $('saved-heading').focus();
  commit();
  renderSaved();
  els.dialog.close();
  showToast('삭제했어요.');
}

async function loadSaved({ more = false } = {}) {
  els.savedErrorBox.hidden = true;
  $('saved-loading').hidden = false;
  els.savedMoreBtn.disabled = true;
  try {
    const query = more && saved.nextCursor ? `?cursor=${encodeURIComponent(saved.nextCursor)}` : '';
    const data = await savedApi(query);
    saved.items = more ? [...saved.items, ...data.items] : data.items;
    saved.nextCursor = data.nextCursor;
    saved.loaded = true;
  } catch (err) {
    els.savedError.textContent = err.message;
    els.savedErrorBox.hidden = false;
  } finally {
    $('saved-loading').hidden = true;
    els.savedMoreBtn.disabled = false;
    renderSaved();
  }
}

function renderSaved() {
  els.savedEmpty.hidden = !saved.loaded || saved.items.length > 0;
  els.savedMoreBtn.hidden = !saved.nextCursor;
  els.savedCards.replaceChildren(...saved.items.map((item) => {
    const li = el('li');
    const card = el('button', 'recipe-card');
    card.type = 'button';
    card.addEventListener('click', () => openSaved(item.id, card));
    const badges = el('p', 'badges');
    badges.append(
      el('span', 'badge', `⏱ ${item.timeMinutes}분`),
      el('span', `badge difficulty-${item.difficulty}`, item.difficulty),
      el('span', 'badge', `${formatDate(item.savedAt)} 저장`),
    );
    card.append(el('h3', '', item.title), el('p', 'summary', item.summary), badges);
    li.append(card);
    return li;
  }));
}

// 상세를 불러오는 중이면 다시 눌러도 무시한다 (연타로 같은 GET이 여러 번 나가고 창이 여러 번 열리는 것 방지)
let openingSaved = false;
async function openSaved(id, card) {
  if (openingSaved) return;
  openingSaved = true;
  els.savedErrorBox.hidden = true;
  // 누른 카드에 바로 "여는 중" 표시: 응답이 늦어도 눌렸다는 걸 알 수 있게
  const status = el('span', 'card-loading');
  status.append(el('span', 'spinner'), el('span', '', '여는 중...'));
  card.classList.add('opening');
  card.setAttribute('aria-busy', 'true');
  card.append(status);
  try {
    const entry = await savedApi(`/${encodeURIComponent(id)}`);
    openRecipe(entry.recipe, entry, () => focusSavedCard(id));
  } catch (err) {
    els.savedError.textContent = err.message;
    els.savedErrorBox.hidden = false;
    if (err.code === 'NOT_FOUND') loadSaved(); // 다른 곳에서 지워졌으면 목록을 새로 고친다
  } finally {
    openingSaved = false;
    card.classList.remove('opening');
    card.removeAttribute('aria-busy');
    status.remove();
  }
}

function focusRecipeCard(index) {
  els.recipeCards.querySelector(`[data-index="${index}"]`)?.focus();
}

function focusSavedCard(id) {
  const index = saved.items.findIndex((item) => item.id === id);
  els.savedCards.querySelectorAll('.recipe-card')[index]?.focus();
}

function showView(view) {
  const isSaved = view === 'saved';
  els.findView.hidden = isSaved;
  els.savedView.hidden = !isSaved;
  els.tabFind.classList.toggle('active', !isSaved);
  els.tabSaved.classList.toggle('active', isSaved);
  if (isSaved) {
    els.tabSaved.setAttribute('aria-current', 'page');
    els.tabFind.removeAttribute('aria-current');
    if (!saved.loaded) loadSaved();
  } else {
    els.tabFind.setAttribute('aria-current', 'page');
    els.tabSaved.removeAttribute('aria-current');
  }
}

// ---------- 2단계: 레시피 요청 ----------
function readPrefs() {
  const form = new FormData(els.prefsForm);
  const prefs = { servings: Number(form.get('servings')), dietary: form.getAll('dietary') };
  if (form.get('maxTimeMinutes')) prefs.maxTimeMinutes = Number(form.get('maxTimeMinutes'));
  if (form.get('difficulty')) prefs.difficulty = form.get('difficulty');
  if (form.get('cuisine')) prefs.cuisine = form.get('cuisine');
  return prefs;
}

function restorePrefs(prefs) {
  if (!prefs) return;
  const form = els.prefsForm.elements;
  form.servings.value = String(prefs.servings ?? 2);
  form.maxTimeMinutes.value = prefs.maxTimeMinutes ? String(prefs.maxTimeMinutes) : '';
  form.difficulty.value = prefs.difficulty ?? '';
  form.cuisine.value = prefs.cuisine ?? '';
  for (const box of els.prefsForm.querySelectorAll('[name=dietary]')) box.checked = prefs.dietary?.includes(box.value);
}

async function generateRecipes({ more }) {
  if (busy) return;
  if (state.ingredients.length > MAX_INGREDIENTS) {
    showAddError(tooManyMessage());
    els.addName.focus();
    return;
  }
  const prefs = readPrefs();
  state.prefs = prefs;
  if (!more) state.seenTitles = [];
  lastRecipeRequest = {
    ingredients: state.ingredients.map((i) => i.name),
    preferences: prefs,
    count: 3,
    excludeTitles: state.seenTitles.slice(-MAX_EXCLUDE),
  };
  await sendRecipeRequest();
}

async function sendRecipeRequest() {
  if (busy || !lastRecipeRequest) return;
  const gen = ++recipeGen;
  recipeAbort = new AbortController();
  els.recipeErrorBox.hidden = true;
  els.recipesSection.hidden = false;
  setBusy('recipes');
  showRecipeLoading(true);
  els.recipesSection.scrollIntoView({ behavior: 'smooth' });

  let ok = false;
  try {
    const data = await requestJson('/api/recipes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastRecipeRequest),
      signal: recipeAbort.signal,
    });
    if (gen !== recipeGen) return; // 그사이 새 사진을 인식했으면 예전 재료로 만든 결과는 버린다
    state.recipes = data.recipes;
    state.seenTitles = [...new Set([...state.seenTitles, ...data.recipes.map((r) => r.title)])];
    state.recipeMeta = `생성 시간 ${(data.elapsedMs / 1000).toFixed(1)}초 · 레시피 ${data.recipes.length}개`;
    ok = true;
  } catch (err) {
    if (gen !== recipeGen) return;
    // 오류가 나도 입력한 조건과 이전 레시피는 그대로 둔다
    els.recipeError.textContent = err.message;
    els.recipeErrorBox.hidden = false;
  } finally {
    if (gen === recipeGen) {
      showRecipeLoading(false);
      setBusy(null);
      commit();
      // 결과로 스크린리더 포커스도 옮긴다 (화면은 이미 스크롤됨)
      if (ok) $('recipes-heading').focus({ preventScroll: true });
    }
  }
}

// 진행 중인 레시피 요청을 무효로 한다 (새 사진 인식 성공 시)
function cancelRecipeRequest() {
  recipeGen++;
  recipeAbort?.abort();
  lastRecipeRequest = null;
  els.recipeErrorBox.hidden = true;
  if (busy === 'recipes') {
    showRecipeLoading(false);
    setBusy(null);
  }
}

// AI 작업 중에는 다른 AI 작업 버튼을 막고, 무엇을 하는 중인지 버튼 글자로도 보여 준다.
// 재료 수정·조건 변경·상세 보기·내 레시피는 계속 쓸 수 있다.
function setBusy(next) {
  busy = next;
  els.recognizeBtn.disabled = Boolean(busy) || !selectedFile;
  els.recognizeBtn.textContent = busy === 'recognize' ? '재료를 찾는 중...' : '재료 인식';
  els.fileInput.disabled = busy === 'recognize';
  els.manualBtn.disabled = busy === 'recognize';
  els.recipeBtn.disabled = els.moreBtn.disabled = els.retryBtn.disabled = Boolean(busy);
  els.recipeBtn.textContent = busy === 'recipes' ? '레시피를 만드는 중...' : '레시피 추천받기';
}

function showAddError(message) {
  els.addError.textContent = message;
  els.addError.hidden = !message;
}

function tooManyMessage() {
  return `재료는 ${MAX_INGREDIENTS}개까지 넣을 수 있어요. 안 쓰는 재료를 ×로 지운 뒤 다시 시도해 주세요.`;
}

// ---------- 이벤트 ----------
els.addCategory.append(...CATEGORIES.map((c) => new Option(c, c)));
els.addCategory.value = '기타';
restorePrefs(state.prefs);

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  showError('');
  selectedFile = null;
  setBusy(busy);
  if (!file) return;
  // 10MB가 넘는 원본도 보통 줄이면 1MB 아래가 되므로, 여기서는 큰 한도만 보고 10MB 검사는 줄인 뒤에 한다
  if (file.size > MAX_ORIGINAL_BYTES) {
    showError('사진이 너무 커요. 50MB 이하의 사진을 골라 주세요.');
    return;
  }
  selectedFile = file;
  URL.revokeObjectURL(els.preview.src);
  els.preview.src = URL.createObjectURL(file);
  els.preview.hidden = false;
  setBusy(busy);
});

els.recognizeBtn.addEventListener('click', async () => {
  if (!selectedFile || busy) return;
  showError('');
  showRecognizeLoading(true);
  setBusy('recognize');
  try {
    const body = new FormData();
    const image = await prepareImage(selectedFile);
    // 브라우저가 줄이지 못하면 원본 그대로이므로 서버 한도(10MB)를 여기서 먼저 확인한다
    if (image.size > MAX_UPLOAD_BYTES) throw new Error('사진이 너무 커요. 10MB 이하의 사진을 골라 주세요.');
    body.append('image', image, 'fridge.jpg');
    const data = await requestJson('/api/ingredients/recognize', { method: 'POST', body });
    // 새 사진이면 이전 레시피와 진행 중이던 레시피 요청은 지운다
    cancelRecipeRequest();
    showAddError('');
    state = {
      ...state,
      ingredients: data.ingredients,
      notes: data.notes,
      meta: `인식 시간 ${(data.elapsedMs / 1000).toFixed(1)}초`,
      recipes: [],
      seenTitles: [],
      recipeMeta: '',
    };
    commit();
    els.resultSection.scrollIntoView({ behavior: 'smooth' });
    $('result-heading').focus({ preventScroll: true });
    if (state.ingredients.length > MAX_INGREDIENTS) showAddError(tooManyMessage());
  } catch (err) {
    showError(err.message);
  } finally {
    showRecognizeLoading(false);
    setBusy(null);
  }
});

els.manualBtn.addEventListener('click', () => {
  state.meta ||= '직접 입력';
  commit();
  els.resultSection.scrollIntoView({ behavior: 'smooth' });
  els.addName.focus();
});

els.addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = els.addName.value.trim();
  if (!name) return;
  if (hasIngredient(name)) {
    showAddError(`'${name}'은(는) 이미 목록에 있어요.`);
    els.addName.select();
    return;
  }
  if (state.ingredients.length >= MAX_INGREDIENTS) {
    showAddError(`재료는 ${MAX_INGREDIENTS}개까지 넣을 수 있어요. 안 쓰는 재료를 ×로 지운 뒤 추가해 주세요.`);
    return;
  }
  showAddError('');
  state.ingredients.push({ name, category: els.addCategory.value, quantity: '', confidence: 1 });
  state.meta ||= '직접 입력';
  els.addName.value = '';
  commit();
  els.addName.focus(); // 여러 재료를 이어서 입력할 수 있게
});
els.addName.addEventListener('input', () => showAddError(''));

els.prefsForm.addEventListener('change', () => {
  state.prefs = readPrefs();
  saveState();
});
els.recipeBtn.addEventListener('click', () => generateRecipes({ more: false }));
els.moreBtn.addEventListener('click', () => generateRecipes({ more: true }));
els.retryBtn.addEventListener('click', () => sendRecipeRequest());

$('dialog-close').addEventListener('click', () => els.dialog.close());
els.saveBtn.addEventListener('click', saveOpenedRecipe);
els.deleteBtn.addEventListener('click', deleteOpenedRecipe);
// 상세 창을 닫으면 카드의 "저장됨" 표시를 갱신한다
els.dialog.addEventListener('close', () => {
  renderRecipes();
  openedRecipe?.restoreFocus?.();
});
els.tabFind.addEventListener('click', () => showView('find'));
els.tabSaved.addEventListener('click', () => showView('saved'));
els.savedMoreBtn.addEventListener('click', () => loadSaved({ more: true }));
$('saved-retry-btn').addEventListener('click', () => loadSaved());
$('saved-empty-btn').addEventListener('click', () => {
  showView('find');
  els.tabFind.focus();
});
$('logout-btn').addEventListener('click', logout);
// 바깥(배경)을 누르면 닫기
els.dialog.addEventListener('click', (e) => {
  if (e.target === els.dialog) els.dialog.close();
});

render();
loadUser();
