const { getConfig, getDeepseekApiKey, getChatMaxTokens } = require('../storage');

const DEFAULT_CHAT_BASE_URL = 'https://api.deepseek.com';
// 覆盖整条流式响应而不只是头。它是**总预算**（请求发出时创建），不是空闲超时：思考的时间也算在里面，
// 一张截图加一整道题有可能把 120s 全烧在推理上，最后什么都没返回。
const CHAT_TIMEOUT_MS = 120000;

function getChatBaseUrl() {
    const configured = (getConfig().chatBaseUrl || '').trim();
    return configured ? configured.replace(/\/+$/, '') : DEFAULT_CHAT_BASE_URL;
}

function getChatModel() {
    return getConfig().deepseekModel || 'deepseek-flash';
}

async function readStreamingResponse(response, onText) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let fullText = '';
    let finishReason = '';
    // 按 `index` 归并，因为这是每个分片都一定带的字段——`id` 只在第一片里出现。
    const toolCallsByIndex = new Map();

    for await (const chunk of response.body) {
        pendingText += decoder.decode(chunk, { stream: true });
        const lines = pendingText.split('\n');
        pendingText = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            let choice;
            try {
                // 推理模型先吐 reasoning_content，这里只用最终的 content（提词器不显示思考过程）。
                choice = JSON.parse(data).choices?.[0];
            } catch {
                continue;
            }
            if (!choice) continue;

            const delta = choice.delta || {};

            // 有内容才累积，但下面任何一步都不能因为「这个分片没有 content」而提前 continue：调用工具的
            // 那个分片只有 tool_calls 和 finish_reason，没有 content，提前 continue 会整条丢掉这次调用。
            const token = delta.content || '';
            if (token) {
                fullText += token;
                onText(fullText);
            }

            for (const call of delta.tool_calls || []) {
                const index = call.index ?? 0;
                let slot = toolCallsByIndex.get(index);
                if (!slot) {
                    slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
                    toolCallsByIndex.set(index, slot);
                }
                if (call.id) slot.id = call.id;
                // 名字和参数都是分片，要拼接，不是整值。
                if (call.function?.name) slot.function.name += call.function.name;
                if (call.function?.arguments) slot.function.arguments += call.function.arguments;
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
        }
    }

    const toolCalls = [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);

    return { text: fullText, toolCalls, finishReason };
}

async function streamOnce(body, onText) {
    const apiKey = getDeepseekApiKey();

    const response = await fetch(`${getChatBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text().catch(() => '');
        const error = new Error(`Chat API returned HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
        // 留给调用方：只有正文点名了哪个字段，才能区分「这个服务不支持 tools」和「请求因别的原因被拒」。
        error.status = response.status;
        error.body = errorText;
        throw error;
    }

    return readStreamingResponse(response, onText);
}

