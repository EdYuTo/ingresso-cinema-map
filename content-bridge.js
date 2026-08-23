(function () {
  'use strict';

  const REQUEST = 'icm-resolve-short-link-request';
  const RESPONSE = 'icm-resolve-short-link-response';

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== REQUEST) return;

    const { requestId, url } = event.data;
    chrome.runtime.sendMessage({ action: 'RESOLVE_MAPS_SHORT_LINK', url }, (resp) => {
      window.postMessage({
        type: RESPONSE,
        requestId,
        resp,
        error: chrome.runtime.lastError?.message || null
      }, '*');
    });
  });
})();
