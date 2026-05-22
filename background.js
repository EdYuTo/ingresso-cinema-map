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
