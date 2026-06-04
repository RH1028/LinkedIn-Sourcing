// LinkedIn Sourcing PoC — content script
// Goal: prove we can read Sales Nav search results from a Chrome Extension context.

async function scrollAndExtract() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Sales Nav lazy-loads result cards as they enter viewport.
  // Scroll each <li> into view to force render, twice for safety.
  const lis = document.querySelectorAll('main ol li');
  for (const li of lis) {
    li.scrollIntoView({ block: 'center' });
    await sleep(120);
  }
  await sleep(400);
  window.scrollTo(0, 0);
  await sleep(200);
  for (const li of lis) {
    li.scrollIntoView({ block: 'center' });
    await sleep(80);
  }
  await sleep(300);

  // Extract via Sales Nav's data-anonymize attributes (validated stable selectors).
  const results = [];
  const names = document.querySelectorAll('[data-anonymize="person-name"]');
  for (const nameEl of names) {
    let row = nameEl;
    for (let i = 0; i < 10; i++) {
      row = row.parentElement;
      if (!row || row.tagName === 'LI') break;
    }
    if (!row) continue;
    const linkEl = row.querySelector('a[href*="/sales/lead/"]');
    const get = (sel) => {
      const el = row.querySelector(sel);
      return el ? el.innerText.trim() : '';
    };
    results.push({
      name: nameEl.innerText.trim(),
      url: linkEl ? linkEl.href.split('?')[0] : '',
      title: get('[data-anonymize="title"]'),
      company: get('[data-anonymize="company-name"]'),
      location: get('[data-anonymize="location"]'),
      tenure: get('[data-anonymize="job-title"]'),
      blurb: get('[data-anonymize="person-blurb"]').replace(/\s*…\s*Show more\s*$/, ''),
    });
  }
  return results;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === 'scan') {
    scrollAndExtract()
      .then((results) => {
        console.group('🔍 LinkedIn Sourcing PoC');
        console.log(`✅ Found ${results.length} candidates on this page`);
        if (results.length) console.table(results.slice(0, 5));
        console.log('Full results:', results);
        console.groupEnd();
        sendResponse({ ok: true, count: results.length, results });
      })
      .catch((err) => {
        console.error('Scan failed:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep message channel open for async sendResponse
  }
});

console.log('🟢 LinkedIn Sourcing PoC content script loaded — click extension icon → Scan.');
