// node jira.test.mjs: self-checks for the pure builders in jira.js (no browser needed).
import assert from 'node:assert/strict';
import {
    normalizeSite,
    pickExtraFields,
    inputKind,
    fieldValue,
    pickDefaultIssueType,
    buildIssueFields,
    buildDescriptionADF,
    appendToSection,
    issueKeyFromUrl,
    buildTestReportADF,
    DEFAULT_TEMPLATE,
    normalizeTemplate,
    buildSettingsFile,
    parseSettingsFile,
    pickOptionalFields,
    parseLabels,
    jiraErrorText,
} from './jira.js';

// normalizeSite
assert.equal(normalizeSite('acme'), 'https://acme.atlassian.net');
assert.equal(normalizeSite('acme.atlassian.net'), 'https://acme.atlassian.net');
assert.equal(normalizeSite(' https://acme.atlassian.net/jira/software/projects '), 'https://acme.atlassian.net');
assert.equal(normalizeSite('http://acme.atlassian.net'), null);
assert.equal(normalizeSite(''), null);

// pickExtraFields: required, no default, not handled by the form
const fields = [
    { fieldId: 'summary', required: true, schema: { type: 'string' } },
    { fieldId: 'reporter', required: true, schema: { type: 'user' } },
    { fieldId: 'customfield_1', name: 'Severity', required: true, schema: { type: 'option' }, allowedValues: [{ id: '10', value: 'High' }] },
    { fieldId: 'customfield_2', name: 'Team', required: true, hasDefaultValue: true, schema: { type: 'option' }, allowedValues: [{ id: '1' }] },
    { fieldId: 'customfield_3', name: 'Optional', required: false, schema: { type: 'string' } },
];
assert.deepEqual(pickExtraFields(fields).map((f) => f.fieldId), ['customfield_1']);

// inputKind + fieldValue
const sel = { schema: { type: 'option' }, allowedValues: [{ id: '10' }] };
const multi = { schema: { type: 'array', items: 'option' }, allowedValues: [{ id: '10' }] };
const user = { schema: { type: 'array', items: 'user' } };
const area = { schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } };
const list = { schema: { type: 'array', items: 'string' } };
const dt = { schema: { type: 'datetime' } };
const weird = { schema: { type: 'any' } };
assert.equal(inputKind(sel), 'select');
assert.equal(inputKind(area), 'textarea');
assert.equal(inputKind(weird), null);
assert.deepEqual(fieldValue(sel, '10'), { id: '10' });
assert.deepEqual(fieldValue(multi, '10'), [{ id: '10' }]);
assert.deepEqual(fieldValue(user, 'abc'), [{ accountId: 'abc' }]);
assert.deepEqual(fieldValue(list, 'a, b,,c'), ['a', 'b', 'c']);
assert.equal(fieldValue({ schema: { type: 'number' } }, '3'), 3);
assert.match(fieldValue(dt, '2026-01-02T03:04'), /^2026-01-0\dT\d\d:\d\d:00\.000\+0000$/);
assert.equal(fieldValue(area, 'one\ntwo').content.length, 2);
assert.equal(fieldValue(sel, ''), undefined);
assert.equal(fieldValue(weird, 'x'), undefined);

// pickDefaultIssueType: remembered, then "Bug", then first
const types = [{ id: '1', name: 'Task' }, { id: '2', name: 'Bug' }];
assert.equal(pickDefaultIssueType(types, '1').id, '1');
assert.equal(pickDefaultIssueType(types, 'gone').id, '2');
assert.equal(pickDefaultIssueType([{ id: '9', name: 'Story' }]).id, '9');

// buildIssueFields
const payload = {
    projectKey: 'ABC',
    issueTypeId: '2',
    summary: 'Cart total is wrong',
    priorityId: '3',
    labels: ['from-qa-report'],
    extraFields: { customfield_1: { id: '10' }, labels: ['ui', 'from-qa-report'] },
    sections: {
        steps: [{ type: 'paragraph', inlines: [{ text: 'Open cart', marks: [] }] }, { type: 'image', dataUrl: 'data:' }],
        actual: [{ type: 'paragraph', inlines: [{ text: 'Shows 0', marks: [{ type: 'strong' }, { type: 'code' }] }] }],
        expected: [],
    },
    environment: { pageUrl: 'https://shop.example/cart', browser: 'Chrome 130 on macOS' },
};
const issue = buildIssueFields(payload);
assert.deepEqual(issue.project, { key: 'ABC' });
assert.deepEqual(issue.priority, { id: '3' });
assert.deepEqual(issue.labels, ['from-qa-report', 'ui']);
assert.deepEqual(issue.customfield_1, { id: '10' });
const panels = issue.description.content;
assert.deepEqual(panels.map((p) => p.attrs.panelType), ['warning', 'error', 'info']);
// image without a media id falls back to a text note; with one it embeds
assert.match(JSON.stringify(panels[0]), /image attached/);
const withMedia = buildDescriptionADF(payload, { steps: ['uuid-1'] });
assert.equal(withMedia.content[0].content.at(-1).type, 'mediaSingle');
// code mark keeps only itself
assert.deepEqual(panels[1].content[1].content[0].marks, [{ type: 'code' }]);
// environment link is clickable
assert.match(JSON.stringify(panels[2]), /"href":"https:\/\/shop.example\/cart"/);

