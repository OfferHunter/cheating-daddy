const { getConfig } = require('../storage');
const { createBailianAsr } = require('./bailianAsr');
const { createTencentAsr } = require('./tencentAsr');

// 语音识别服务分发：所有调用方都只认这一个工厂，接口与两个 provider 完全一致
// （{ maxSentenceSilenceMs, onSentence, onState, onError }）。选哪家默认读配置里的 asrProvider，
// 只有「API 配置」页的试听要覆盖它——那里在翻到哪一页就试哪一家，与当前启用的是不是它无关。
//
// 各家自己的语言、引擎、凭据由各自的 client 从配置/凭据里读，所以这里不需要透传这些参数。
function createRealtimeAsr(options = {}) {
    const provider = options.provider || getConfig().asrProvider || 'bailian';
    return provider === 'tencent' ? createTencentAsr(options) : createBailianAsr(options);
}

module.exports = {
    createRealtimeAsr,
};
