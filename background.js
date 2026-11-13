import { getSettings, authHeader } from './jira.js';
import { buildHarLog } from './har.js';

const MAX_LOG_ENTRIES = 50;
const consoleLogs = new Map(); // tabId -> entry[]
const networkLogs = new Map(); // tabId -> entry[]
const harRecordings = new Map(); // tabId -> { pending: Map, onEvent }
const captureWindowToTab = new Map(); // windowId -> tabId, to stop a recording when its window closes

chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') chrome.runtime.openOptionsPage();
});

function pushCapped(map, tabId, entry) {
    if (tabId < 0) return;
    const list = map.get(tabId) ?? [];
    list.push(entry);
    if (list.length > MAX_LOG_ENTRIES) list.shift();
    map.set(tabId, list);
}

chrome.tabs.onRemoved.addListener((tabId) => {
    consoleLogs.delete(tabId);
    networkLogs.delete(tabId);
});

chrome.webRequest.onCompleted.addListener(
    (d) => pushCapped(networkLogs, d.tabId, { url: d.url, method: d.method, statusCode: d.statusCode, type: d.type }),
    { urls: ['<all_urls>'] },
);
chrome.webRequest.onErrorOccurred.addListener(
    (d) => pushCapped(networkLogs, d.tabId, { url: d.url, method: d.method, error: d.error, type: d.type }),
    { urls: ['<all_urls>'] },
);

// Records full request/response detail through the DevTools protocol for as long as the capture
// window is open, so the bug can be reproduced again and caught. Chrome shows its "being debugged"
// banner on that one tab meanwhile, and DevTools cannot attach to it at the same time.
async function startHarRecording(tabId) {
    try {
        await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
        return {
            warning: `Network recording skipped: Chrome could not attach to this tab (${err.message ?? err}). If DevTools is open on it, close DevTools and capture again.`,
        };
    }

    const pending = new Map(); // requestId -> partial entry
    const onEvent = (source, method, params) => {
        if (source.tabId !== tabId) return;
        if (method === 'Network.requestWillBeSent') {
            pending.set(params.requestId, {
                request: { method: params.request.method, url: params.request.url, headers: params.request.headers },
                startedMs: params.timestamp * 1000,
                wallTime: params.wallTime * 1000,
            });
            return;
        }
        const entry = pending.get(params.requestId);
        if (!entry) return;
        if (method === 'Network.responseReceived') {
            const { status, statusText, headers, mimeType } = params.response;
            entry.response = { status, statusText, headers, mimeType };
        } else if (method === 'Network.loadingFinished') {
            entry.finishedMs = params.timestamp * 1000;
            entry.bodySize = params.encodedDataLength;
            entry.requestId = params.requestId;
        } else if (method === 'Network.loadingFailed') {
            entry.failed = true;
            entry.errorText = params.errorText;
            entry.finishedMs = params.timestamp * 1000;
        }
    };

    chrome.debugger.onEvent.addListener(onEvent);
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    harRecordings.set(tabId, { pending, onEvent });
    return { warning: null };
}

// Safe to call twice: the create path and the window-closed safety net can both reach it.
async function stopHarRecording(tabId) {
    const recording = harRecordings.get(tabId);
    if (!recording) return null;
    harRecordings.delete(tabId);
    chrome.debugger.onEvent.removeListener(recording.onEvent);

    const requests = Array.from(recording.pending.values());
    for (const entry of requests) {
        if (!entry.requestId || !entry.response) continue;
        try {
            const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: entry.requestId });
            entry.bodyText = body.base64Encoded ? undefined : body.body;
        } catch {
            // body no longer available (streamed, evicted or binary): the HAR spec allows leaving it out
        }
    }
    try {
        await chrome.debugger.detach({ tabId });
    } catch {
        // already detached, e.g. the tab was closed mid-recording
    }
    return buildHarLog(requests, { creatorVersion: chrome.runtime.getManifest().version });
}

chrome.windows.onRemoved.addListener((windowId) => {
    const tabId = captureWindowToTab.get(windowId);
    if (tabId == null) return;
    captureWindowToTab.delete(windowId);
    stopHarRecording(tabId).catch(() => {});
});

