import {
    SECTIONS,
    getSettings,
    isConfigured,
    jiraGet,
    jiraSend,
    listProjects,
    listIssueTypes,
    listCreateFields,
    pickDefaultIssueType,
    pickExtraFields,
    pickOptionalFields,
    fieldId,
    inputKind,
    fieldValue,
    optionLabel,
    parseLabels,
    buildIssueFields,
    buildDescriptionADF,
    appendToSection,
    uploadAttachment,
    mediaSingleNode,
    linkParagraph,
    mapLimit,
} from './jira.js';
import { serializeRichField } from './rich-field.js';

const $ = (id) => document.getElementById(id);
let settings = null;
let currentFields = []; // createmeta fields for the chosen project + issue type
let extraControls = []; // { field, kind, required, read: () => raw, snapshot: () => memory entry }
let createdUrl = null; // set when the issue exists but an upload failed, so Create turns into Open

function setStatus(text, kind = '') {
    $('status').textContent = text;
    $('status').className = `status${kind ? ` status--${kind}` : ''}`;
}

function fillSelect(select, items, selectedValue, { placeholder } = {}) {
    select.replaceChildren();
    if (placeholder) select.add(new Option(placeholder, ''));
    for (const { value, label } of items) select.add(new Option(label, value, false, value === selectedValue));
}

function formatConsoleLogs(entries) {
    return entries.map((e) => `[${e.level}] ${e.message}`).join('\n');
}

function formatNetworkLogs(entries) {
    return entries.map((e) => `${e.method} ${e.statusCode ?? e.error ?? ''} ${e.url}`).join('\n');
}

function browserLabel() {
    const ua = navigator.userAgentData;
    // userAgentData.brands is Chrome's list of browser names, e.g. "Google Chrome" 131
    const browser = ua?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? ua?.brands?.[0];
    return browser ? `${browser.brand} ${browser.version} on ${ua.platform}` : navigator.userAgent;
}

// ---------------------------------------------------------------------------
// Destination: project, issue type, and the fields that issue type requires
// ---------------------------------------------------------------------------

async function loadProjects() {
    const select = $('project');
    const projects = await listProjects();
    if (!projects.length) throw new Error('Your Jira account cannot create issues in any project.');
    const { lastProjectKey } = await chrome.storage.sync.get('lastProjectKey');
    const selected = projects.some((p) => p.key === lastProjectKey) ? lastProjectKey : projects[0].key;
    fillSelect(select, projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })), selected);
    select.disabled = false;
    select.addEventListener('change', () => loadIssueTypes().catch(showLoadError));
    await loadIssueTypes();
}

async function loadIssueTypes() {
    const select = $('issueType');
    select.disabled = true;
    $('create').disabled = true;
    const projectKey = $('project').value;
    const types = await listIssueTypes(projectKey);
    const { issueTypeByProject = {} } = await chrome.storage.sync.get('issueTypeByProject');
    const selected = pickDefaultIssueType(types, issueTypeByProject[projectKey]);
    fillSelect(select, types.map((t) => ({ value: t.id, label: t.name })), selected?.id);
    select.disabled = false;
    select.onchange = () => loadFields().catch(showLoadError);
    await loadFields();
}

async function loadFields() {
    $('create').disabled = true;
    setStatus('Loading fields…');
    currentFields = await listCreateFields($('project').value, $('issueType').value);

    const priority = currentFields.find((f) => fieldId(f) === 'priority');
    $('priorityField').hidden = !priority?.allowedValues?.length;
    if (priority?.allowedValues?.length) {
        fillSelect(
            $('priority'),
            priority.allowedValues.map((v) => ({ value: v.id, label: v.name })),
            priority.defaultValue?.id,
            { placeholder: priority.required ? undefined : 'Default' },
        );
    }

    const { fieldMemory = {} } = await chrome.storage.sync.get('fieldMemory');
    const memory = fieldMemory[$('project').value] ?? {};
    extraControls = [];
    renderFields($('extraFields'), pickExtraFields(currentFields), true, memory);
    const optional = pickOptionalFields(currentFields);
    renderFields($('optionalFields'), optional, false, memory);
    $('moreFields').hidden = !optional.length;
    $('moreCount').textContent = optional.length;
    $('moreFields').open = optional.some((f) => memory[fieldId(f)]);
    setStatus('');
    $('create').disabled = false;
}

