// The service worker does one thing: the toolbar action opens the side panel. Sign-in runs in the
// panel itself (chrome.identity is available to every extension page).
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
