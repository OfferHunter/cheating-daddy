const { getConfig, getDeepseekApiKey } = require('../storage');

const DEFAULT_CHAT_BASE_URL = 'https://api.deepseek.com';
const CHAT_MAX_TOKENS = 8192;
// Covers the whole streamed response, not just the headers. Without it a stalled stream would
// leave the caller's in-flight guard latched forever and silently eat every later turn.
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
    // Keyed by the call's `index`, because that is the only field guaranteed to be present on every
    // fragment — `id` arrives once, with the first one.
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
                // Thinking models emit delta.reasoning_content first; only the final answer is shown.
                choice = JSON.parse(data).choices?.[0];
            } catch {
                continue;
            }
            if (!choice) continue;

            const delta = choice.delta || {};

            // Accumulate content only when there is some. Nothing below may skip the chunk on an empty
            // token: a tool-calling chunk carries `tool_calls` and `finish_reason` and no content at all,
            // so an early `continue` here would swallow the entire tool call.
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
                // Both arrive as fragments to be concatenated, not whole values.
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
        // Kept for the caller: only a body that names the offending field can tell a server that
        // does not support `tools` from one rejecting the request for another reason.
        error.status = response.status;
        error.body = errorText;
        throw error;
    }

    return readStreamingResponse(response, onText);
}

// `onText` receives the whole text so far on every token, never a delta — including the text of any
// rounds that already finished, since the returned `text` accumulates across tool rounds too.
//
// tools/maxToolRounds/executeTool/thinking/followUpSystem are all optional. With none of them this is
// a single plain request, byte for byte the same body as before the knowledge feature existed.
//
// `maxToolRounds` counts *tool* rounds, not requests: 1 means the model may call a tool once and is
// then given one more request to answer in, with tools still declared but `tool_choice: 'none'`.
// Dropping the field instead would leave `tool_calls`/`tool` messages in the context with nothing
// declaring them, which some strict OpenAI-compatible servers reject with a 400.
async function requestChat(messages, onText, options = {}) {
    const {
        tools = null,
        maxToolRounds = 0,
        executeTool = null,
        maxTokens = CHAT_MAX_TOKENS,
        thinking,
        followUpSystem = null,
    } = options;

    const apiKey = getDeepseekApiKey();
    if (!apiKey || !apiKey.trim()) {
        throw new Error('No chat API key configured');
    }

    const convo = [...messages];
    // Two separate questions: whether the request declares `tools` at all, and whether the model is
    // allowed to call one. They part ways on the last round.
    let declareTools = Boolean(tools && tools.length);
    // Only `false` is ever sent, so an endpoint that has never heard of the field is never bothered
    // by a default-on switch — and an endpoint that rejects it stays quiet for the rest of the turn.
    let disableThinking = thinking === false;
    let rounds = 0;
    // Text from every round that has already finished, joined by a blank line.
    let committed = '';
    let text = '';
    let finishReason = '';
    let toolCalls = [];

    for (;;) {
        // Rounds are joined by a blank line, in the streamed text as much as in the returned one: a
        // prefix applied only at the end would make the caller's text visibly jump when a round closes.
        const prefix = committed ? `${committed}\n\n` : '';

        // The follow-up must not repeat the knowledge rule and index the model has already acted on:
        // the entry itself is in the conversation by then, and showing the index again invites a
        // lookup that `tool_choice: 'none'` would refuse anyway. Guarded on the role so a caller
        // whose first message is not a system prompt is left alone rather than losing it.
        if (rounds > 0 && followUpSystem && convo[0]?.role === 'system') {
            convo[0] = { role: 'system', content: followUpSystem };
        }

        const body = {
            model: getChatModel(),
            messages: convo,
            stream: true,
            max_tokens: maxTokens,
        };

        if (declareTools) {
            body.tools = tools;
            body.tool_choice = rounds < maxToolRounds ? 'auto' : 'none';
        }

        if (disableThinking) body.thinking = { type: 'disabled' };

        let round;
        try {
            round = await streamOnce(body, partial => onText(prefix + partial));
        } catch (error) {
            // `tools` and `thinking` are both additions the app can live without, and a 400 that
            // names one of them says exactly which. Strip every field the message complains about
            // and retry once — together, not as nested retries, or a body rejected for both would
            // only shed whichever field the inner handler happened to look at.
            const errorBody = error.body || '';
            const rejected = error.status === 400 && errorBody;
            const dropTools = rejected && declareTools && /tools|tool_choice/i.test(errorBody);
            const dropThinking = rejected && disableThinking && /thinking/i.test(errorBody);
            if (!dropTools && !dropThinking) throw error;

            const dropped = [dropTools ? 'tools' : '', dropThinking ? 'thinking' : ''].filter(Boolean).join('+');
            console.warn(`Chat endpoint rejected ${dropped}, retrying without: ${errorBody}`);

            if (dropTools) {
                declareTools = false;
                delete body.tools;
                delete body.tool_choice;
            }
            if (dropThinking) {
                disableThinking = false;
                delete body.thinking;
            }

            round = await streamOnce(body, partial => onText(prefix + partial));
        }

        // A round that only calls a tool often has no text of its own; it contributes nothing rather
        // than leaving a stray blank line in front of the answer.
        if (round.text) {
            text = prefix + round.text;
            committed = text;
        }
        finishReason = round.finishReason;

        const calls = round.toolCalls;
        const canContinue =
            finishReason === 'tool_calls' &&
            calls.length > 0 &&
            // Every call must be answered by id, so a fragment without one cannot be continued past.
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
                // One round only, so there is no retry to protect: the model gets the failure as the
                // tool's result and answers around it instead.
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
    getChatBaseUrl,
    getChatModel,
    requestChat,
};
