// node ai-fill.test.mjs: self-checks for the pure helpers in ai-fill.js (no browser needed).
import assert from 'node:assert/strict';
import { adfToText, buildAiPrompt, parseAiReply, installCommand } from './ai-fill.js';

{
    const doc = {
        type: 'doc',
        content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'mention', attrs: { text: '@Ann' } }] },
            {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AC1' }] }] }],
            },
            { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://x/ABC-1' } }] },
        ],
    };
    assert.equal(adfToText(doc), 'Hello @Ann\n- AC1\nhttps://x/ABC-1\n');
    assert.equal(adfToText(null), '');
}

const base = { issueKey: 'ABC-1', summary: 'Login', tester: 'Ann', description: 'desc' };
const fields = [
    { label: 'What was checked', kind: 'long' },
    { label: 'Known issues', kind: 'issues' },
];

{
    const prompt = buildAiPrompt({
        ...base,
        fields,
        comments: [
            { author: 'Bob', created: '2026-11-01T10:00:00.000+0200', text: 'old' },
            { author: 'Ann', created: '2026-11-02T10:00:00.000+0200', text: 'new' },
        ],
    });
    assert.ok(prompt.includes('{"What was checked":"...","Known issues":"..."}'), 'asks for the template labels');
    assert.ok(prompt.indexOf('[2026-11-01 Bob]: old') < prompt.indexOf('[2026-11-02 Ann]: new'), 'oldest first');
}

{
    const huge = 'x'.repeat(30_000);
    const prompt = buildAiPrompt({
        ...base,
        fields,
        comments: [
            { author: 'A', created: '2026-01-01', text: `first ${huge}` },
            { author: 'B', created: '2026-01-02', text: `last ${huge}` },
        ],
    });
    assert.ok(prompt.includes('last x') && !prompt.includes('first x'), 'newest comments kept on overflow');
}

assert.deepEqual(parseAiReply('```json\n{"What was checked":" - a ","Extra":"x"}\n```', ['What was checked', 'Known issues']), {
    'What was checked': '- a',
});
assert.throws(() => parseAiReply('sorry', ['A']), /no JSON/);
assert.throws(() => parseAiReply('{"B":"x"}', ['A']), /none of the report fields/);
assert.equal(
    installCommand('abc'),
    'curl -fsSL https://raw.githubusercontent.com/stokrattt/qa-report-for-jira/main/native-host/install.sh | sh -s abc',
);
assert.equal(
    installCommand('abc', true),
    '& ([scriptblock]::Create((irm https://raw.githubusercontent.com/stokrattt/qa-report-for-jira/main/native-host/install.ps1))) abc',
);

console.log('ai-fill.test.mjs: OK');