// `onText` 每次收到的是**到此为止的全部文本**，不是增量——包括已经结束的那几轮，因为返回的 `text`
// 也是跨轮累积的。
//
// tools/maxToolRounds/executeTool/maxTokens/thinking/followUpSystem 全部可选，都不传就是一次普通请求。
//
// `maxToolRounds` 数的是**工具**轮而不是请求数：1 表示模型可以调一次工具，然后额外拿到一次请求来作答
// （tools 仍然声明着，但 tool_choice 变成 'none'）。这里不能改成直接撤掉 tools：上下文里留着
// tool_calls/tool 消息却没有任何声明，严格的 OpenAI 兼容服务会直接 400。
async function requestChat(messages, onText, options = {}) {
    const {
        tools = null,
        maxToolRounds = 0,
        executeTool = null,
        // 每次调用现读，不缓存：设置里改完下一个回答就生效。
        // 它同时管住回答和回答背后的思考——开了 thinking 的请求，推理也从这笔预算里扣，难题光是推理就能
        // 把它花光，于是调用方收到的是一条没有任何文本的响应。
        maxTokens = getChatMaxTokens(),
        thinking,
        followUpSystem = null,
    } = options;

    const apiKey = getDeepseekApiKey();
    if (!apiKey || !apiKey.trim()) {
        throw new Error('No chat API key configured');
    }

    const convo = [...messages];
    // 两个不同的问题：这次请求要不要声明 `tools`，以及模型准不准调工具。两者只在最后一轮分道扬镳。
    let declareTools = Boolean(tools && tools.length);
    // `thinking` 是三态：`true` 要推理模式，`false` 关掉它，`undefined` 是**什么都不说**、用端点自己的
    // 默认值——也就是请求里干脆不带这个字段，所以下面剥字段重试时，端点照样能拿到一个可用的 body。
    let thinkingBody = thinking === true ? { type: 'enabled' } : thinking === false ? { type: 'disabled' } : null;
    // 端点一旦拒过这个字段，本次调用剩下的轮次都不再带它。
    let sendMaxTokens = true;
    let rounds = 0;
    // 已经结束的每一轮的文本，用空行拼接。
    let committed = '';
    let text = '';
    let finishReason = '';
    let toolCalls = [];

    for (;;) {
        // 各轮之间用空行拼接，流式文本和最终返回的文本都一样：只在结束时补前缀会让调用方的文字在轮次
        // 切换时可见地跳一下。
        const prefix = committed ? `${committed}\n\n` : '';

        // 追问轮不能再重复模型已经用过的知识库规则和索引：条目本身已经在对话里了，再给一遍索引等于邀请它
        // 去查，而 tool_choice: 'none' 反正会拒掉。判角色是为了不误伤第一条消息不是 system 的调用方。
        if (rounds > 0 && followUpSystem && convo[0]?.role === 'system') {
            convo[0] = { role: 'system', content: followUpSystem };
        }

        const body = {
            model: getChatModel(),
            messages: convo,
            stream: true,
        };

        if (sendMaxTokens) body.max_tokens = maxTokens;

        if (declareTools) {
            body.tools = tools;
            body.tool_choice = rounds < maxToolRounds ? 'auto' : 'none';
        }

        if (thinkingBody) body.thinking = thinkingBody;

        let round;
        try {
            round = await streamOnce(body, partial => onText(prefix + partial));
        } catch (error) {
            // `tools`、`thinking`、token 上限这三样少了都能活，而点名其中之一的 400 正好说了是哪个。
            // 把正文抱怨的字段一次全剥掉、重试一次——不能写成嵌套重试，否则同时被拒两个字段时只会剥掉内层
            // 那一个。上限是用户能设成超过端点允许值的那一项，没有这段，设置里打错一个数字会让之后每个
            // 请求都失败，直到改回去为止。
            const errorBody = error.body || '';
            const rejected = error.status === 400 && errorBody;
            const dropTools = rejected && declareTools && /tools|tool_choice/i.test(errorBody);
            const dropThinking = rejected && thinkingBody && /thinking/i.test(errorBody);
            const dropMaxTokens = rejected && sendMaxTokens && /max_tokens/i.test(errorBody);
            if (!dropTools && !dropThinking && !dropMaxTokens) throw error;

            const dropped = [dropTools ? 'tools' : '', dropThinking ? 'thinking' : '', dropMaxTokens ? 'max_tokens' : '']
                .filter(Boolean)
                .join('+');
            console.warn(`Chat endpoint rejected ${dropped}, retrying without: ${errorBody}`);

            if (dropTools) {
                declareTools = false;
                delete body.tools;
                delete body.tool_choice;
            }
            if (dropThinking) {
                thinkingBody = null;
                delete body.thinking;
            }
            if (dropMaxTokens) {
                sendMaxTokens = false;
                delete body.max_tokens;
            }

            round = await streamOnce(body, partial => onText(prefix + partial));
        }

        // 只调工具的那一轮往往没有自己的文本，那就不带上它，免得正式回答前面多出一个空行。
        if (round.text) {
            text = prefix + round.text;
            committed = text;
        }
        finishReason = round.finishReason;

        const calls = round.toolCalls;
        const canContinue =
            finishReason === 'tool_calls' &&
            calls.length > 0 &&
            // 每个调用都要用 id 回填结果，所以缺 id 的分片没法往下续。
            calls.every(call => call.id) &&
            typeof executeTool === 'function' &&
            rounds < maxToolRounds;
        if (!canContinue) break;

        convo.push({ role: 'assistant', content: round.text || null, tool_calls: calls });

        for (const call of calls) {
            let output;
            try {
                output = await executeTool(call.function.name, call.function.arguments);
            } catch (error) {
                // 只有这一轮，没有重试要保护：把失败当工具结果交回去，让模型自己绕开它作答。
                output = `工具执行失败：${error.message}`;
            }
            convo.push({ role: 'tool', tool_call_id: call.id, content: output });
        }

        toolCalls = calls;
        rounds += 1;
    }

    return { text, finishReason, rounds, toolCalls };
}

module.exports = {
    getChatModel,
    requestChat,
};
