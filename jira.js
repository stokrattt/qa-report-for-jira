// Jira Cloud REST v3 helpers shared by the service worker and the extension pages.
// Pure builders (ADF, field values, URL parsing) take no chrome.* APIs, so jira.test.mjs runs them in plain Node.

// ---------------------------------------------------------------------------
// Settings and transport
// ---------------------------------------------------------------------------

// Accepts "your-team", "your-team.atlassian.net" or a full URL and returns the site origin.
export function normalizeSite(input) {
    let value = String(input ?? '').trim();
    if (!value) return null;
    if (!value.includes('.') && /^[a-z0-9-]+$/i.test(value)) value = `${value}.atlassian.net`;
    if (!/^[a-z]+:\/\//i.test(value)) value = `https://${value}`;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:') return null;
        return url.origin;
    } catch {
        return null;
    }
}

// storage.local, not sync: the token never leaves this browser profile through account sync.
export async function getSettings() {
    const { jiraSite, jiraEmail, jiraApiToken } = await chrome.storage.local.get(['jiraSite', 'jiraEmail', 'jiraApiToken']);
    return { site: jiraSite ?? '', email: jiraEmail ?? '', token: jiraApiToken ?? '' };
}

export function isConfigured({ site, email, token }) {
    return Boolean(site && email && token);
}

export function authHeader(email, token) {
    return `Basic ${btoa(`${email}:${token}`)}`;
}

function explain(status, path) {
    if (status === 401) return 'Jira rejected the email or API token. Check them in Settings.';
    if (status === 403) return `Your Jira account has no permission for this (${path}).`;
    if (status === 404) return `Not found in Jira (${path}).`;
    if (status === 429) return 'Jira is rate limiting requests. Wait a minute and try again.';
    return null;
}

