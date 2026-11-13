// Pure DOM-tree walk — no chrome.* APIs, no `document` — only reads plain node shapes
// (nodeType/nodeName/childNodes/textContent/src/href/style) any DOM node has, so it's
// unit-testable with plain mock objects, no browser/jsdom needed.
const TEXT_NODE = 3;

const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION']);
const LIST_TAGS = { UL: 'bulletList', OL: 'orderedList' };
const MARK_BY_TAG = {
    B: 'strong',
    STRONG: 'strong',
    I: 'em',
    EM: 'em',
    U: 'underline',
    S: 'strike',
    STRIKE: 'strike',
    DEL: 'strike',
    CODE: 'code',
};

// Pasted web content usually carries formatting as inline styles on <span>s, not as <b>/<i>.
function marksFromStyle(style) {
    const marks = [];
    if (!style) return marks;
    const weight = String(style.fontWeight ?? '');
    if (weight === 'bold' || Number(weight) >= 600) marks.push({ type: 'strong' });
    if (style.fontStyle === 'italic') marks.push({ type: 'em' });
    const decoration = String(style.textDecorationLine ?? style.textDecoration ?? '');
    if (decoration.includes('underline')) marks.push({ type: 'underline' });
    if (decoration.includes('line-through')) marks.push({ type: 'strike' });
    return marks;
}

function marksForElement(node) {
    const marks = marksFromStyle(node.style);
    const tagMark = MARK_BY_TAG[node.nodeName];
    if (tagMark) marks.push({ type: tagMark });
    if (node.nodeName === 'A') {
        const href = node.getAttribute?.('href') ?? node.href;
        if (href) marks.push({ type: 'link', href });
    }
    return marks;
}

function mergeMarks(inherited, own) {
    const merged = [...inherited];
    for (const mark of own) {
        if (!merged.some((m) => m.type === mark.type)) merged.push(mark);
    }
    return merged;
}

// Recursively walks a contenteditable field's (see preview.js#setupPasteImage) subtree into
// ordered parts: `paragraph` ({inlines: [{text, marks}]}), `bulletList`/`orderedList`
// ({items: [parts[]]}) and `image`. Recursive, not just top-level children — Chrome's
// execCommand('insertImage', ...) sometimes wraps the inserted <img> in a block-level <div>
// instead of appending it as a direct child, and a flat top-level-only walk misses that image
// entirely (it silently never reaches background.js#attachPastedImages).
//
// Inline elements (<b>, <i>, <a>, styled <span>...) only add marks to the text inside them and
// never split the paragraph; block elements, <br> and "\n" in a text node do. Images always
// stay top-level (lists hand theirs back to the caller) because background.js maps media ids
// to images by their order in this flat list.
export function serializeRichField(el) {
    return serializeChildren(el.childNodes, false).parts;
}

// hoistImages: inside a list item an <img> is not kept in `parts` but returned in `images`, so
// the list branch can emit it after the list instead of nesting it.
function serializeChildren(childNodes, hoistImages) {
    const parts = [];
    const images = [];
    let inlines = [];

    const flush = () => {
        if (inlines.some((inline) => inline.text.trim())) parts.push({ type: 'paragraph', inlines });
        inlines = [];
    };

    const walk = (node, marks) => {
        if (node.nodeName === 'IMG') {
            flush();
            (hoistImages ? images : parts).push({ type: 'image', dataUrl: node.src });
        } else if (node.nodeType === TEXT_NODE) {
            (node.textContent ?? '').split('\n').forEach((text, i) => {
                if (i > 0) flush();
                if (text) inlines.push({ text, marks });
            });
        } else if (node.nodeName === 'BR') {
            flush();
        } else if (LIST_TAGS[node.nodeName]) {
            flush();
            const items = [];
            const listImages = [];
            Array.from(node.childNodes ?? []).forEach((li) => {
                if (li.nodeName !== 'LI') return;
                const item = serializeChildren(li.childNodes, true);
                listImages.push(...item.images);
                if (item.parts.length) items.push(item.parts);
            });
            if (items.length) parts.push({ type: LIST_TAGS[node.nodeName], items });
            (hoistImages ? images : parts).push(...listImages);
        } else {
            const isBlock = BLOCK_TAGS.has(node.nodeName);
            if (isBlock) flush();
            const childMarks = mergeMarks(marks, marksForElement(node));
            Array.from(node.childNodes ?? []).forEach((child) => walk(child, childMarks));
            if (isBlock) flush();
        }
    };

    Array.from(childNodes ?? []).forEach((child) => walk(child, []));
    flush();
    return { parts, images };
}
