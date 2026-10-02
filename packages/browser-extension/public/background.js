// Clicking the toolbar button opens the side panel. Chrome keeps this setting once something sets
// it; this worker runs on install, so it holds before anyone has opened the panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
