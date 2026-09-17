const { getConfig, getSiliconflowApiKey } = require('../storage');

const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

function getSiliconFlowModel() {
    return getConfig().siliconflowModel || 'FunAudioLLM/SenseVoiceSmall';
}

async function transcribe(wavBuffer, language) {
    const apiKey = getSiliconflowApiKey();
    if (!apiKey || !apiKey.trim()) {
        throw new Error('No SiliconFlow API key configured');
    }

    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', getSiliconFlowModel());
    form.append('response_format', 'json');
    if (language) {
        form.append('language', language);
    }

    const response = await fetch(`${SILICONFLOW_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: form,
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`SiliconFlow returned HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
    }

    const payload = await response.json().catch(() => null);
    return payload?.text || '';
}

module.exports = {
    getSiliconFlowModel,
    transcribe,
};