function showLoadError(err) {
    setStatus(String(err.message ?? err), 'bad');
}

// Fields the form does not know by name get a control picked from their schema. `memory` holds what
// was picked last time in this project: { fieldId: { value, label } }.
function renderFields(box, fields, required, memory) {
    box.replaceChildren();
    for (const field of fields) {
        const id = `field-${fieldId(field)}`;
        const remembered = memory[fieldId(field)];
        const wrap = document.createElement('div');
        wrap.className = 'field';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = field.name;
        if (required) label.insertAdjacentHTML('beforeend', ' <span class="req" aria-hidden="true">*</span>');
        wrap.append(label);

        const kind = inputKind(field);
        let read = () => '';
        let snapshot = () => ({ value: read() });
        if (kind === 'select') {
            const select = document.createElement('select');
            select.className = 'select';
            select.id = id;
            const options = field.allowedValues.map((v) => ({ value: v.id, label: optionLabel(v) }));
            const preferred = options.some((o) => o.value === remembered?.value) ? remembered.value : field.defaultValue?.id;
            fillSelect(select, options, preferred, { placeholder: required ? 'Choose…' : 'None' });
            wrap.append(select);
            read = () => select.value;
        } else if (kind === 'user') {
            const picker = userPicker(id, remembered);
            wrap.append(picker.el);
            read = picker.read;
            snapshot = picker.snapshot;
        } else if (kind) {
            const input = document.createElement(kind === 'textarea' ? 'textarea' : 'input');
            input.className = kind === 'textarea' ? 'textarea' : 'input';
            if (kind !== 'textarea') input.type = { number: 'number', date: 'date', datetime: 'datetime-local' }[kind] ?? 'text';
            if (kind === 'list') input.placeholder = 'Comma separated';
            input.id = id;
            input.value = remembered?.value ?? '';
            wrap.append(input);
            read = () => input.value;
        } else {
            const note = document.createElement('p');
            note.className = 'hint';
            note.textContent = 'QA Report cannot fill this field type. Give it a default value in Jira or make it optional.';
            wrap.append(note);
        }
        box.append(wrap);
        extraControls.push({ field, kind, required, read, snapshot });
    }
}

function userPicker(id, remembered) {
    const el = document.createElement('div');
    el.className = 'picker';
    const input = document.createElement('input');
    input.className = 'input';
    input.id = id;
    input.placeholder = 'Type a name';
    input.autocomplete = 'off';
    const results = document.createElement('div');
    results.className = 'picker__results';
    results.hidden = true;
    const picked = document.createElement('div');
    picked.className = 'picker__picked';
    el.append(input, results, picked);

    let accountId = remembered?.value ?? '';
    input.value = remembered?.label ?? '';
    let timer;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        const query = input.value.trim();
        if (query.length < 2) {
            results.hidden = true;
            return;
        }
        timer = setTimeout(async () => {
            try {
                const users = await jiraGet(
                    `/user/assignable/search?project=${encodeURIComponent($('project').value)}&query=${encodeURIComponent(query)}&maxResults=20`,
                );
                results.replaceChildren(
                    ...users.map((u) => {
                        const b = document.createElement('button');
                        b.type = 'button';
                        b.textContent = u.displayName;
                        b.addEventListener('click', () => {
                            accountId = u.accountId;
                            input.value = u.displayName;
                            results.hidden = true;
                        });
                        return b;
                    }),
                );
                results.hidden = !users.length;
            } catch (err) {
                setStatus(String(err.message ?? err), 'bad');
            }
        }, 300);
    });
    input.addEventListener('change', () => {
        if (!input.value.trim()) accountId = '';
    });
    const read = () => (input.value.trim() ? accountId : '');
    return { el, read, snapshot: () => ({ value: read(), label: input.value.trim() }) };
}

