const $ = id => document.getElementById(id);
let isSetup = false;
function showNotice(message, success = false) { const el = $('notice'); el.textContent = message; el.classList.remove('hidden', 'success'); if (success) el.classList.add('success'); }
async function init() {
  try {
    const me = await fetch('/api/auth/me');
    if (me.ok) { location.replace('/operator'); return; }
    const response = await fetch('/api/auth/status');
    const status = await response.json();
    isSetup = !status.configured;
    if (isSetup) {
      $('formKicker').textContent = 'FIRST-RUN SECURITY SETUP';
      $('formTitle').textContent = 'Create your admin.';
      $('formSubtitle').textContent = 'Set up the first operator account to secure this production workspace.';
      $('submitText').textContent = 'Create administrator account';
      $('password').autocomplete = 'new-password';
      $('password').placeholder = 'At least 12 characters';
      $('passwordHint').classList.remove('hidden');
      $('passwordLabel').textContent = 'Create password';
    }
  } catch { showNotice('The server is not reachable. Start BGMI Broadcast and reload this page.'); }
}
$('togglePassword').addEventListener('click', () => { const field = $('password'); const show = field.type === 'password'; field.type = show ? 'text' : 'password'; $('togglePassword').textContent = show ? 'Hide' : 'Show'; });
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('username').value.trim(), password = $('password').value;
  $('submitBtn').disabled = true; $('submitText').textContent = isSetup ? 'Creating secure account…' : 'Signing in…';
  $('notice').classList.add('hidden');
  try {
    const response = await fetch(isSetup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const result = await response.json();
    if (!response.ok) {
      if (result.setupRequired) { isSetup = true; await init(); }
      showNotice(result.error || 'Could not sign in. Try again.');
      return;
    }
    showNotice(isSetup ? 'Administrator created. Opening the production dashboard…' : 'Signed in. Opening the production dashboard…', true);
    location.replace(result.redirect || '/operator');
  } catch { showNotice('Could not reach the server. Check that BGMI Broadcast is running.'); }
  finally { $('submitBtn').disabled = false; $('submitText').textContent = isSetup ? 'Create administrator account' : 'Sign in to dashboard'; }
});
init();