// appendToSection: into an existing panel, or a new one
const doc = buildDescriptionADF(payload);
const node = { type: 'paragraph', content: [{ type: 'text', text: 'video' }] };
assert.equal(appendToSection(doc, 'steps', [node]).content[0].content.at(-1), node);
const added = appendToSection(doc, 'expected', [node]);
assert.equal(added.content.length, doc.content.length + 1);
assert.equal(added.content.at(-1).attrs.panelType, 'success');

// issueKeyFromUrl
const site = 'https://acme.atlassian.net';
assert.equal(issueKeyFromUrl(`${site}/browse/ABC-12`, site), 'ABC-12');
assert.equal(issueKeyFromUrl(`${site}/jira/software/projects/ABC/boards/1?selectedIssue=ABC-7`, site), 'ABC-7');
assert.equal(issueKeyFromUrl('https://other.atlassian.net/browse/ABC-12', site), null);
assert.equal(issueKeyFromUrl('not a url', site), null);

// buildTestReportADF from the default template: result 2 = Failed, fields in template order
const report = buildTestReportADF(
    { issueKey: 'ABC-1', result: 2, values: ['staging', 'Sam', 'https://shop.example', 'Checkout', '', 'ABC-2 broken footer'] },
    [{ id: '5', filename: 'log.txt' }, { id: '6', filename: 'a.png', mediaId: 'm', width: 10, height: 10 }],
    site,
    DEFAULT_TEMPLATE,
);
const json = JSON.stringify(report);
assert.match(json, /"text":"FAILED","color":"red"/);
assert.match(json, /"text":"Test report: ABC-1"/);
assert.equal(report.content[1].content.length, 4); // Result + 3 short fields
assert.match(json, /"href":"https:\/\/shop.example"/);
assert.doesNotMatch(json, /"Notes"/); // empty field left out
assert.match(json, /acme.atlassian.net\/browse\/ABC-2/);
assert.match(json, /secure\/attachment\/5\/log.txt/);
assert.match(json, /"type":"mediaSingle"/);

// a custom template
const custom = normalizeTemplate({
    heading: 'Перевірка',
    results: [{ label: 'OK', color: 'green' }, { label: '', color: 'red' }, { label: 'Bad', color: 'pink' }],
    fields: [{ label: 'Build', kind: 'text' }, { label: 'Steps', kind: 'weird', default: 'a' }, { label: '' }],
});
assert.deepEqual(custom.results, [{ label: 'OK', color: 'green' }, { label: 'Bad', color: 'neutral' }]);
assert.deepEqual(custom.fields.map((f) => f.kind), ['text', 'text']);
assert.equal(custom.resultLabel, 'Result');
assert.equal(normalizeTemplate({ results: [] }), null);
assert.equal(normalizeTemplate('nope'), null);
const customReport = JSON.stringify(buildTestReportADF({ issueKey: 'X-1', summary: 'Login', result: 1, values: ['42'] }, [], site, custom));
assert.match(customReport, /"text":"Перевірка: Login"/);
assert.match(customReport, /"text":"BAD"/);

// settings file round trip, no credentials inside
const file = buildSettingsFile({ defaultLabels: 'qa', reportTemplate: custom, jiraApiToken: 'secret' });
assert.doesNotMatch(JSON.stringify(file), /secret/);
assert.deepEqual(parseSettingsFile(JSON.stringify(file)), { defaultLabels: 'qa', reportTemplate: custom });
assert.throws(() => parseSettingsFile('{'), /not valid JSON/);
assert.throws(() => parseSettingsFile('{"format":"other"}'), /not a QA Report settings file/);

// optional fields: supported, not handled, not already required
const optional = pickOptionalFields([
    ...fields,
    { fieldId: 'components', name: 'Components', required: false, schema: { type: 'array', items: 'component' }, allowedValues: [{ id: '1', name: 'Web' }] },
    { fieldId: 'timetracking', name: 'Time', required: false, schema: { type: 'timetracking' } },
    { fieldId: 'environment', name: 'Environment', required: false, schema: { type: 'string', system: 'environment' } },
]);
assert.deepEqual(optional.map((f) => f.fieldId), ['customfield_2', 'customfield_3', 'components', 'environment']);
assert.equal(inputKind({ schema: { type: 'string', system: 'environment' } }), 'textarea');

// misc
assert.deepEqual(parseLabels('a, b  c'), ['a', 'b', 'c']);
assert.equal(jiraErrorText('{"errorMessages":[],"errors":{"customfield_1":"Severity is required."}}'), 'customfield_1: Severity is required.');

console.log('jira.test.mjs: all checks passed');