// ---------------------------------------------------------------------------
// Screenshot annotation: pen, box, arrow, colour, undo, clear
// ---------------------------------------------------------------------------

let canvas, ctx;
let tool = 'pen';
let drawColor = '#ff3b30';
let drawing = false;
let startX = 0;
let startY = 0;
let strokeSnapshot = null;
let baseImageData = null;
let screenshotRemoved = false;
const history = [];
const STROKE_WIDTH = 6;

function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * canvas.width) / rect.width, y: ((e.clientY - rect.top) * canvas.height) / rect.height };
}

function drawRect(x0, y0, x1, y1) {
    ctx.strokeStyle = drawColor;
    ctx.lineWidth = STROKE_WIDTH;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function drawArrow(x0, y0, x1, y1) {
    ctx.strokeStyle = drawColor;
    ctx.fillStyle = drawColor;
    ctx.lineWidth = STROKE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = 24;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
}

function setupCanvas(dataUrl) {
    return new Promise((resolve) => {
        canvas = $('screenshotCanvas');
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        const img = new Image();
        img.onload = () => {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);
            baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            resolve();
        };
        img.src = dataUrl;
    });
}

function setupDrawingTools() {
    const tools = document.querySelectorAll('.toolbar .tool');
    tools.forEach((btn) =>
        btn.addEventListener('click', () => {
            tools.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
            tool = btn.dataset.tool;
        }),
    );
    $('drawColor').addEventListener('input', (e) => {
        drawColor = e.target.value;
    });
    $('undoDraw').addEventListener('click', () => {
        if (history.length) ctx.putImageData(history.pop(), 0, 0);
    });
    $('clearDraw').addEventListener('click', () => {
        history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
        ctx.putImageData(baseImageData, 0, 0);
    });
    // Reversible: the canvas is only hidden and left out of the upload.
    $('removeScreenshot').addEventListener('click', () => {
        screenshotRemoved = !screenshotRemoved;
        $('shot').classList.toggle('shot--off', screenshotRemoved);
        document.querySelectorAll('.toolbar .tool, #drawColor, #undoDraw, #clearDraw').forEach((el) => (el.disabled = screenshotRemoved));
        $('removeScreenshot').textContent = screenshotRemoved ? 'Restore screenshot' : 'Remove screenshot';
    });

    canvas.addEventListener('pointerdown', (e) => {
        drawing = true;
        canvas.setPointerCapture(e.pointerId);
        ({ x: startX, y: startY } = getPos(e));
        strokeSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
        history.push(strokeSnapshot);
        if (tool === 'pen') {
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.strokeStyle = drawColor;
            ctx.lineWidth = STROKE_WIDTH;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
        }
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const { x, y } = getPos(e);
        if (tool === 'pen') {
            ctx.lineTo(x, y);
            ctx.stroke();
            return;
        }
        ctx.putImageData(strokeSnapshot, 0, 0);
        if (tool === 'rect') drawRect(startX, startY, x, y);
        if (tool === 'arrow') drawArrow(startX, startY, x, y);
    });
    canvas.addEventListener('pointerup', () => (drawing = false));
    canvas.addEventListener('pointercancel', () => (drawing = false));
}

function setupPasteImage(el) {
    el.addEventListener('paste', (e) => {
        const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
        if (!item) return;
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => document.execCommand('insertImage', false, reader.result);
        reader.readAsDataURL(item.getAsFile());
    });
}

// ---------------------------------------------------------------------------
// Video: manual start and stop in this window, cropped to a dragged area, any number of clips
// ---------------------------------------------------------------------------

const VIDEO_AUTO_STOP_MS = 2 * 60 * 1000;
const VIDEO_BITS_PER_SECOND = 4_000_000; // ~57 MB for a full 2-minute 1080p clip; lower it if uploads hit your Jira size limit
const CROP_FRAME_RATE = 15;
const MAX_EMBED_WIDTH = 400; // the inline card size in Jira, not the recording size

