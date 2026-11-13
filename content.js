// Isolated-world half of console capture, injected at document_start in every frame. Receives the
// page's console calls from console-hook.js and catches uncaught errors and failed resource loads.
(() => {
    // all_frames: entries from iframes (chat widgets, tag managers) are tagged so they do not read as top-frame errors.
    const framePrefix = window === window.top ? '' : `[iframe ${window.location.hostname}] `;

    function report(level, message) {
        try {
            chrome.runtime.sendMessage({ type: 'CONSOLE_ENTRY', entry: { level, message: framePrefix + message, time: Date.now() } });
        } catch {
            // extension context invalidated, e.g. the extension was reloaded
        }
    }

    window.addEventListener('qa-report:console', (e) => report(e.detail?.level === 'warn' ? 'warn' : 'error', String(e.detail?.message ?? '')));

    // Capture phase: a failed <script>/<img>/<link> fires 'error' on the element and never bubbles to window.
    window.addEventListener(
        'error',
        (event) => {
            const target = event.target;
            if (target && target !== window && ('src' in target || 'href' in target)) {
                report('error', `Failed to load resource: ${target.src || target.href || target.tagName}`);
            } else {
                report('error', event.message);
            }
        },
        true,
    );
    window.addEventListener('unhandledrejection', (event) => report('error', `Unhandled rejection: ${event.reason}`));
})();
