// Guard against double-injection
if (window.__ingressoCinemaScraperLoaded) {
  // already loaded, skip
} else {
  window.__ingressoCinemaScraperLoaded = true;

  const TIME_RE = /^\d{2}:\d{2}$/;
  const SESSION_TYPES = ['VIP', 'LASER', 'DUBLADO', 'LEGENDADO', 'NORMAL'];

  // UI button/link texts injected by the page that pollute scraped content
  const UI_NOISE = ['Assentos', 'Preços', 'Detalhes', 'Lembre-me', 'Compartilhar', 'Favoritar'];

  function cleanText(text) {
    let s = text;
    for (const noise of UI_NOISE) s = s.replace(new RegExp(noise, 'gi'), '');
    return s.replace(/\s+/g, ' ').trim();
  }

  // Only the text nodes directly inside el (excludes child element text)
  function getDirectText(el) {
    return Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
  }

  function waitForElements(selector, timeoutMs) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelectorAll(selector);
      if (existing.length > 0) return resolve(existing);

      const observer = new MutationObserver(() => {
        const found = document.querySelectorAll(selector);
        if (found.length > 0) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for: ${selector}`));
      }, timeoutMs);
    });
  }

  // Find the cinema card ancestor of a given element.
  // A card must contain at least one time element AND an address (| separator).
  function findCardAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (node.textContent.includes('|') && hasTimeDescendant(node)) {
        // Make sure this is tight — not the entire page
        const children = node.children.length;
        if (children > 0 && children < 30) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function hasTimeDescendant(el) {
    return Array.from(el.querySelectorAll('*')).some(
      child => TIME_RE.test(child.textContent.trim()) && child.children.length === 0
    );
  }

  function extractCinemaName(card) {
    // Prefer headings — use direct text nodes to avoid picking up sibling button text
    for (const tag of ['h2', 'h3', 'h4', 'h1']) {
      const el = card.querySelector(tag);
      if (el) {
        const direct = getDirectText(el);
        if (direct.length > 3) return direct;
        const cleaned = cleanText(el.textContent.trim());
        if (cleaned.length > 3) return cleaned;
      }
    }
    // Class-based hints
    for (const hint of ['title', 'name', 'cinema', 'theater']) {
      const el = card.querySelector(`[class*="${hint}" i]`);
      if (el) {
        const direct = getDirectText(el);
        if (direct.length > 3) return direct;
      }
    }
    // First child whose cleaned text looks like a name (no | or time)
    for (const child of card.children) {
      const text = cleanText(child.textContent.trim());
      if (text.length > 3 && !text.includes('|') && !TIME_RE.test(text)) return text;
    }
    return null;
  }

  function extractAddress(card) {
    const all = Array.from(card.querySelectorAll('*'));

    // First pass: prefer elements whose OWN text nodes contain |
    for (const el of all) {
      const direct = getDirectText(el);
      if (direct.includes('|') && direct.length > 5 && direct.length < 200) return direct;
    }

    // Second pass: full textContent but clean UI strings and enforce address shape
    for (const el of all) {
      if (!el.textContent.includes('|')) continue;
      const cleaned = cleanText(el.textContent.trim());
      if (cleaned.includes('|') && cleaned.length > 5 && cleaned.length < 200) {
        // Keep only "Street, number | Neighborhood" — cut off after the neighborhood
        const m = cleaned.match(/^(.+?\|[^|]+?)(?:\s{2,}|$)/);
        return m ? m[1].trim() : cleaned;
      }
    }

    return '';
  }

  function extractSessions(card) {
    const allEls = Array.from(card.querySelectorAll('*'));

    // Collect all leaf-level time elements
    const timeEls = allEls.filter(
      el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0
    );
    if (timeEls.length === 0) return [];

    // Collect all badge elements (session type labels)
    const badgeEls = allEls.filter(el => {
      const text = el.textContent.trim().toUpperCase();
      return SESSION_TYPES.includes(text) && el.children.length === 0;
    });

    if (badgeEls.length === 0) {
      // No type badges — return all times as a single "NORMAL" session
      return [{ type: 'NORMAL', times: timeEls.map(el => el.textContent.trim()) }];
    }

    // Group badges + times by finding the common row/container ancestor
    // Strategy: find the closest common parent of all badges; times below that parent
    // that share the same row parent as the badges
    const groups = [];
    const usedTimes = new Set();

    // For each badge, find the times that are siblings or in the same row container
    badgeEls.forEach(badge => {
      const badgeParent = badge.parentElement;
      if (!badgeParent) return;

      // Look for times in the same or next sibling container
      const siblings = [badgeParent, ...Array.from(badgeParent.parentElement?.children || [])];
      const rowTimes = timeEls.filter(t => {
        return siblings.some(s => s.contains(t)) && !usedTimes.has(t);
      });

      if (rowTimes.length > 0) {
        const existing = groups.find(g => g.type === badge.textContent.trim().toUpperCase());
        if (existing) {
          rowTimes.forEach(t => { existing.times.push(t.textContent.trim()); usedTimes.add(t); });
        } else {
          groups.push({ type: badge.textContent.trim().toUpperCase(), times: rowTimes.map(t => t.textContent.trim()) });
          rowTimes.forEach(t => usedTimes.add(t));
        }
      }
    });

    // Any remaining times not yet assigned
    const remainingTimes = timeEls.filter(t => !usedTimes.has(t)).map(t => t.textContent.trim());
    if (remainingTimes.length > 0) {
      // Associate with already-found types or create a generic group
      const firstGroup = groups[0];
      if (firstGroup) firstGroup.times.push(...remainingTimes);
      else groups.push({ type: 'NORMAL', times: remainingTimes });
    }

    return groups.filter(g => g.times.length > 0);
  }

  async function scrapeCinemas() {
    // Wait for session time elements to appear (these are the most reliable signal)
    try {
      await waitForElements('button, [role="button"], span, a', 5000);
    } catch (_) {
      // Proceed anyway — maybe elements are there but selector too broad
    }

    // Find all leaf elements with time text
    const allEls = Array.from(document.body.querySelectorAll('*'));
    const timeLeaves = allEls.filter(
      el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0
    );

    if (timeLeaves.length === 0) {
      throw new Error('Nenhuma sessão encontrada. Verifique se a página carregou completamente.');
    }

    // Collect unique card ancestors
    const cardSet = new Set();
    const cardMap = new Map(); // card element → cinema data

    for (const timeEl of timeLeaves) {
      const card = findCardAncestor(timeEl);
      if (card && !cardSet.has(card)) {
        cardSet.add(card);
        const name = extractCinemaName(card);
        const address = extractAddress(card);
        if (name) {
          cardMap.set(card, { name, address, sessions: [] });
        }
      }
    }

    if (cardMap.size === 0) {
      throw new Error('Não foi possível identificar os cinemas na página.');
    }

    // Extract sessions for each card
    const result = [];
    for (const [card, cinema] of cardMap) {
      cinema.sessions = extractSessions(card);
      result.push(cinema);
    }

    return result;
  }

  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject('Geolocalização não disponível.');
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        err => {
          if (err.code === err.PERMISSION_DENIED)
            reject('Permissão de localização negada pelo site ou pelo navegador.');
          else if (err.code === err.TIMEOUT)
            reject('Tempo limite ao obter localização. Tente novamente.');
          else
            reject('Não foi possível obter sua localização.');
        },
        { timeout: 10000, maximumAge: 300000 }
      );
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'SCRAPE_CINEMAS') {
      scrapeCinemas()
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.action === 'GET_LOCATION') {
      getLocation()
        .then(coords => sendResponse({ success: true, ...coords }))
        .catch(err => sendResponse({ success: false, error: err }));
      return true;
    }
  });
}