// H.264 first: most Macs have no real-time hardware VP9 encoder, and software VP9 looks worse per bit.
const MIME_TYPE_CANDIDATES = ['video/mp4;codecs=avc1', 'video/mp4;codecs=h264', 'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
const pickMimeType = () => MIME_TYPE_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';

function scaledEmbedSize(width, height) {
    if (!width || !height || width <= MAX_EMBED_WIDTH) return { width, height };
    return { width: MAX_EMBED_WIDTH, height: Math.round((height * MAX_EMBED_WIDTH) / width) };
}

let autoStopTimer = null;
let displayStream = null;
let cropVideo = null;
let cropStream = null;
let cropRafId = null;
let recorder = null;
let chunks = [];
let recordingMimeType = null;
let recordingSize = null;
let clips = []; // { id, blob, url, target, width, height }
let nextClipId = 1;

function setVideoStatus(kind, text) {
    const el = $('videoStatus');
    el.className = `notice${kind ? ` notice--${kind}` : ''}`;
    el.hidden = false;
    el.textContent = text;
}

function stopStreams() {
    if (cropRafId != null) cancelAnimationFrame(cropRafId);
    cropRafId = null;
    cropVideo?.pause();
    cropVideo = null;
    cropStream?.getTracks().forEach((t) => t.stop());
    cropStream = null;
    displayStream?.getTracks().forEach((t) => t.stop());
    displayStream = null;
}

// Resolves to a rect in the video's own pixels, or null when cancelled.
function selectArea(stream) {
    return new Promise((resolve) => {
        const overlay = $('areaOverlay');
        const video = $('areaVideo');
        const box = $('areaBox');
        let dragStart = null;
        let rectCss = null;

        const onDown = (e) => {
            const r = video.getBoundingClientRect();
            dragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
            Object.assign(box.style, { left: `${dragStart.x}px`, top: `${dragStart.y}px`, width: '0px', height: '0px', display: 'block' });
            $('areaConfirm').disabled = true;
        };
        const onMove = (e) => {
            if (!dragStart) return;
            const r = video.getBoundingClientRect();
            const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
            const y = Math.min(Math.max(e.clientY - r.top, 0), r.height);
            rectCss = { x: Math.min(x, dragStart.x), y: Math.min(y, dragStart.y), w: Math.abs(x - dragStart.x), h: Math.abs(y - dragStart.y) };
            Object.assign(box.style, { left: `${rectCss.x}px`, top: `${rectCss.y}px`, width: `${rectCss.w}px`, height: `${rectCss.h}px` });
        };
        const onUp = () => {
            dragStart = null;
            $('areaConfirm').disabled = !rectCss || rectCss.w < 10 || rectCss.h < 10;
        };
        const toNative = (r) => {
            const sx = video.videoWidth / video.clientWidth;
            const sy = video.videoHeight / video.clientHeight;
            return { x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) };
        };
        const finish = (result) => {
            video.removeEventListener('pointerdown', onDown);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            $('areaFull').onclick = $('areaConfirm').onclick = $('areaCancel').onclick = null;
            overlay.style.display = 'none';
            video.pause();
            video.srcObject = null;
            box.style.display = 'none';
            $('areaConfirm').disabled = true;
            resolve(result);
        };

        video.srcObject = stream;
        video.addEventListener('pointerdown', onDown);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        $('areaFull').onclick = () => finish({ x: 0, y: 0, w: video.videoWidth, h: video.videoHeight });
        $('areaConfirm').onclick = () => rectCss && finish(toNative(rectCss));
        $('areaCancel').onclick = () => finish(null);
        overlay.style.display = 'flex';
        video.play().catch(() => {});
        $('areaFull').focus();
    });
}

