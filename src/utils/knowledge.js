const fs = require('fs');
const path = require('path');

// A knowledge directory is a plain folder of `.md` files, one entry each, laid out the way a skill
// directory is: a small frontmatter block carries the summary, the rest of the file is the content.
// Only the summaries ever reach the model; the content is pulled in on demand by load_knowledge, so a
// large directory costs a list of one-liners in the prompt rather than its own weight in tokens.
const KNOWLEDGE_TOOL_NAME = 'load_knowledge';

// Both the summary and the content are bounded: the directory belongs to the user and nothing stops it
// from holding a hundred files or a book. The summary caps are what keep the system prompt predictable.
const MAX_ENTRIES = 50;
const MAX_SUMMARY_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 160;
const MAX_BODY_CHARS = 20000;
const MAX_FILE_BYTES = 512 * 1024;

const KNOWLEDGE_TOOL_SPEC = {
    type: 'function',
    function: {
        name: KNOWLEDGE_TOOL_NAME,
        description:
            '读取知识库中某个条目的完整正文。系统提示里有条目索引（格式为「id：名称 — 摘要」）。仅当当前问题与某个条目的摘要直接相关时才调用，且每次回答最多调用一次。',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: '要读取的知识条目 id，必须来自系统提示里的知识库索引。',
                },
            },
            required: ['id'],
            additionalProperties: false,
        },
    },
};

function unquote(value) {
    const first = value[0];
    if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
        return value.slice(1, -1);
    }
    return value;
}

