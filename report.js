import {
    getTemplate,
    buildTestReportADF,
    issueKeyFromUrl,
    getSettings,
    isConfigured,
    jiraGet,
    jiraSend,
    uploadAttachment,
    mapLimit,
} from './jira.js';

// Text is kept as a draft; File objects cannot go into chrome.storage, so files are re-added.
const DRAFT_KEY = 'testReportDraft';
const $ = (id) => document.getElementById(id);
const el = { issueKey: $('issueKey'), summary: $('summary'), result: $('result') };
const files = [];
let pastedCount = 0;
let settings = null;
let template = null;
let valueInputs = []; // one input per template field, in template order

function setStatus(text, kind = '') {
    $('status').textContent = text;
    $('status').className = `status${kind ? ` status--${kind}` : ''}`;
}

// A draft only fits the template it was written against.
const templateSignature = () => template.fields.map((f) => `${f.kind}:${f.label}`).join('|');

const readForm = () => ({
    issueKey: el.issueKey.value.trim(),
    summary: el.summary.value.trim(),
    result: Number(el.result.value),
    values: valueInputs.map((input) => input.value.trim()),
});
const saveDraft = () => template && chrome.storage.local.set({ [DRAFT_KEY]: { ...readForm(), signature: templateSignature() } });

function renderTemplate() {
    $('resultLabel').textContent = template.resultLabel;
    el.result.replaceChildren(...template.results.map((r, i) => new Option(r.label, String(i))));
    valueInputs = template.fields.map((field, i) => {
        const wrap = document.createElement('div');
        const multiline = field.kind === 'long' || field.kind === 'issues';
        wrap.className = `field${multiline ? ' field--wide' : ''}`;
        const label = document.createElement('label');
        label.htmlFor = `value-${i}`;
        label.textContent = field.label;
        const input = document.createElement(multiline ? 'textarea' : 'input');
        input.id = `value-${i}`;
        input.className = multiline ? 'textarea' : field.kind === 'url' ? 'input input--mono' : 'input';
        if (field.kind === 'url') input.type = 'url';
        if (field.kind === 'issues') input.placeholder = 'One per line. Issue keys become links.';
        input.autocomplete = field.kind === 'me' ? 'name' : 'off';
        wrap.append(label, input);
        $('templateFields').append(wrap);
        return input;
    });
}

async function loadIssue() {
    const key = el.issueKey.value.trim().toUpperCase();
    if (!key) return;
    el.issueKey.value = key;
    setStatus(`Loading ${key}...`);
    try {
        const { fields } = await jiraGet(`/issue/${encodeURIComponent(key)}?fields=summary`);
        el.summary.value = fields.summary ?? '';
        setStatus('');
        saveDraft();
    } catch (err) {
        setStatus(String(err.message ?? err), 'bad');
    }
}

// The report is usually written from the Jira tab, so the app under test is the tab used just before.
async function lastAppTabUrl() {
    const tabs = await chrome.tabs.query({});
    const appTabs = tabs.filter((t) => /^https?:/.test(t.url ?? '') && new URL(t.url).origin !== settings.site);
    appTabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return appTabs[0]?.url ?? '';
}

function renderFiles() {
    $('fileList').replaceChildren(
        ...files.map((file, i) => {
            const li = document.createElement('li');
            const name = document.createElement('span');
            name.textContent = `${file.name}, ${Math.ceil(file.size / 1024)} KB`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'icon-btn';
            remove.setAttribute('aria-label', `Remove ${file.name}`);
            remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>';
            remove.addEventListener('click', () => {
                files.splice(i, 1);
                renderFiles();
            });
            li.append(name, remove);
            return li;
        }),
    );
}

function addFiles(list) {
    files.push(...list);
    renderFiles();
}

// A video embed only renders with its real size, so read it from the file.
async function mediaSize(file) {
    try {
        if (file.type.startsWith('image/')) {
            const bitmap = await createImageBitmap(file);
            return { width: bitmap.width, height: bitmap.height };
        }
        if (file.type.startsWith('video/')) {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.src = URL.createObjectURL(file);
            await new Promise((resolve, reject) => {
                video.onloadedmetadata = resolve;
                video.onerror = reject;
            });
            URL.revokeObjectURL(video.src);
            return { width: video.videoWidth, height: video.videoHeight };
        }
    } catch {
        // unreadable media is embedded without a size
    }
    return {};
}

