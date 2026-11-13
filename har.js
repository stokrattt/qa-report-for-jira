// Builds a minimal, valid HAR 1.2 log from accumulated Chrome DevTools Protocol Network
// domain events (see background.js#startHarRecording/stopHarRecording). Pure — no chrome.*
// APIs — so the parsing/shape logic is unit-testable without a browser.

// Static asset types dropped from the HAR — scripts/styles/fonts/images rarely matter for
// reproducing a functional bug, and a modern SPA can load hundreds of JS chunks alone.
// Adjust this list if you want e.g. images kept in.
const EXCLUDED_MIME_TYPES = [
    'application/javascript',
    'text/javascript',
    'application/x-javascript',
    'text/css',
    'font/woff',
    'font/woff2',
    'application/font-woff',
    'application/font-woff2',
    'application/vnd.ms-fontobject',
    'font/ttf',
    'font/otf',
];

function isExcludedMimeType(mimeType) {
    if (!mimeType) return false;
    return EXCLUDED_MIME_TYPES.includes(mimeType) || mimeType.startsWith('image/');
}

export function buildHarLog(requests, { creatorName = 'QA Report for Jira', creatorVersion = '0.1.0' } = {}) {
    const entries = requests
        .filter((r) => r.request && r.response)
        .filter((r) => !isExcludedMimeType(r.response.mimeType))
        .map(toHarEntry);
    return {
        log: {
            version: '1.2',
            creator: { name: creatorName, version: creatorVersion },
            entries,
        },
    };
}

function toHarEntry(r) {
    const time = r.startedMs != null && r.finishedMs != null ? Math.max(0, r.finishedMs - r.startedMs) : -1;
    return {
        startedDateTime: new Date(r.wallTime ?? Date.now()).toISOString(),
        time,
        request: {
            method: r.request.method,
            url: r.request.url,
            httpVersion: 'HTTP/1.1',
            headers: headersToArray(r.request.headers),
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: -1,
        },
        response: {
            status: r.response.status ?? 0,
            statusText: r.response.statusText ?? '',
            httpVersion: 'HTTP/1.1',
            headers: headersToArray(r.response.headers),
            cookies: [],
            content: {
                size: r.bodySize ?? 0,
                mimeType: r.response.mimeType ?? 'application/octet-stream',
                text: r.bodyText,
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: r.bodySize ?? -1,
        },
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
        ...(r.failed ? { _failed: true, _errorText: r.errorText } : {}),
    };
}

function headersToArray(headersObj) {
    return Object.entries(headersObj ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}