// Markdown markers are stripped so a description can be pasted straight into the prompt index, where a
// stray `**` around a term would read as noise rather than emphasis.
function toPlainLine(text) {
    return text
        .replace(/^#+\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// A deliberately small subset of YAML: scalars and `- ` lists, no nesting and no block scalars. This
// is a header block a person types by hand, and a real parser would only buy support for shapes nobody
// writes here — while failing closed on the ones that do appear would lose the entry entirely.
function parseFrontmatter(raw) {
    const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
    if (!match) {
        return { meta: {}, body: text, hasFrontmatter: false };
    }

    const meta = {};
    let lastKey = null;

    for (const line of match[1].split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const listItem = /^-\s+(.*)$/.exec(trimmed);
        if (listItem && lastKey) {
            const value = unquote(listItem[1].trim());
            meta[lastKey] = meta[lastKey] ? `${meta[lastKey]}, ${value}` : value;
            continue;
        }

        const colon = line.indexOf(':');
        if (colon === -1) continue;

        const key = line.slice(0, colon).trim().toLowerCase();
        if (!key) continue;

        // A block scalar keeps its marker: `|` and `>` are read as the literal characters, which is
        // honest about not supporting them, and the body fallback below is what actually covers it.
        meta[key] = unquote(line.slice(colon + 1).trim());
        lastKey = key;
    }

    return { meta, body: text.slice(match[0].length), hasFrontmatter: true };
}

// What a file with no usable frontmatter still has: a first heading to name it with and a first line of
// prose to describe it.
function extractFallbacks(body) {
    let heading = '';
    let paragraph = '';

    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (!heading) {
            const found = /^#{1,6}\s+(.*)$/.exec(trimmed);
            if (found) {
                heading = toPlainLine(found[1]);
                continue;
            }
        }

        if (!paragraph && !trimmed.startsWith('#')) paragraph = toPlainLine(trimmed);
        if (heading && paragraph) break;
    }

    return { heading, paragraph };
}

// The only place a file is opened, which is what makes the checks here load-bearing. `name` comes from
// a readdir of the directory itself, so it cannot contain a separator, but a symlink inside the
// directory can still point out of it — hence the realpath containment test rather than a join.
function readEntry(dir, name) {
    const resolvedDir = path.resolve(dir);
    const resolvedFile = path.resolve(resolvedDir, name);

    if (path.dirname(resolvedFile) !== resolvedDir) return null;
    if (path.extname(resolvedFile).toLowerCase() !== '.md') return null;

    try {
        const realDir = fs.realpathSync(resolvedDir);
        const realFile = fs.realpathSync(resolvedFile);
        if (!realFile.startsWith(realDir + path.sep)) return null;

        const stats = fs.statSync(realFile);
        if (!stats.isFile()) return null;
        if (stats.size > MAX_FILE_BYTES) {
            console.warn('[Knowledge] Skipping oversized entry:', name, stats.size);
            return null;
        }

        const raw = fs.readFileSync(realFile, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const { heading, paragraph } = extractFallbacks(body);

        // The filename is the id, so the model can only ever name something that already exists here.
        const id = name.slice(0, -3);
        const entryName = toPlainLine(meta.name || meta.title || heading || id) || id;
        const description = (meta.description || paragraph || '').slice(0, MAX_DESCRIPTION_CHARS);

        return { id, name: entryName, description, file: name, body };
    } catch (error) {
        console.warn('[Knowledge] Cannot read entry:', name, error.message);
        return null;
    }
}

// Never throws: an unset, missing or unreadable directory is a state the settings page has to be able to
// render, and a session that starts against one must still be able to answer without knowledge.
function listKnowledgeEntries(dir) {
    if (!dir) return [];

    let names;
    try {
        names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        console.warn('[Knowledge] Cannot read directory:', dir, error.message);
        return [];
    }

    const entries = [];
    for (const item of names) {
        if (!item.isFile() || !item.name.toLowerCase().endsWith('.md')) continue;

        const entry = readEntry(dir, item.name);
        if (entry) entries.push(entry);
    }

    entries.sort((a, b) => a.id.localeCompare(b.id));
    return entries;
}

// Runs against the entries list rather than the filesystem, so the id is matched against names that were
// just enumerated — there is no path to build and nothing to traverse out of.
function readKnowledgeById(dir, id) {
    if (!dir) return { ok: false, error: '未配置知识目录。' };

    const wanted = String(id ?? '').trim();
    if (!wanted) return { ok: false, error: '缺少参数 id。' };

    const entries = listKnowledgeEntries(dir);
    const entry = entries.find(candidate => candidate.id === wanted);

    if (!entry) {
        // Only one tool call is allowed per answer, so the model gets no chance to correct itself: the
        // error carries the ids that do exist, which is the only way it can still use the tool.
        const available = entries.slice(0, MAX_ENTRIES).map(candidate => candidate.id);
        return {
            ok: false,
            error: available.length
                ? `没有这个知识条目：${wanted}。可用条目：${available.join('、')}`
                : `没有这个知识条目：${wanted}。当前知识目录里没有可用的条目。`,
        };
    }

    const body = entry.body.length > MAX_BODY_CHARS ? `${entry.body.slice(0, MAX_BODY_CHARS)}\n\n（正文过长，已截断）` : entry.body;

    return { ok: true, id: entry.id, name: entry.name, description: entry.description, body };
}

// The index that goes into the detail prompt. Empty when there is nothing to load, which is also what
// tells the caller not to attach the tool at all.
function formatKnowledgeSummary(entries) {
    if (!entries || !entries.length) return '';

    const lines = [];
    let used = 0;
    let omitted = 0;

    for (const entry of entries) {
        const description = entry.description.replace(/\s+/g, ' ').trim();
        const line = `- ${entry.id}：${entry.name}${description ? ` — ${description}` : ''}`;

        if (lines.length >= MAX_ENTRIES || used + line.length > MAX_SUMMARY_CHARS) {
            omitted += 1;
            continue;
        }

        lines.push(line);
        used += line.length;
    }

    if (!lines.length) return '';

    const tail = omitted > 0 ? `\n（另有 ${omitted} 个条目未列出）` : '';
    return ['知识库（下面是条目索引；正文需要调用 load_knowledge 获取，仅当与当前问题直接相关时才调用）：', ...lines].join('\n') + tail;
}

// Returns a string in every case, including every failure — it is a tool result, not an exception path,
// and a throw here would take down the whole answer rather than just this one lookup.
function executeKnowledgeTool(name, argsJson, dir) {
    try {
        if (name !== KNOWLEDGE_TOOL_NAME) {
            return `没有这个工具：${name}`;
        }

        let args;
        try {
            args = argsJson ? JSON.parse(argsJson) : {};
        } catch {
            return 'load_knowledge 的参数不是合法 JSON。正确形式：{"id": "条目id"}';
        }

        const result = readKnowledgeById(dir, args && args.id);
        return result.ok ? result.body : result.error;
    } catch (error) {
        console.error('[Knowledge] Tool execution failed:', error);
        return `读取知识条目失败：${error.message}`;
    }
}

module.exports = {
    KNOWLEDGE_TOOL_NAME,
    KNOWLEDGE_TOOL_SPEC,
    listKnowledgeEntries,
    readKnowledgeById,
    formatKnowledgeSummary,
    executeKnowledgeTool,
};
