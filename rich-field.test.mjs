// Plain Node self-check for the contenteditable-parsing logic — no browser/jsdom involved,
// just plain objects shaped like DOM nodes.
// Run with: node tools/chrome-bug-capture/rich-field.test.mjs
import assert from 'node:assert';
import { serializeRichField } from './rich-field.js';

const textNode = (value) => ({ nodeType: 3, nodeName: '#text', textContent: value });
const imgNode = (src) => ({ nodeType: 1, nodeName: 'IMG', src });
const elNode = (nodeName, children) => ({ nodeType: 1, nodeName, childNodes: children });
const root = (children) => ({ childNodes: children });

// Flat: image as a direct child of the field.
{
    const el = root([textNode('before'), imgNode('data:image/png;base64,AAA'), textNode('after')]);
    assert.deepStrictEqual(serializeRichField(el), [
        { type: 'paragraph', inlines: [{ text: 'before', marks: [] }] },
        { type: 'image', dataUrl: 'data:image/png;base64,AAA' },
        { type: 'paragraph', inlines: [{ text: 'after', marks: [] }] },
    ]);
}

// Regression: Chrome sometimes wraps an inserted image in a block-level <div> instead of
// appending it as a direct child — a top-level-only walk missed this entirely, which is why
// pasted images silently never reached the attachment/embed step.
{
    const el = root([elNode('DIV', [imgNode('data:image/png;base64,BBB')])]);
    assert.deepStrictEqual(serializeRichField(el), [{ type: 'image', dataUrl: 'data:image/png;base64,BBB' }]);
}

// Each contenteditable "line" (Chrome wraps line breaks in their own <div>) becomes its own
// text part, however deep the text node is nested.
{
    const el = root([elNode('DIV', [textNode('line one')]), elNode('DIV', [textNode('line two')])]);
    assert.deepStrictEqual(serializeRichField(el), [
        { type: 'paragraph', inlines: [{ text: 'line one', marks: [] }] },
        { type: 'paragraph', inlines: [{ text: 'line two', marks: [] }] },
    ]);
}

// Empty text nodes/elements contribute nothing.
{
    const el = root([textNode(''), elNode('BR', [])]);
    assert.deepStrictEqual(serializeRichField(el), []);
}

// Regression: bold inside a line stayed plain and split the line into three paragraphs.
{
    const el = root([textNode('abc '), elNode('B', [textNode('bold')]), textNode(' def')]);
    assert.deepStrictEqual(serializeRichField(el), [
        {
            type: 'paragraph',
            inlines: [
                { text: 'abc ', marks: [] },
                { text: 'bold', marks: [{ type: 'strong' }] },
                { text: ' def', marks: [] },
            ],
        },
    ]);
}

// Nested marks accumulate; a styled <span> (how pasted web text carries bold) counts too.
{
    const span = { ...elNode('SPAN', [textNode('x')]), style: { fontWeight: '700' } };
    const el = root([elNode('I', [span])]);
    assert.deepStrictEqual(serializeRichField(el)[0].inlines[0].marks, [{ type: 'em' }, { type: 'strong' }]);
}

// "\n" inside one text node (the prefilled Steps text) still splits into paragraphs.
{
    const el = root([textNode('1. a\n2. b')]);
    assert.deepStrictEqual(
        serializeRichField(el).map((p) => p.inlines[0].text),
        ['1. a', '2. b'],
    );
}

// Bullet list: one item per <li>, images inside it are hoisted after the list.
{
    const li = (...c) => elNode('LI', c);
    const el = root([elNode('UL', [li(textNode('one')), li(elNode('B', [textNode('two')]), imgNode('data:x'))])]);
    assert.deepStrictEqual(serializeRichField(el), [
        {
            type: 'bulletList',
            items: [
                [{ type: 'paragraph', inlines: [{ text: 'one', marks: [] }] }],
                [{ type: 'paragraph', inlines: [{ text: 'two', marks: [{ type: 'strong' }] }] }],
            ],
        },
        { type: 'image', dataUrl: 'data:x' },
    ]);
}

console.log('rich-field.test.mjs: OK');
