// Plain Node self-check for HAR construction — fabricated CDP-shaped events, no chrome.* APIs.
// Run with: node tools/chrome-bug-capture/har.test.mjs
import assert from 'node:assert';
import { buildHarLog } from './har.js';

const requests = [
    {
        request: { method: 'GET', url: 'https://shop.example/api/games', headers: { Accept: 'application/json' } },
        response: { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, mimeType: 'application/json' },
        startedMs: 1000,
        finishedMs: 1240,
        bodyText: '{"games":[]}',
        bodySize: 13,
    },
    {
        // never got a response (e.g. capture window ended mid-flight) — must be dropped, not
        // emitted as a broken HAR entry with a null response.
        request: { method: 'GET', url: 'https://shop.example/still-loading' },
        response: null,
    },
    {
        request: { method: 'GET', url: 'https://shop.example/broken' },
        response: { status: 0, statusText: '', headers: {} },
        failed: true,
        errorText: 'net::ERR_CONNECTION_RESET',
        startedMs: 500,
        finishedMs: 520,
    },
    {
        // static noise — must be filtered out entirely, not just kept with an empty body
        request: { method: 'GET', url: 'https://shop.example/app-static/chunks/widget.js' },
        response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/javascript' },
        startedMs: 100,
        finishedMs: 150,
    },
    {
        request: { method: 'GET', url: 'https://shop.example/styles/main.css' },
        response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/css' },
        startedMs: 100,
        finishedMs: 150,
    },
    {
        request: { method: 'GET', url: 'https://shop.example/img/logo.png' },
        response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'image/png' },
        startedMs: 100,
        finishedMs: 150,
    },
];

const har = buildHarLog(requests);

assert.strictEqual(har.log.version, '1.2');
assert.strictEqual(har.log.entries.length, 2, 'requests without a response, and static JS/CSS/image noise, must be dropped');

const [ok, failed] = har.log.entries;
assert.strictEqual(ok.request.url, 'https://shop.example/api/games');
assert.strictEqual(ok.response.status, 200);
assert.strictEqual(ok.time, 240);
assert.deepStrictEqual(ok.request.headers, [{ name: 'Accept', value: 'application/json' }]);
assert.strictEqual(ok.response.content.text, '{"games":[]}');

assert.strictEqual(failed._failed, true);
assert.strictEqual(failed._errorText, 'net::ERR_CONNECTION_RESET');

assert.ok(
    !har.log.entries.some((e) => e.request.url.endsWith('.js') || e.request.url.endsWith('.css') || e.request.url.endsWith('.png')),
    'no static asset URLs should survive into the HAR',
);

console.log('har.test.mjs: OK');