// Looked up live, not kept in a variable: the service worker is torn down between capture and refocus.
// Matched by prefix because report.html opens with a ?from= query.
async function findWindowId(page = 'capture.html') {
    try {
        const pageUrl = chrome.runtime.getURL(page);
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
        const context = contexts.find((c) => c.documentUrl?.startsWith(pageUrl));
        return context?.windowId >= 0 ? context.windowId : null;
    } catch {
        return null;
    }
}

async function focusWindow(page) {
    const windowId = await findWindowId(page);
    if (windowId === null) return false;
    const win = await chrome.windows.get(windowId);
    await chrome.windows.update(windowId, { focused: true, drawAttention: true, ...(win.state === 'minimized' && { state: 'normal' }) });
    return true;
}

chrome.commands.onCommand.addListener((command) => {
    if (command === 'focus-capture') focusWindow().catch(() => {});
});

async function handleCapture(tabId, includeNetwork, includeVideo) {
    const tab = await chrome.tabs.get(tabId);
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const har = includeNetwork ? await startHarRecording(tabId) : { warning: null };

    const draft = {
        tabId,
        screenshot,
        url: tab.url,
        title: tab.title,
        viewport: tab.width && tab.height ? `${tab.width} x ${tab.height}` : '',
        capturedAt: new Date().toISOString(),
        consoleLogs: consoleLogs.get(tabId) ?? [],
        networkLogs: includeNetwork ? (networkLogs.get(tabId) ?? []) : [],
        harRecording: includeNetwork && !har.warning,
        harWarning: har.warning,
        includeVideo,
    };
    await chrome.storage.session.set({ bugDraft: draft });
    const win = await chrome.windows.create({ url: 'capture.html', type: 'popup', width: 1240, height: 960 });
    if (draft.harRecording) captureWindowToTab.set(win.id, tabId);
    return { ok: true };
}

// ADF media nodes need the Media API file id, not the attachment id. Jira redirects
// /attachment/content/{id} to https://api.media.atlassian.com/file/{mediaId}/binary; fetch() cannot
// read a redirect's Location, so webRequest.onBeforeRedirect reads it and the download is aborted.
async function resolveMediaId(attachmentId) {
    const { site, email, token } = await getSettings();
    const contentUrl = `${site}/rest/api/3/attachment/content/${attachmentId}`;
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            chrome.webRequest.onBeforeRedirect.removeListener(listener);
            controller.abort();
            reject(new Error('Timed out waiting for the attachment redirect'));
        }, 10000);

        function listener(details) {
            if (details.url !== contentUrl) return;
            clearTimeout(timeout);
            chrome.webRequest.onBeforeRedirect.removeListener(listener);
            controller.abort();
            const match = details.redirectUrl.match(/\/file\/([0-9a-f-]{36})\//);
            if (match) resolve(match[1]);
            else reject(new Error(`No media id in redirect: ${details.redirectUrl}`));
        }
        chrome.webRequest.onBeforeRedirect.addListener(listener, { urls: [contentUrl] });
        fetch(contentUrl, { headers: { Authorization: authHeader(email, token) }, signal: controller.signal }).catch(() => {});
    });
}

function reply(promise, sendResponse) {
    promise.then(sendResponse).catch((err) => sendResponse({ error: String(err.message ?? err) }));
    return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'CONSOLE_ENTRY':
            if (sender.tab) pushCapped(consoleLogs, sender.tab.id, message.entry);
            return false;
        // focus:false asks whether the window exists, focus:true raises it.
        case 'WINDOW':
            return reply(
                (message.focus ? focusWindow(message.page) : findWindowId(message.page).then((id) => id !== null)).then((open) => ({ open })),
                sendResponse,
            );
        case 'CAPTURE':
            return reply(handleCapture(message.tabId, message.includeNetwork, message.includeVideo), sendResponse);
        case 'STOP_HAR':
            return reply(stopHarRecording(message.tabId).then((har) => ({ har })), sendResponse);
        case 'RESOLVE_MEDIA_ID':
            return reply(resolveMediaId(message.attachmentId).then((mediaId) => ({ mediaId })), sendResponse);
        default:
            return false;
    }
});
