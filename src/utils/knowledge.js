const fs = require('fs');
const path = require('path');

// 知识库就是一个放 `.md` 的普通文件夹，一个文件一个条目：开头一小段 frontmatter 是摘要，剩下的是正文。
// 只有摘要进提示词，正文靠 load_knowledge 按需拉取——所以再大的知识库也只是提示词里一串一行话，
// 而不是它自身的体量。
const KNOWLEDGE_TOOL_NAME = 'load_knowledge';

// 摘要和正文都有上限：目录是用户自己的，塞进一百个文件或一整本书都没人拦着。摘要的上限决定了系统提示词
// 的长度可控。
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

// 去掉 Markdown 标记，好让描述直接拼进提示词索引——索引里的 `**` 只会读成噪音，不表示强调。
function toPlainLine(text) {
    return text
        .replace(/^#+\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// 故意只支持 YAML 的一小撮：标量和 `- ` 列表，没有嵌套、没有块标量。这种头部是人手打的，上真解析器只会
// 换来没人会写的写法支持，而真出现不支持的写法时又会整条丢弃。
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

        // 块标量原样保留：`|` 和 `>` 就当普通字符读，等于明说支持不了它；真正兜住这种情况的是后面的
        // extractFallbacks。
        meta[key] = unquote(line.slice(colon + 1).trim());
        lastKey = key;
    }

    return { meta, body: text.slice(match[0].length), hasFrontmatter: true };
}

// 没有可用 frontmatter 的文件还能凑出什么：第一个标题当名字，第一行正文当描述。
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

// 全模块唯一真正打开文件的地方，所以这里的检查是承重的。`name` 来自目录自身的 readdir，不含路径分隔符，
// 但目录里的软链接仍可能指向外面——所以要用 realpath 判断包含关系，而不是拼一个路径就完事。
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

        // 文件名就是 id，所以模型只能点到确实存在的条目。
        const id = name.slice(0, -3);
        const entryName = toPlainLine(meta.name || meta.title || heading || id) || id;
        const description = (meta.description || paragraph || '').slice(0, MAX_DESCRIPTION_CHARS);

        return { id, name: entryName, description, file: name, body };
    } catch (error) {
        console.warn('[Knowledge] Cannot read entry:', name, error.message);
        return null;
    }
}

// 永不抛异常：目录没设、不存在或读不了，都是设置页必须能正常渲染的状态，会话在这种情况下也得能照常作答。
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

// 在已列出的条目数组里查，不再碰文件系统：id 是跟刚枚举出来的名字比对的，没有路径可拼，也没有目录能穿出去。
function readKnowledgeById(dir, id) {
    if (!dir) return { ok: false, error: '未配置知识目录。' };

    const wanted = String(id ?? '').trim();
    if (!wanted) return { ok: false, error: '缺少参数 id。' };

    const entries = listKnowledgeEntries(dir);
    const entry = entries.find(candidate => candidate.id === wanted);

    if (!entry) {
        // 每个回答只准调一次工具，模型没有机会自我纠正：错误里必须带上真实存在的 id，它才可能用上这个工具。
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

// 拼进详细提示词的索引。没有可读条目时返回空串——调用方也正是靠这个空串决定连工具都不声明。
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

// 任何情况都返回字符串，失败也一样：它是工具结果而不是异常路径，在这里抛出去会把整个回答搞没，而不只是
// 这一次查询失败。
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
