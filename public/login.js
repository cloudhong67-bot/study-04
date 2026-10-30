// 로그인 / 회원가입 화면. 성공하면 서버가 세션 쿠키(HttpOnly)를 심고, 메인 화면으로 이동한다.
const $ = (id) => document.getElementById(id);
const els = {
  tabLogin: $('tab-login'),
  tabSignup: $('tab-signup'),
  form: $('auth-form'),
  email: $('email'),
  password: $('password'),
  confirmRow: $('confirm-row'),
  confirm: $('password-confirm'),
  hint: $('password-hint'),
  error: $('auth-error'),
  submit: $('submit-btn'),
};

let mode = 'login';

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  els.tabLogin.classList.toggle('active', !signup);
  els.tabSignup.classList.toggle('active', signup);
  for (const [tab, selected] of [[els.tabLogin, !signup], [els.tabSignup, signup]]) {
    tab.setAttribute('aria-selected', String(selected));
    // 탭 목록 안에서는 선택된 탭만 Tab 키로 들어가고, 나머지는 화살표로 옮긴다 (WAI-ARIA 탭 패턴)
    tab.tabIndex = selected ? 0 : -1;
    if (selected) tab.setAttribute('aria-controls', 'auth-form');
    else tab.removeAttribute('aria-controls');
  }
  els.form.setAttribute('aria-labelledby', signup ? 'tab-signup' : 'tab-login');
  els.confirmRow.hidden = !signup;
  els.hint.hidden = !signup;
  els.password.autocomplete = signup ? 'new-password' : 'current-password';
  els.submit.textContent = signup ? '가입하고 시작하기' : '로그인';
  showError('');
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

// 문제가 있으면 [문구, 고칠 입력칸]을 돌려준다. 그 칸으로 포커스를 옮겨 바로 고칠 수 있게 한다.
function validate() {
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email) return ['이메일을 입력해 주세요.', els.email];
  if (!els.email.checkValidity()) return ['이메일 형식이 올바르지 않아요. 예: name@example.com', els.email];
  if (!password) return ['비밀번호를 입력해 주세요.', els.password];
  if (mode === 'signup') {
    if (password.length < 8) return ['비밀번호는 8자 이상으로 입력해 주세요.', els.password];
    if (password !== els.confirm.value) return ['비밀번호 확인이 위와 달라요. 같은 비밀번호를 한 번 더 입력해 주세요.', els.confirm];
  }
  return null;
}

els.tabLogin.addEventListener('click', () => setMode('login'));
els.tabSignup.addEventListener('click', () => setMode('signup'));
// 탭 두 개뿐이라 좌우·Home·End 모두 "다른 탭으로" 옮기고 바로 선택한다
els.tabLogin.parentElement.addEventListener('keydown', (e) => {
  const keys = { ArrowLeft: null, ArrowRight: null, Home: 'login', End: 'signup' };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const next = keys[e.key] ?? (mode === 'login' ? 'signup' : 'login');
  setMode(next);
  (next === 'signup' ? els.tabSignup : els.tabLogin).focus();
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const problem = validate();
  if (problem) {
    showError(problem[0]);
    problem[1].focus();
    return;
  }
  showError('');
  els.submit.disabled = true;
  els.submit.textContent = mode === 'signup' ? '가입하는 중...' : '로그인하는 중...';
  try {
    let res;
    try {
      res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: els.email.value.trim(), password: els.password.value }),
      });
    } catch {
      throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message ?? (res.status >= 500
        ? '서버에 잠시 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
        : '요청을 처리하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.'));
    }
    // 이전 사용자의 화면 상태가 남지 않도록 비운다
    sessionStorage.clear();
    location.replace('/');
  } catch (err) {
    showError(err.message);
    els.password.select();
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = mode === 'signup' ? '가입하고 시작하기' : '로그인';
  }
});

setMode(location.hash === '#signup' ? 'signup' : 'login');
els.email.focus();