// `settings` is optional: the Settings page passes the unsaved values to test them.
export async function jiraFetch(path, init = {}, settings = null) {
    const { site, email, token } = settings ?? (await getSettings());
    if (!site || !email || !token) throw new Error('Connect your Jira site in Settings first.');
    const res = await fetch(`${site}/rest/api/3${path}`, {
        ...init,
        headers: { Authorization: authHeader(email, token), Accept: 'application/json', ...init.headers },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(explain(res.status, path) ?? `Jira answered ${res.status} for ${path}: ${jiraErrorText(body)}`);
    }
    return res.status === 204 ? null : res.json();
}

// Jira's 400 bodies are { errorMessages: [], errors: { field: message } }.
export function jiraErrorText(body) {
    try {
        const data = JSON.parse(body);
        const parts = [...(data.errorMessages ?? []), ...Object.entries(data.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
        if (parts.length) return parts.join('; ');
    } catch {
        // not JSON
    }
    return body.slice(0, 300);
}

export const jiraGet = (path, settings) => jiraFetch(path, {}, settings);

export const jiraSend = (method, path, body) =>
    jiraFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function uploadAttachment(issueKey, blob, filename) {
    const form = new FormData();
    form.append('file', blob, filename);
    const [attachment] = await jiraFetch(`/issue/${issueKey}/attachments`, {
        method: 'POST',
        headers: { 'X-Atlassian-Token': 'no-check' },
        body: form,
    });
    return attachment; // { id, filename, mimeType, ... }
}

// Runs `worker` over `items`, at most `limit` at a time, keeping each result at its index.
export async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function runNext() {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
        await runNext();
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
    return results;
}

// ---------------------------------------------------------------------------
// Create metadata
// ---------------------------------------------------------------------------

// ponytail: first 100 projects by name; add a search box when someone has more.
export async function listProjects() {
    const data = await jiraGet('/project/search?action=create&orderBy=name&maxResults=100');
    return (data.values ?? []).map(({ id, key, name }) => ({ id, key, name }));
}

export async function listIssueTypes(projectKey) {
    const data = await jiraGet(`/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=100`);
    const types = data.issueTypes ?? data.createMetaIssueType ?? data.values ?? [];
    return types.filter((t) => !t.subtask).map(({ id, name }) => ({ id, name }));
}

export async function listCreateFields(projectKey, issueTypeId) {
    const fields = [];
    for (let startAt = 0; ; ) {
        const data = await jiraGet(
            `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${issueTypeId}?startAt=${startAt}&maxResults=100`,
        );
        const page = data.fields ?? data.results ?? [];
        fields.push(...page);
        startAt += page.length;
        if (!page.length || startAt >= (data.total ?? startAt)) break;
    }
    return fields;
}

export function pickDefaultIssueType(types, rememberedId) {
    return (
        types.find((t) => t.id === rememberedId) ??
        types.find((t) => /^bug$/i.test(t.name)) ??
        types[0] ??
        null
    );
}

// Fields the form fills on its own; everything else that is required gets a generic control.
const HANDLED_FIELDS = new Set(['project', 'issuetype', 'summary', 'description', 'reporter', 'priority', 'attachment', 'issuelinks']);

export function fieldId(field) {
    return field.fieldId ?? field.key;
}

export function pickExtraFields(fields) {
    return fields.filter((f) => f.required && !f.hasDefaultValue && !HANDLED_FIELDS.has(fieldId(f)));
}

// Everything else the create screen offers that the form can fill, for the "More fields" section.
export function pickOptionalFields(fields) {
    const required = new Set(pickExtraFields(fields));
    return fields.filter((f) => !required.has(f) && !HANDLED_FIELDS.has(fieldId(f)) && inputKind(f));
}

// Which control a field gets in the form; null means the form cannot fill it.
export function inputKind(field) {
    const { type, items, custom, system } = field.schema ?? {};
    if (field.allowedValues?.length) return 'select';
    if (type === 'user' || (type === 'array' && items === 'user')) return 'user';
    if (type === 'number') return 'number';
    if (type === 'date') return 'date';
    if (type === 'datetime') return 'datetime';
    if (type === 'array' && items === 'string') return 'list';
    // Multi-line custom fields and the system Environment field take ADF in API v3, not a plain string.
    if (type === 'string') return custom?.endsWith(':textarea') || system === 'environment' ? 'textarea' : 'text';
    return null;
}

// Turns what the generic control holds into the value Jira's create call expects.
export function fieldValue(field, raw) {
    if (raw == null || String(raw).trim() === '') return undefined;
    const isArray = field.schema?.type === 'array';
    switch (inputKind(field)) {
        case 'select':
            return isArray ? [{ id: raw }] : { id: raw };
        case 'user':
            return isArray ? [{ accountId: raw }] : { accountId: raw };
        case 'number':
            return Number(raw);
        case 'date':
            return raw;
        case 'datetime':
            return new Date(raw).toISOString().replace('Z', '+0000');
        case 'list':
            return String(raw)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        case 'textarea':
            return textToADF(raw);
        case 'text':
            return String(raw);
        default:
            return undefined;
    }
}

export function optionLabel(value) {
    return value.name ?? value.value ?? value.key ?? value.id;
}

// ---------------------------------------------------------------------------
// ADF builders
// ---------------------------------------------------------------------------

function text(value, marks) {
    return marks?.length ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

function linkMarks(href) {
    return /^https?:/i.test(href ?? '') ? [{ type: 'link', attrs: { href } }] : undefined;
}

function textParagraphs(value) {
    return String(value ?? '')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => ({ type: 'paragraph', content: [text(line)] }));
}

export function textToADF(value) {
    return { type: 'doc', version: 1, content: textParagraphs(value) };
}

// Inline embed of an attachment that has a Media API file id; Jira shows video as a play card.
// Width and height are optional, but Jira only displays a media node inside mediaSingle with them set.
export function mediaSingleNode(mediaId, width, height) {
    return {
        type: 'mediaSingle',
        attrs: { layout: 'center' },
        content: [
            {
                type: 'media',
                attrs: { id: mediaId, type: 'file', collection: '', ...(width && height ? { width, height } : {}) },
            },
        ],
    };
}

export function linkParagraph(url, label) {
    return { type: 'paragraph', content: [text(label, linkMarks(url))] };
}

// ADF's `code` mark combines only with `link`; anything else beside it fails the whole create call.
function inlineMarksToADF(marks) {
    const adf = (marks ?? [])
        .filter((m) => m.type !== 'link' || /^(https?:|mailto:)/i.test(m.href))
        .map((m) => (m.type === 'link' ? { type: 'link', attrs: { href: m.href } } : { type: m.type }));
    return adf.some((m) => m.type === 'code') ? adf.filter((m) => m.type === 'code' || m.type === 'link') : adf;
}

// `parts` come from rich-field.js. An image becomes an inline media node once its media id is known,
// and a text note until then, so it never silently disappears.
function partsToNodes(parts, mediaIds = null, counter = { i: 0 }) {
    const content = [];
    for (const part of parts ?? []) {
        if (part.type === 'image') {
            const id = mediaIds?.[counter.i];
            counter.i += 1;
            content.push(id ? mediaSingleNode(id) : { type: 'paragraph', content: [text('[image attached, see Attachments]')] });
        } else if (part.type === 'paragraph') {
            content.push({ type: 'paragraph', content: part.inlines.map((inl) => text(inl.text, inlineMarksToADF(inl.marks))) });
        } else if (part.type === 'bulletList' || part.type === 'orderedList') {
            content.push({
                type: part.type,
                content: part.items.map((item) => ({ type: 'listItem', content: partsToNodes(item, mediaIds, counter) })),
            });
        } else {
            content.push(...textParagraphs(part.value));
        }
    }
    return content;
}

// One coloured panel per section, the layout people build by hand in Jira's editor.
export const SECTIONS = [
    { key: 'context', label: 'Context', panel: 'note' },
    { key: 'steps', label: 'Steps to reproduce', panel: 'warning' },
    { key: 'actual', label: 'Actual result', panel: 'error' },
    { key: 'expected', label: 'Expected result', panel: 'success' },
    { key: 'notes', label: 'Notes', panel: 'info' },
];

function panel(panelType, label, nodes) {
    return {
        type: 'panel',
        attrs: { panelType },
        content: [{ type: 'paragraph', content: [text(`${label}:`, [{ type: 'strong' }])] }, ...nodes],
    };
}

function environmentPanel(env) {
    const rows = [
        ['Page', env?.pageUrl],
        ['Browser', env?.browser],
        ['Viewport', env?.viewport],
        ['Captured', env?.capturedAt],
    ].filter(([, value]) => value);
    if (!rows.length) return null;
    return panel('info', 'Environment', [
        {
            type: 'bulletList',
            content: rows.map(([label, value]) => ({
                type: 'listItem',
                content: [{ type: 'paragraph', content: [text(`${label}: `, [{ type: 'strong' }]), text(value, linkMarks(value))] }],
            })),
        },
    ]);
}

// payload.sections: { context: parts, steps: parts, ... }; mediaIds: { steps: [id|null, ...], ... }.
export function buildDescriptionADF(payload, mediaIds = {}) {
    const content = SECTIONS.filter((s) => payload.sections?.[s.key]?.length).map((s) =>
        panel(s.panel, s.label, partsToNodes(payload.sections[s.key], mediaIds[s.key])),
    );
    const env = environmentPanel(payload.environment);
    if (env) content.push(env);
    return { type: 'doc', version: 1, content };
}

// Adds nodes to the end of a section's panel, creating the panel when the section was left empty.
export function appendToSection(doc, sectionKey, nodes) {
    const section = SECTIONS.find((s) => s.key === sectionKey);
    let found = false;
    const content = doc.content.map((node) => {
        if (!found && node.type === 'panel' && node.attrs?.panelType === section.panel && node.content?.[0]?.content?.[0]?.text === `${section.label}:`) {
            found = true;
            return { ...node, content: [...node.content, ...nodes] };
        }
        return node;
    });
    if (!found) content.push(panel(section.panel, section.label, nodes));
    return { ...doc, content };
}

export function buildIssueFields(payload) {
    const fields = {
        project: { key: payload.projectKey },
        issuetype: { id: payload.issueTypeId },
        summary: payload.summary,
        description: buildDescriptionADF(payload),
        ...payload.extraFields,
    };
    if (payload.priorityId) fields.priority = { id: payload.priorityId };
    const labels = [...new Set([...(payload.labels ?? []), ...(payload.extraFields?.labels ?? [])])];
    if (labels.length) fields.labels = labels;
    return fields;
}

// "a, b c" -> ["a", "b", "c"]; Jira labels cannot contain spaces.
export function parseLabels(value) {
    return String(value ?? '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Test report comment, built from a template people edit in Settings
// ---------------------------------------------------------------------------

// ADF status lozenge colours.
export const RESULT_COLORS = ['green', 'yellow', 'red', 'blue', 'purple', 'neutral'];

// Field kinds: short ones become rows of the comment's table, the rest headed blocks.
//   text   a short value                     -> table row
//   me     prefilled with your Jira name       -> table row
//   url    prefilled with the tested page      -> table row, linked
//   long   free text                           -> heading + quote
//   issues one per line, issue keys linked     -> heading + bullet list
export const FIELD_KINDS = ['text', 'me', 'url', 'long', 'issues'];
const TABLE_KINDS = new Set(['text', 'me', 'url']);

export const DEFAULT_TEMPLATE = {
    heading: 'Test report',
    resultLabel: 'Result',
    results: [
        { label: 'Passed', color: 'green' },
        { label: 'Passed with known issues', color: 'yellow' },
        { label: 'Failed', color: 'red' },
        { label: 'Blocked', color: 'neutral' },
    ],
    fields: [
        { label: 'Environment', kind: 'text', default: '' },
        { label: 'Tested by', kind: 'me', default: '' },
        { label: 'Tested on', kind: 'url', default: '' },
        { label: 'What was checked', kind: 'long', default: '' },
        { label: 'Notes', kind: 'long', default: '' },
        { label: 'Known issues', kind: 'issues', default: '' },
    ],
};

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');

// Accepts anything (an imported file, an old stored value) and returns a valid template, or null.
export function normalizeTemplate(input) {
    if (!input || typeof input !== 'object') return null;
    const results = (Array.isArray(input.results) ? input.results : [])
        .map((r) => ({ label: str(r?.label, 60).trim(), color: RESULT_COLORS.includes(r?.color) ? r.color : 'neutral' }))
        .filter((r) => r.label);
    const fields = (Array.isArray(input.fields) ? input.fields : [])
        .map((f) => ({ label: str(f?.label, 80).trim(), kind: FIELD_KINDS.includes(f?.kind) ? f.kind : 'text', default: str(f?.default) }))
        .filter((f) => f.label);
    if (!results.length) return null;
    return {
        heading: str(input.heading, 80).trim() || DEFAULT_TEMPLATE.heading,
        resultLabel: str(input.resultLabel, 60).trim() || DEFAULT_TEMPLATE.resultLabel,
        results,
        fields,
    };
}

export async function getTemplate() {
    const { reportTemplate } = await chrome.storage.sync.get('reportTemplate');
    return normalizeTemplate(reportTemplate) ?? structuredClone(DEFAULT_TEMPLATE);
}

const ISSUE_KEY_RE = /([A-Z][A-Z0-9_]+-\d+)/;

// A board keeps the open issue in ?selectedIssue=, the issue page in /browse/KEY.
export function issueKeyFromUrl(url, site) {
    try {
        const { origin, pathname, searchParams } = new URL(url);
        if (!site || origin !== site) return null;
        const key = pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/)?.[1] ?? searchParams.get('selectedIssue');
        return key && ISSUE_KEY_RE.test(key) ? key : null;
    } catch {
        return null;
    }
}

function bulletList(items) {
    return {
        type: 'bulletList',
        content: items.map((content) => ({ type: 'listItem', content: [{ type: 'paragraph', content }] })),
    };
}

function linkIssueKeys(line, site) {
    return line
        .split(ISSUE_KEY_RE)
        .filter(Boolean)
        .map((part) => text(part, ISSUE_KEY_RE.test(part) ? linkMarks(`${site}/browse/${part}`) : undefined));
}

// report: { issueKey, summary, result (index into template.results), values: [one string per template field] }
// attachments: what uploadAttachment returned, plus mediaId/width/height when resolved.
export function buildTestReportADF(report, attachments, site, template) {
    const strong = [{ type: 'strong' }];
    const heading = (label) => ({ type: 'paragraph', content: [text(label, strong)] });
    const row = (label, value) => ({
        type: 'tableRow',
        content: [
            { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [text(label)] }] },
            { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [value] }] },
        ],
    });
    const result = template.results[report.result] ?? template.results[0];
    const rows = [row(template.resultLabel, { type: 'status', attrs: { text: result.label.toUpperCase(), color: result.color } })];
    const blocks = [];

    template.fields.forEach((field, i) => {
        const value = String(report.values?.[i] ?? '').trim();
        if (!value) return;
        if (TABLE_KINDS.has(field.kind)) {
            rows.push(row(field.label, text(value, field.kind === 'url' ? linkMarks(value) : undefined)));
        } else if (field.kind === 'issues') {
            const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
            blocks.push(heading(field.label), bulletList(lines.map((l) => linkIssueKeys(l, site))));
        } else {
            blocks.push(heading(field.label), { type: 'blockquote', content: textParagraphs(value) });
        }
    });

    const title = report.summary ? `${template.heading}: ${report.summary}` : `${template.heading}: ${report.issueKey}`;
    const content = [
        { type: 'heading', attrs: { level: 3 }, content: [text(title)] },
        { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows },
        ...blocks,
    ];

    if (attachments?.length) {
        content.push(heading(`Evidence (${attachments.length})`));
        content.push(...attachments.filter((a) => a.mediaId).map((a) => mediaSingleNode(a.mediaId, a.width, a.height)));
        const linked = attachments.filter((a) => !a.mediaId);
        if (linked.length) {
            content.push(
                bulletList(
                    linked.map((a) => [text(a.filename, linkMarks(`${site}/secure/attachment/${a.id}/${encodeURIComponent(a.filename)}`))]),
                ),
            );
        }
    }
    return { type: 'doc', version: 1, content };
}

// ---------------------------------------------------------------------------
// Team setup file: everything except the site and credentials
// ---------------------------------------------------------------------------

export const SETTINGS_FILE_FORMAT = 'qa-report-for-jira/settings';

export function buildSettingsFile({ defaultLabels, reportTemplate }) {
    return { format: SETTINGS_FILE_FORMAT, version: 1, defaultLabels: defaultLabels ?? '', reportTemplate: normalizeTemplate(reportTemplate) ?? DEFAULT_TEMPLATE };
}

// Returns the values to store, or throws with a message for the person importing.
export function parseSettingsFile(textValue) {
    let data;
    try {
        data = JSON.parse(textValue);
    } catch {
        throw new Error('This file is not valid JSON.');
    }
    if (data?.format !== SETTINGS_FILE_FORMAT) throw new Error('This is not a QA Report settings file.');
    const reportTemplate = normalizeTemplate(data.reportTemplate);
    if (!reportTemplate) throw new Error('The report template in this file has no result options.');
    return { defaultLabels: str(data.defaultLabels, 500), reportTemplate };
}
