import {
    normalizeSite,
    getSettings,
    isConfigured,
    jiraGet,
    getTemplate,
    normalizeTemplate,
    DEFAULT_TEMPLATE,
    RESULT_COLORS,
    FIELD_KINDS,
    buildSettingsFile,
    parseSettingsFile,
} from './jira.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_KEYS = ['defaultLabels'];

function showResult(kind, text) {
    const el = $('connectResult');
    el.hidden = false;
    el.className = `notice notice--${kind}`;
    el.textContent = text;
}

async function init() {
    const settings = await getSettings();
    $('site').value = settings.site ? new URL(settings.site).host : '';
    $('email').value = settings.email;
    $('token').value = settings.token;
    $('disconnect').hidden = !isConfigured(settings);
    if (!settings.site) $('site').focus();

    const defaults = await chrome.storage.sync.get(DEFAULT_KEYS);
    for (const key of DEFAULT_KEYS) $(key).value = defaults[key] ?? '';

    template = await getTemplate();
    renderTemplate();

    chrome.commands.getAll().then((commands) => {
        $('shortcut').textContent = commands.find((c) => c.name === 'focus-capture')?.shortcut || 'not set';
    });
}

$('connectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const site = normalizeSite($('site').value);
    const email = $('email').value.trim();
    const token = $('token').value.trim();

    const invalid = [
        [!site, 'site', 'Enter your site address, like your-team.atlassian.net.'],
        [!email, 'email', 'Enter the email of your Atlassian account.'],
        [!token, 'token', 'Paste an API token.'],
    ].find(([bad]) => bad);
    for (const id of ['site', 'email', 'token']) $(id).removeAttribute('aria-invalid');
    if (invalid) {
        $(invalid[1]).setAttribute('aria-invalid', 'true');
        $(invalid[1]).focus();
        showResult('bad', invalid[2]);
        return;
    }

    const btn = $('connect');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    showResult('', `Signing in to ${new URL(site).host}...`);
    try {
        const me = await jiraGet('/myself', { site, email, token });
        await chrome.storage.local.set({ jiraSite: site, jiraEmail: email, jiraApiToken: token });
        $('site').value = new URL(site).host;
        $('disconnect').hidden = false;
        showResult('ok', `Connected as ${me.displayName}. Open any page and use Capture bug in the toolbar.`);
    } catch (err) {
        const msg = String(err.message ?? err);
        showResult('bad', msg.includes('Failed to fetch') ? `Could not reach ${new URL(site).host}. Check the address.` : msg);
    } finally {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
    }
});

$('disconnect').addEventListener('click', async () => {
    await chrome.storage.local.remove(['jiraSite', 'jiraEmail', 'jiraApiToken']);
    $('token').value = '';
    $('disconnect').hidden = true;
    showResult('', 'Disconnected. The token was removed from this browser.');
});

const savedTimers = {};
function flashSaved(id) {
    $(id).textContent = 'Saved';
    clearTimeout(savedTimers[id]);
    savedTimers[id] = setTimeout(() => ($(id).textContent = ''), 1500);
}

for (const key of DEFAULT_KEYS) {
    $(key).addEventListener('input', async () => {
        await chrome.storage.sync.set({ [key]: $(key).value });
        flashSaved('defaultsSaved');
    });
}

chrome.storage.sync.get('aiEngine').then(({ aiEngine }) => ($('aiEngine').value = aiEngine ?? 'auto'));
$('aiEngine').addEventListener('change', async () => {
    await chrome.storage.sync.set({ aiEngine: $('aiEngine').value });
    flashSaved('templateSaved');
});

// ---------------------------------------------------------------------------
// Test report template editor: edits `template` in place and saves on every change
// ---------------------------------------------------------------------------

let template = null;
const KIND_LABELS = { text: 'Short text', me: 'Your Jira name', url: 'Tested page link', long: 'Long text', issues: 'List of issues' };
const ICONS = {
    up: '<path d="M12 19V5M6 11l6-6 6 6" />',
    down: '<path d="M12 5v14M6 13l6 6 6-6" />',
    remove: '<path d="M6 6l12 12M18 6L6 18" />',
};

