import { getSettings, isConfigured } from './jira.js';

const $ = (id) => document.getElementById(id);
const captureBtn = $('capture');
const reportBtn = $('report');
const includeNetwork = $('includeNetwork');
const includeVideo = $('includeVideo');
let devtoolsAttached = false;
let captureOpen = false;
let reportOpen = false;

function updateDevtoolsWarning() {
    $('devtoolsWarning').hidden = captureOpen || !includeNetwork.checked || !devtoolsAttached;
}

async function init() {
    const settings = await getSettings();
    chrome.commands.getAll().then((commands) => {
        $('shortcut').textContent = commands.find((c) => c.name === 'focus-capture')?.shortcut || 'not set';
    });

    if (!isConfigured(settings)) {
        $('setup').hidden = false;
        $('openSetup').addEventListener('click', () => {
            chrome.runtime.openOptionsPage();
            window.close();
        });
        return;
    }
    $('ready').hidden = false;
    $('site').textContent = new URL(settings.site).host;

    const defaults = await chrome.storage.sync.get(['includeNetworkDefault', 'includeVideoDefault']);
    includeNetwork.checked = Boolean(defaults.includeNetworkDefault);
    includeVideo.checked = Boolean(defaults.includeVideoDefault);
    includeNetwork.addEventListener('change', updateDevtoolsWarning);

    // chrome.debugger cannot attach while DevTools is open on the tab: warn before the capture.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        const targets = await chrome.debugger.getTargets();
        devtoolsAttached = targets.some((t) => t.tabId === tab.id && t.attached);
    }

    // One capture window at a time: the draft lives in one session key, a second capture would overwrite it.
    captureOpen = (await chrome.runtime.sendMessage({ type: 'WINDOW', focus: false }))?.open;
    if (captureOpen) {
        captureBtn.textContent = 'Back to the open bug';
        document.querySelector('.popup__options').hidden = true;
    }
    reportOpen = (await chrome.runtime.sendMessage({ type: 'WINDOW', page: 'report.html', focus: false }))?.open;
    if (reportOpen) reportBtn.textContent = 'Back to the open report';
    updateDevtoolsWarning();
}

captureBtn.addEventListener('click', async () => {
    if (captureOpen) {
        await chrome.runtime.sendMessage({ type: 'WINDOW', focus: true });
        window.close();
        return;
    }
    captureBtn.disabled = true;
    captureBtn.setAttribute('aria-busy', 'true');
    $('status').textContent = 'Capturing…';
    await chrome.storage.sync.set({ includeNetworkDefault: includeNetwork.checked, includeVideoDefault: includeVideo.checked });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.runtime.sendMessage({
        type: 'CAPTURE',
        tabId: tab.id,
        includeNetwork: includeNetwork.checked,
        includeVideo: includeVideo.checked,
    });
    if (res?.ok) {
        window.close();
        return;
    }
    $('status').textContent = res?.error?.includes('Cannot access') || res?.error?.includes('chrome://')
        ? 'Chrome does not allow capturing this page. Try it on a regular website.'
        : (res?.error ?? 'Capture failed.');
    $('status').className = 'status status--bad';
    captureBtn.disabled = false;
    captureBtn.removeAttribute('aria-busy');
});

// The tab's URL tells the report which issue to comment on, or which app was tested.
reportBtn.addEventListener('click', async () => {
    if (reportOpen) {
        await chrome.runtime.sendMessage({ type: 'WINDOW', page: 'report.html', focus: true });
        window.close();
        return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.windows.create({ url: `report.html?from=${encodeURIComponent(tab?.url ?? '')}`, type: 'popup', width: 820, height: 900 });
    window.close();
});

init();
