// Runs in the page's own world (manifest "world": "MAIN"): a content script's isolated world has its
// own `console`, so only a hook here sees the page's console.error/warn calls. Hands each entry to
// content.js through a DOM event, which both worlds share.
(() => {
    for (const level of ['error', 'warn']) {
        const original = console[level];
        console[level] = function (...args) {
            try {
                const message = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'object' ? safeJson(a) : String(a))).join(' ');
                window.dispatchEvent(new CustomEvent('qa-report:console', { detail: { level, message } }));
            } catch {
                // never break the page's own logging
            }
            return original.apply(this, args);
        };
    }
    function safeJson(value) {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
})();