function iconButton(kind, label, onClick, disabled = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>`;
    b.addEventListener('click', onClick);
    return b;
}

function input(value, label, onInput, placeholder = '') {
    const el = document.createElement('input');
    el.className = 'input';
    el.type = 'text';
    el.value = value;
    el.placeholder = placeholder;
    el.autocomplete = 'off';
    el.setAttribute('aria-label', label);
    el.addEventListener('input', () => onInput(el.value));
    return el;
}

function select(options, value, label, onChange) {
    const el = document.createElement('select');
    el.className = 'select';
    el.setAttribute('aria-label', label);
    for (const [v, text] of options) el.add(new Option(text, v, false, v === value));
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

function move(list, i, delta) {
    const [item] = list.splice(i, 1);
    list.splice(i + delta, 0, item);
    renderTemplate();
    saveTemplate();
}

function renderTemplate() {
    $('tplHeading').value = template.heading;
    $('tplResultLabel').value = template.resultLabel;

    $('tplResults').replaceChildren(
        ...template.results.map((result, i) => {
            const row = document.createElement('div');
            row.className = 'tpl-row tpl-row--result';
            const name = result.label || `result ${i + 1}`;
            row.append(
                input(result.label, `Result ${i + 1} name`, (v) => ((result.label = v), saveTemplate())),
                select(RESULT_COLORS.map((c) => [c, `Colour: ${c}`]), result.color, `Colour of ${name}`, (v) => ((result.color = v), saveTemplate())),
                iconButton('remove', `Remove ${name}`, () => {
                    template.results.splice(i, 1);
                    renderTemplate();
                    saveTemplate();
                }, template.results.length === 1),
            );
            return row;
        }),
    );

    $('tplFields').replaceChildren(
        ...template.fields.map((field, i) => {
            const row = document.createElement('div');
            row.className = 'tpl-row';
            const name = field.label || `field ${i + 1}`;
            const autoFilled = field.kind === 'me' || field.kind === 'url';
            const def = input(autoFilled ? '' : field.default, `Default text for ${name}`, (v) => ((field.default = v), saveTemplate()), autoFilled ? 'Filled in for you' : 'Default text (optional)');
            def.disabled = autoFilled;
            const icons = document.createElement('div');
            icons.className = 'icons';
            icons.append(
                iconButton('up', `Move ${name} up`, () => move(template.fields, i, -1), i === 0),
                iconButton('down', `Move ${name} down`, () => move(template.fields, i, 1), i === template.fields.length - 1),
                iconButton('remove', `Remove ${name}`, () => {
                    template.fields.splice(i, 1);
                    renderTemplate();
                    saveTemplate();
                }),
            );
            row.append(
                input(field.label, `Field ${i + 1} name`, (v) => ((field.label = v), saveTemplate())),
                select(FIELD_KINDS.map((k) => [k, KIND_LABELS[k]]), field.kind, `Type of ${name}`, (v) => {
                    field.kind = v;
                    renderTemplate();
                    saveTemplate();
                }),
                def,
                icons,
            );
            return row;
        }),
    );
}

async function saveTemplate() {
    const clean = normalizeTemplate(template);
    $('templateError').hidden = Boolean(clean);
    if (!clean) {
        $('templateError').textContent = 'Give at least one result option a name.';
        return;
    }
    await chrome.storage.sync.set({ reportTemplate: clean });
    flashSaved('templateSaved');
}

$('tplHeading').addEventListener('input', () => ((template.heading = $('tplHeading').value), saveTemplate()));
$('tplResultLabel').addEventListener('input', () => ((template.resultLabel = $('tplResultLabel').value), saveTemplate()));
$('tplAddResult').addEventListener('click', () => {
    template.results.push({ label: '', color: 'neutral' });
    renderTemplate();
    $('tplResults').lastElementChild.querySelector('input').focus();
});
$('tplAddField').addEventListener('click', () => {
    template.fields.push({ label: '', kind: 'text', default: '' });
    renderTemplate();
    $('tplFields').lastElementChild.querySelector('input').focus();
});
$('tplReset').addEventListener('click', () => {
    template = structuredClone(DEFAULT_TEMPLATE);
    renderTemplate();
    saveTemplate();
});

// ---------------------------------------------------------------------------
// Team setup file
// ---------------------------------------------------------------------------

function teamResult(kind, text) {
    $('teamResult').hidden = false;
    $('teamResult').className = `notice notice--${kind}`;
    $('teamResult').textContent = text;
}

$('exportSettings').addEventListener('click', async () => {
    const stored = await chrome.storage.sync.get(['defaultLabels', 'reportTemplate']);
    const file = buildSettingsFile(stored);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'qa-report-settings.json' });
    a.click();
    URL.revokeObjectURL(url);
    teamResult('ok', 'Saved qa-report-settings.json. Send it to your team.');
});

$('importSettings').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    if (!file) return;
    try {
        const values = parseSettingsFile(await file.text());
        await chrome.storage.sync.set(values);
        $('defaultLabels').value = values.defaultLabels;
        template = values.reportTemplate;
        renderTemplate();
        teamResult('ok', `Imported ${file.name}: labels and a report template with ${template.fields.length} fields.`);
    } catch (err) {
        teamResult('bad', String(err.message ?? err));
    }
});

// Chrome lets people rebind extension shortcuts only on its own page.
$('changeShortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

init();
