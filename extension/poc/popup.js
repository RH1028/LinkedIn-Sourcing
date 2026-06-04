document.getElementById('scan').addEventListener('click', async () => {
  const btn = document.getElementById('scan');
  const out = document.getElementById('out');
  btn.disabled = true;
  out.textContent = 'Scanning… (may take 5–10s while results lazy-load)';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://www.linkedin.com/sales/search/')) {
    out.innerHTML =
      '<span class="err">❌ Open a Sales Navigator search page first.</span>';
    btn.disabled = false;
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'scan' });
    if (res?.ok) {
      const top = res.results
        .slice(0, 5)
        .map(
          (r) =>
            `<li><b>${escapeHTML(r.name)}</b> — ${escapeHTML(r.title) || '(no title)'} @ ${escapeHTML(r.company) || '(no company)'}</li>`,
        )
        .join('');
      out.innerHTML = `<span class="ok">✅ Found ${res.count} candidates</span>${top ? `<ul>${top}</ul>` : ''}`;
    } else {
      out.innerHTML = `<span class="err">❌ ${escapeHTML(res?.error || 'Unknown error')}</span>`;
    }
  } catch (err) {
    out.innerHTML = `<span class="err">❌ ${escapeHTML(err.message)}<br><br>If this says "Could not establish connection", reload the LinkedIn tab once after loading the extension.</span>`;
  } finally {
    btn.disabled = false;
  }
});

function escapeHTML(s) {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