// Draws the chosen region of the shared stream onto a canvas; MediaRecorder records the canvas.
function cropToArea(stream, rect) {
    cropVideo = document.createElement('video');
    cropVideo.srcObject = stream;
    cropVideo.muted = true;
    cropVideo.play().catch(() => {});
    const c = document.createElement('canvas');
    c.width = rect.w;
    c.height = rect.h;
    const c2d = c.getContext('2d');
    const draw = () => {
        c2d.drawImage(cropVideo, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        cropRafId = requestAnimationFrame(draw);
    };
    draw();
    return c.captureStream(CROP_FRAME_RATE);
}

function renderClips() {
    $('videoList').replaceChildren(
        ...clips.map((clip, index) => {
            const item = document.createElement('div');
            item.className = 'clip';
            const player = document.createElement('video');
            player.controls = true;
            player.src = clip.url;
            const row = document.createElement('div');
            row.className = 'clip__row';
            const label = document.createElement('label');
            label.textContent = `Clip ${index + 1}, show in`;
            const select = document.createElement('select');
            select.className = 'select';
            label.htmlFor = select.id = `clip-${clip.id}`;
            select.add(new Option('Attachments only', 'none'));
            for (const s of SECTIONS) select.add(new Option(s.label, s.key, false, s.key === clip.target));
            select.addEventListener('change', () => (clip.target = select.value));
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'btn btn--quiet btn--danger';
            del.textContent = 'Delete';
            del.addEventListener('click', () => {
                URL.revokeObjectURL(clip.url);
                clips = clips.filter((c) => c !== clip);
                renderClips();
            });
            row.append(label, select, del);
            item.append(player, row);
            return item;
        }),
    );
}

async function stopVideo(auto) {
    clearTimeout(autoStopTimer);
    $('startVideo').disabled = false;
    $('stopVideo').disabled = true;
    await new Promise((resolve) => {
        if (!recorder || recorder.state === 'inactive') return resolve();
        recorder.onstop = resolve;
        recorder.stop();
    });
    stopStreams();
    const blob = new Blob(chunks, { type: recordingMimeType.split(';')[0] });
    chunks = [];
    const size = scaledEmbedSize(recordingSize?.width, recordingSize?.height);
    clips.push({ id: nextClipId++, blob, url: URL.createObjectURL(blob), target: 'actual', ...size });
    renderClips();
    const mb = (blob.size / (1024 * 1024)).toFixed(1);
    setVideoStatus('ok', `Clip ${clips.length} saved, ${mb} MB${auto ? ', stopped at the 2-minute limit' : ''}.`);
}

function setupVideo(draft) {
    if (!draft.includeVideo) return;
    $('videoCard').hidden = false;
    $('startVideo').addEventListener('click', async () => {
        $('startVideo').disabled = true;
        setVideoStatus('', 'Choose what to share.');
        try {
            displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: CROP_FRAME_RATE } },
                audio: false,
            });
        } catch (err) {
            setVideoStatus('warn', err.name === 'NotAllowedError' ? 'Recording cancelled: nothing was shared.' : String(err.message ?? err));
            $('startVideo').disabled = false;
            return;
        }
        const rect = await selectArea(displayStream);
        if (!rect) {
            stopStreams();
            setVideoStatus('warn', 'Recording cancelled: no area chosen.');
            $('startVideo').disabled = false;
            return;
        }
        cropStream = cropToArea(displayStream, rect);
        recordingSize = { width: rect.w, height: rect.h };
        recordingMimeType = pickMimeType();
        chunks = [];
        recorder = new MediaRecorder(cropStream, { mimeType: recordingMimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder.start();
        setVideoStatus('rec', 'Recording. Reproduce the bug, then press Stop.');
        $('stopVideo').disabled = false;
        $('stopVideo').focus();
        autoStopTimer = setTimeout(() => stopVideo(true), VIDEO_AUTO_STOP_MS);
    });
    $('stopVideo').addEventListener('click', () => stopVideo(false));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const dataUrlToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();
const textBlob = (value, type = 'text/plain') => new Blob([value], { type });

async function mediaIdFor(attachmentId) {
    const res = await chrome.runtime.sendMessage({ type: 'RESOLVE_MEDIA_ID', attachmentId });
    return res?.mediaId ?? null;
}

function readExtraFields() {
    const values = {};
    const missing = [];
    for (const { field, kind, required, read } of extraControls) {
        const value = kind ? fieldValue(field, read()) : undefined;
        if (value !== undefined) values[fieldId(field)] = value;
        else if (required) missing.push(field.name);
    }
    return { values, missing };
}

