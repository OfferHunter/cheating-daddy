// 离线像素化：把一张照片降采样 + 每通道限色，导出随应用发布的小 PNG。
// 借 Electron 主进程的 nativeImage 做缩放与 PNG 编解码，无需额外依赖：
//   npx electron scripts/pixelate.js [源图] [输出] [宽度] [每通道色阶]
const { nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const source = process.argv[2] || path.join(__dirname, '..', 'sleep.png');
const output = process.argv[3] || path.join(__dirname, '..', 'src', 'assets', 'onboarding', 'capybara.png');
const width = Number(process.argv[4] || 112);
const levels = Number(process.argv[5] || 5);

const original = nativeImage.createFromPath(source);
if (original.isEmpty()) {
    console.error(`Cannot read image: ${source}`);
    process.exit(1);
}

const size = original.getSize();
const height = Math.max(1, Math.round((size.height / size.width) * width));
const small = original.resize({ width, height, quality: 'best' });

// 每通道量化到 levels 档（0..255 均分）。alpha 不动——照片是不透明的。
const bitmap = small.getBitmap();
const step = 255 / (levels - 1);
for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = Math.round(Math.round(bitmap[i] / step) * step);
    bitmap[i + 1] = Math.round(Math.round(bitmap[i + 1] / step) * step);
    bitmap[i + 2] = Math.round(Math.round(bitmap[i + 2] / step) * step);
}

const pixelated = nativeImage.createFromBitmap(bitmap, { width, height });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, pixelated.toPNG());
console.log(`Wrote ${output} (${width}x${height}, ${levels} levels/channel)`);
// 主进程没有窗口和监听器也不会自己退出，脚本干完必须显式结束，否则调用方一直等。
process.exit(0);
