// Clicking the toolbar button opens the side panel. Chrome remembers this setting, but only once
// something has set it; from the panel page that happened only after someone found the panel through
// Chrome's side panel menu, so a fresh install's button did nothing. This worker runs on install.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
