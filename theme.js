// Shared dark/light toggle for the extension pages. Add `<script src="theme.js" type="module">` and,
// for a visible switch, a `#themeToggle` button. The choice is kept in chrome.storage.sync and
// defaults to the OS preference.

const THEME_KEY = 'theme';

function systemPrefersDark() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function apply(theme) {
    document.documentElement.dataset.theme = theme;
    const toggle = document.getElementById('themeToggle');
    toggle?.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}

async function init() {
    const { theme } = await chrome.storage.sync.get(THEME_KEY);
    apply(theme ?? (systemPrefersDark() ? 'dark' : 'light'));

    document.getElementById('themeToggle')?.addEventListener('click', async () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        apply(next);
        await chrome.storage.sync.set({ [THEME_KEY]: next });
    });
}

init();
