const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

const MAPS_SHORT_LINK_RE =
  /^(https?:\/\/)?(share\.google(\.com)?\/[^\s/?#]+|maps\.app\.goo\.gl\/[^\s/?#]+|goo\.gl\/maps\/[^\s/?#]+)/i;

function normalizeShortLinkInput(input) {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function appendLinkCopy(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'maps.app.goo.gl' && !parsed.searchParams.has('link')) {
      parsed.searchParams.set('link', 'copy');
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function decodeGoogleHtmlEscapes(text) {
  return String(text)
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/&amp;/g, '&');
}

function isStillShortLink(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'maps.app.goo.gl'
      || host === 'goo.gl'
      || host === 'share.google'
      || host.endsWith('.share.google');
  } catch {
    return false;
  }
}

function isResolvedMapsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('google.') && parsed.pathname.includes('/maps')) return true;
    if (parsed.hostname.includes('google.') && parsed.pathname.includes('/search') && parsed.searchParams.get('q')) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function extractMapsReferenceFromHtml(html) {
  const decoded = decodeGoogleHtmlEscapes(html);

  const urlMatch = decoded.match(/https:\/\/www\.google\.com\/maps\/[^\s"'<>\\]+/i)
    || decoded.match(/https:\/\/maps\.google\.com\/[^\s"'<>\\]+/i);
  if (urlMatch) return urlMatch[0];

  const searchMatch = decoded.match(/https:\/\/www\.google\.com\/search\?[^\s"'<>\\]+/i);
  if (searchMatch) return searchMatch[0];

  const placeCoords = decoded.match(/!8m2!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (placeCoords) {
    const lat = placeCoords[1];
    const lng = placeCoords[2];
    return `https://www.google.com/maps/@${lat},${lng},17z/data=!3d${lat}!4d${lng}`;
  }

  const staticCenter = decoded.match(/center=(-?\d+(?:\.\d+)?)(?:%2C|,)(-?\d+(?:\.\d+)?)/i);
  if (staticCenter) {
    const lat = staticCenter[1];
    const lng = staticCenter[2];
    return `https://www.google.com/maps/@${lat},${lng},17z/data=!3d${lat}!4d${lng}`;
  }

  return null;
}

async function resolveMapsShortLinkViaFetch(input) {
  let current = appendLinkCopy(normalizeShortLinkInput(input));

  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: FETCH_HEADERS
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('Location') || res.headers.get('location');
      if (!location) break;
      current = new URL(location, current).href;
      continue;
    }

    if (res.ok && isStillShortLink(current)) {
      const html = await res.text();
      const extracted = extractMapsReferenceFromHtml(html);
      if (extracted) return extracted;
    }

    return current;
  }

  return current;
}

function resolveMapsShortLinkViaTab(input) {
  const startUrl = appendLinkCopy(normalizeShortLinkInput(input));

  return new Promise((resolve, reject) => {
    let tabId = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    };

    const finish = (url) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const timer = setTimeout(
      () => fail('Tempo limite ao resolver o link curto.'),
      20000
    );

    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      const url = tab?.url || '';
      if (isResolvedMapsUrl(url)) finish(url);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.create({ url: startUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        fail(chrome.runtime.lastError?.message || 'Não foi possível abrir o link curto.');
        return;
      }
      tabId = tab.id;
      if (tab.url && isResolvedMapsUrl(tab.url)) finish(tab.url);
    });
  });
}

async function resolveMapsShortLink(input) {
  const fetched = await resolveMapsShortLinkViaFetch(input);
  if (isResolvedMapsUrl(fetched) || !isStillShortLink(fetched)) {
    return fetched;
  }
  return resolveMapsShortLinkViaTab(input);
}

globalThis.__icmResolveMapsShortLink = resolveMapsShortLink;
self.__icmResolveMapsShortLink = resolveMapsShortLink;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'RESOLVE_MAPS_SHORT_LINK') {
    const url = message.url?.trim();
    if (!url || !MAPS_SHORT_LINK_RE.test(url)) {
      sendResponse({ success: false, error: 'Link curto inválido.' });
      return false;
    }

    resolveMapsShortLink(url)
      .then((resolvedUrl) => {
        if (isStillShortLink(resolvedUrl) && !isResolvedMapsUrl(resolvedUrl)) {
          sendResponse({
            success: false,
            error: 'Não foi possível extrair a localização deste link curto.'
          });
          return;
        }
        sendResponse({ success: true, resolvedUrl });
      })
      .catch(err => sendResponse({
        success: false,
        error: err?.message || 'Não foi possível resolver o link curto.'
      }));

    return true;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.includes('ingresso.com/filme/')) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const panel = document.getElementById('icm-panel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  } catch (_) {}
});