async function create(draft) {
    const summary = $('summary').value.trim();
    if (!summary) {
        setStatus('Add a summary first.', 'bad');
        $('summary').setAttribute('aria-invalid', 'true');
        $('summary').focus();
        return;
    }
    $('summary').removeAttribute('aria-invalid');
    const { values: extraFields, missing } = readExtraFields();
    if (missing.length) {
        setStatus(`Required by Jira: ${missing.join(', ')}.`, 'bad');
        return;
    }
    if (currentFields.find((f) => fieldId(f) === 'reporter')?.required) {
        extraFields.reporter = { accountId: (await jiraGet('/myself')).accountId };
    }

    const createBtn = $('create');
    createBtn.disabled = true;
    createBtn.setAttribute('aria-busy', 'true');
    createBtn.textContent = 'Creating…';

    const sections = Object.fromEntries(SECTIONS.map((s) => [s.key, serializeRichField($(s.key))]));
    const { defaultLabels } = await chrome.storage.sync.get('defaultLabels');
    const payload = {
        projectKey: $('project').value,
        issueTypeId: $('issueType').value,
        summary,
        sections,
        priorityId: $('priorityField').hidden ? null : $('priority').value || null,
        labels: parseLabels(defaultLabels),
        extraFields,
        environment: { pageUrl: $('pageUrl').value.trim(), browser: browserLabel(), viewport: draft.viewport, capturedAt: draft.capturedAt },
    };

    let issue;
    try {
        setStatus('Creating the issue…');
        issue = await jiraSend('POST', '/issue', { fields: buildIssueFields(payload) });
    } catch (err) {
        setStatus(String(err.message ?? err), 'bad');
        createBtn.disabled = false;
        createBtn.removeAttribute('aria-busy');
        createBtn.textContent = 'Create issue';
        return;
    }

    // The issue exists from here on; anything that fails below is reported, not fatal.
    const problems = [];
    const attempt = async (label, fn) => {
        try {
            return await fn();
        } catch (err) {
            problems.push(`${label}: ${err.message ?? err}`);
            return null;
        }
    };

    setStatus(`Created ${issue.key}. Uploading attachments…`);
    const har = draft.harRecording ? (await chrome.runtime.sendMessage({ type: 'STOP_HAR', tabId: draft.tabId }))?.har : null;
    const files = [];
    if (!screenshotRemoved) files.push(['screenshot.png', () => dataUrlToBlob(canvas.toDataURL('image/png'))]);
    if (draft.consoleLogs.length) files.push(['console-log.txt', () => textBlob(formatConsoleLogs(draft.consoleLogs))]);
    if (draft.networkLogs.length) files.push(['network-log.txt', () => textBlob(formatNetworkLogs(draft.networkLogs))]);
    if (har) files.push(['network.har', () => textBlob(JSON.stringify(har, null, 2), 'application/json')]);
    await mapLimit(files, 3, ([name, blob]) => attempt(name, async () => uploadAttachment(issue.key, await blob(), name)));

    // Pasted images: upload, then swap their text notes for inline media.
    const mediaIds = {};
    let rewrite = false;
    for (const s of SECTIONS) {
        const images = sections[s.key].filter((p) => p.type === 'image');
        if (!images.length) continue;
        rewrite = true;
        mediaIds[s.key] = await mapLimit(images, 3, (part, i) =>
            attempt(`${s.key}-${i + 1}.png`, async () => {
                const att = await uploadAttachment(issue.key, await dataUrlToBlob(part.dataUrl), `${s.key}-${i + 1}.png`);
                return mediaIdFor(att.id);
            }),
        );
    }

    // Videos: always attached; embedded in the chosen section when a media id resolves, linked otherwise.
    const clipNodes = await mapLimit(clips, 3, (clip, i) =>
        attempt(`video ${i + 1}`, async () => {
            const name = `video-${i + 1}.${clip.blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
            const att = await uploadAttachment(issue.key, clip.blob, name);
            if (clip.target === 'none') return null;
            const mediaId = await mediaIdFor(att.id).catch(() => null);
            const node = mediaId
                ? mediaSingleNode(mediaId, clip.width, clip.height)
                : linkParagraph(`${settings.site}/secure/attachment/${att.id}/${encodeURIComponent(att.filename)}`, name);
            return { target: clip.target, node };
        }),
    );

    let description = buildDescriptionADF(payload, mediaIds);
    for (const item of clipNodes.filter(Boolean)) {
        rewrite = true;
        description = appendToSection(description, item.target, [item.node]);
    }
    if (rewrite) await attempt('inline images and video', () => jiraSend('PUT', `/issue/${issue.key}`, { fields: { description } }));

    const { issueTypeByProject = {}, fieldMemory = {} } = await chrome.storage.sync.get(['issueTypeByProject', 'fieldMemory']);
    const remembered = { ...fieldMemory[payload.projectKey] };
    // ponytail: long text is not remembered, chrome.storage.sync caps one item at 8 KB.
    for (const control of extraControls.filter((c) => c.kind && c.kind !== 'textarea')) {
        const entry = control.snapshot();
        if (entry.value && String(entry.value).length <= 200) remembered[fieldId(control.field)] = entry;
        else delete remembered[fieldId(control.field)];
    }
    await chrome.storage.sync
        .set({
            lastProjectKey: payload.projectKey,
            issueTypeByProject: { ...issueTypeByProject, [payload.projectKey]: payload.issueTypeId },
            fieldMemory: { ...fieldMemory, [payload.projectKey]: remembered },
        })
        .catch((err) => console.error('Could not remember the choices:', err));
    await chrome.storage.session.remove('bugDraft');

    const url = `${settings.site}/browse/${issue.key}`;
    if (!problems.length) {
        await chrome.tabs.create({ url });
        window.close();
        return;
    }
    setStatus(`Created ${issue.key}, but some uploads failed. ${problems.join(' ')}`, 'bad');
    createBtn.removeAttribute('aria-busy');
    createBtn.textContent = `Open ${issue.key}`;
    createBtn.disabled = false;
    createdUrl = url;
}

// ---------------------------------------------------------------------------

async function init() {
    const { bugDraft: draft } = await chrome.storage.session.get('bugDraft');
    if (!draft) {
        setStatus('Nothing captured yet. Use Capture bug in the toolbar popup.', 'bad');
        return;
    }

    await setupCanvas(draft.screenshot);
    setupDrawingTools();
    $('summary').value = draft.title ?? '';
    $('steps').textContent = `1. Open ${draft.url}\n2. `;
    $('pageUrl').value = draft.url;
    for (const s of SECTIONS) setupPasteImage($(s.key));

    $('consoleCount').textContent = draft.consoleLogs.length;
    $('consoleLog').textContent = formatConsoleLogs(draft.consoleLogs);
    if (draft.consoleLogs.length) $('consoleDetails').open = true;
    if (draft.networkLogs.length) {
        $('networkDetails').hidden = false;
        $('networkCount').textContent = draft.networkLogs.length;
        $('networkLog').textContent = formatNetworkLogs(draft.networkLogs);
    }
    if (draft.harWarning || draft.harRecording) {
        $('harStatus').hidden = false;
        $('harStatus').className = `notice notice--${draft.harWarning ? 'warn' : 'rec'}`;
        $('harStatus').textContent =
            draft.harWarning ?? 'Recording network traffic. Reproduce the bug again now to catch it; the recording stops and attaches when you create the issue.';
    }
    setupVideo(draft);

    $('cancel').addEventListener('click', () => window.close());
    $('create').addEventListener('click', async () => {
        if (!createdUrl) return create(draft);
        await chrome.tabs.create({ url: createdUrl });
        window.close();
    });

    settings = await getSettings();
    if (!isConfigured(settings)) {
        $('setupNotice').hidden = false;
        return;
    }
    $('summary').focus();
    await loadProjects().catch(showLoadError);
}

init();