async function uploadEvidence(issueKey, file) {
    const attachment = await uploadAttachment(issueKey, file, file.name);
    if (!/^(image|video)\//.test(file.type)) return attachment;
    const [resolved, size] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'RESOLVE_MEDIA_ID', attachmentId: attachment.id }).catch(() => null),
        mediaSize(file),
    ]);
    return { ...attachment, mediaId: resolved?.mediaId, ...size };
}

// Reuses the tab the issue is open in; Jira scrolls to focusedCommentId.
async function openComment(issueKey, commentId) {
    const url = `${settings.site}/browse/${issueKey}?focusedCommentId=${commentId}`;
    const tabs = await chrome.tabs.query({ url: `${settings.site}/*` });
    const issueTab = tabs.find((t) => issueKeyFromUrl(t.url, settings.site) === issueKey);
    if (issueTab) {
        await chrome.tabs.update(issueTab.id, { url, active: true });
        await chrome.windows.update(issueTab.windowId, { focused: true });
        return;
    }
    try {
        const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
        await chrome.tabs.create({ windowId: win.id, url });
        await chrome.windows.update(win.id, { focused: true });
    } catch {
        await chrome.windows.create({ url });
    }
}

async function init() {
    settings = await getSettings();
    if (!isConfigured(settings)) {
        setStatus('QA Report is not connected to Jira yet. Open Settings from the toolbar popup.', 'bad');
        $('send').disabled = true;
        return;
    }
    template = await getTemplate();
    renderTemplate();
    const from = new URLSearchParams(location.search).get('from') ?? '';
    const keyFromTab = issueKeyFromUrl(from, settings.site);
    const { [DRAFT_KEY]: draft } = await chrome.storage.local.get(DRAFT_KEY);
    const kinds = template.fields.map((f) => f.kind);

    if (draft && draft.signature === templateSignature() && (!keyFromTab || draft.issueKey === keyFromTab)) {
        el.issueKey.value = draft.issueKey ?? '';
        el.summary.value = draft.summary ?? '';
        el.result.value = String(draft.result ?? 0);
        valueInputs.forEach((input, i) => (input.value = draft.values?.[i] ?? ''));
    } else {
        valueInputs.forEach((input, i) => (input.value = template.fields[i].default));
        let pageUrl = /^https?:/.test(from) && !keyFromTab ? from : '';
        if (keyFromTab) {
            el.issueKey.value = keyFromTab;
            await loadIssue();
            pageUrl = await lastAppTabUrl();
        }
        kinds.forEach((kind, i) => kind === 'url' && !valueInputs[i].value && (valueInputs[i].value = pageUrl));
    }
    if (kinds.includes('me')) {
        const me = (await jiraGet('/myself').catch(() => null))?.displayName ?? '';
        kinds.forEach((kind, i) => kind === 'me' && !valueInputs[i].value && (valueInputs[i].value = me));
    }
    (el.issueKey.value ? (valueInputs.find((i) => !i.value) ?? el.summary) : el.issueKey).focus();
    saveDraft();
}

document.addEventListener('input', saveDraft);
$('load').addEventListener('click', loadIssue);
el.issueKey.addEventListener('keydown', (e) => e.key === 'Enter' && loadIssue());

$('pickFiles').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
    addFiles($('fileInput').files);
    $('fileInput').value = '';
});
const drop = $('dropZone');
drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer.files);
});
// Clipboard screenshots all arrive as "image.png", so each gets its own name. Text pastes pass through.
document.addEventListener('paste', (e) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    e.preventDefault();
    addFiles(pasted.map((f) => new File([f], `screenshot-${++pastedCount}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type })));
});

$('send').addEventListener('click', async () => {
    const report = readForm();
    report.issueKey = report.issueKey.toUpperCase();
    if (!report.issueKey) {
        setStatus('Enter the issue key first.', 'bad');
        el.issueKey.setAttribute('aria-invalid', 'true');
        el.issueKey.focus();
        return;
    }
    el.issueKey.removeAttribute('aria-invalid');

    const btn = $('send');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
        if (files.length) setStatus(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`);
        const attachments = await mapLimit(files, 3, (file) => uploadEvidence(report.issueKey, file));
        setStatus('Posting the comment…');
        const comment = await jiraSend('POST', `/issue/${report.issueKey}/comment`, { body: buildTestReportADF(report, attachments, settings.site, template) });
        await chrome.storage.local.remove(DRAFT_KEY);
        setStatus(`Posted to ${report.issueKey}.`, 'ok');
        await openComment(report.issueKey, comment.id);
        window.close();
    } catch (err) {
        setStatus(String(err.message ?? err), 'bad');
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
    }
});

init();
