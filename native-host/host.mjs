// Chrome Native Messaging host: runs the local `claude` or `codex` CLI on a prompt from the
// extension and returns its text. Chrome starts it through the wrapper install.sh (host.sh) or
// install.ps1 (host.bat) writes, which restores the PATH the CLIs were found on.
// Protocol: 4-byte little-endian length + JSON, one request per process. Chrome keeps stdin
// open, so the request ends at its declared length, not at EOF.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 180_000;

function readMessage() {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        process.stdin.on('data', (c) => {
            buf = Buffer.concat([buf, c]);
            if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
            process.stdin.pause();
            resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8')));
        });
        process.stdin.on('end', () => reject(new Error('request ended early')));
    });
}

function writeMessage(msg) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([len, body]), () => process.exit(0));
}

const IS_WIN = process.platform === 'win32';
const has = (bin) => spawnSync(IS_WIN ? 'where' : 'which', [bin]).status === 0;

// No tools, no MCP, no session file: the CLI only reads the prompt and answers. Runs in an empty
// temp dir so no project CLAUDE.md / AGENTS.md leaks into the answer.
const ENGINES = {
    claude: () => ({
        cmd: 'claude',
        args: ['-p', '--output-format', 'text', '--tools', '', '--strict-mcp-config', '--no-session-persistence'],
    }),
    codex: (dir) => ({
        cmd: 'codex',
        args: ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-o', join(dir, 'out.txt'), '-'],
        outFile: join(dir, 'out.txt'),
    }),
};

function run(engine, prompt) {
    const dir = mkdtempSync(join(tmpdir(), 'qa-ai-'));
    const { cmd, args, outFile } = ENGINES[engine](dir);
    return new Promise((resolve) => {
        // npm installs claude.cmd / codex.cmd on Windows, which only start through the shell; the
        // shell joins args unescaped, so each is quoted (keeps the empty --tools value).
        const child = IS_WIN
            ? spawn(cmd, args.map((a) => `"${a}"`), { cwd: dir, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
            : spawn(cmd, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        child.on('error', (e) => (err += e.message));
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            try {
                if (signal) return resolve({ ok: false, code: 'TIMEOUT', engine, error: `${engine} did not answer in ${TIMEOUT_MS / 1000}s` });
                // codex prints its whole session header to stderr; the ERROR line is the useful part
                const lines = (err || out).trim().split('\n');
                const error = lines.filter((l) => /error/i.test(l)).pop() ?? lines.slice(-5).join('\n');
                if (code !== 0) return resolve({ ok: false, code: 'CLI_FAILED', engine, error: error.slice(0, 800) });
                resolve({ ok: true, engine, text: outFile ? readFileSync(outFile, 'utf8') : out });
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        child.stdin.end(prompt);
    });
}

try {
    const { engine = 'auto', prompt } = await readMessage();
    const installed = Object.keys(ENGINES).filter(has);
    const pick = engine === 'auto' ? installed[0] : installed.find((e) => e === engine);
    writeMessage(
        pick
            ? await run(pick, prompt)
            : { ok: false, code: 'NO_ENGINE', engine, installed, error: `${engine === 'auto' ? 'claude or codex' : engine} not found on PATH` },
    );
} catch (e) {
    writeMessage({ ok: false, code: 'HOST_ERROR', error: String(e.message ?? e) });
}
