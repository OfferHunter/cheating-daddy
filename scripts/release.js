const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// 随发布一起打包的源码条目：够在别处重新构建即可，不含 .gitignore（版本库专属）。
const SOURCE_ENTRIES = [
    'src', 'scripts', 'package.json', 'package-lock.json', 'forge.config.js',
    'entitlements.plist', 'LICENSE', 'README.md', '.prettierrc', '.prettierignore',
];

function inside(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path must be inside the workspace: ${target}`);
    }
    return target;
}

// 取舍整份交给 .gitignore：让 git 列出"未被忽略"的文件（已跟踪 + 未跟踪但没被忽略的），
// 排除规则只在 .gitignore 维护一处，这里不再另抄一份。
async function unignoredFiles(root) {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(stdout.split('\0').filter(Boolean));
}

async function copySource(root, destination) {
    const files = await unignoredFiles(root);
    // 目录只在"其下确有要打包的文件"时才创建，免得留下空目录（如被忽略的 src/data）。
    const dirs = new Set();
    for (const file of files) {
        for (let dir = path.posix.dirname(file); dir !== '.' && !dirs.has(dir); dir = path.posix.dirname(dir)) dirs.add(dir);
    }
    await fs.mkdir(destination, { recursive: true });
    for (const entry of SOURCE_ENTRIES) {
        const source = path.join(root, entry);
        await fs.cp(source, path.join(destination, entry), {
            recursive: true,
            filter: async file => {
                const relative = path.relative(root, file).split(path.sep).join('/');
                const segments = relative.split('/');
                // .git 与 .gitignore 自身永远不进包，即便 git 眼里它们"未被忽略"。
                if (segments.includes('.git') || segments[segments.length - 1] === '.gitignore') return false;
                const stats = await fs.lstat(file);
                if (stats.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${relative}`);
                return stats.isDirectory() ? dirs.has(relative) : files.has(relative);
            },
        });
    }
}

async function release({ root = path.resolve(__dirname, '..'), forge, config } = {}) {
    root = await fs.realpath(root);
    const output = inside(root, path.join(root, 'out'));
    await fs.mkdir(output, { recursive: true });
    // Refuse redirected output folders before building.
    if (await fs.realpath(output) !== output) throw new Error('out must be a real directory inside the workspace');
    const work = await fs.mkdtemp(path.join(output, 'release-build-'));
    const destination = inside(root, path.join(root, 'release'));
    forge ||= require('@electron-forge/core').api;
    config ||= require(path.join(root, 'forge.config.js'));
    const options = { dir: root, outDir: path.join(work, 'build'), interactive: false, platform: process.platform, arch: process.arch };

    console.log('Packaging application...');
    await forge.package(options);
    console.log('Creating installers and portable ZIP...');
    const targets = [...config.makers];
    if (!targets.some(target => target.name === '@electron-forge/maker-zip')) {
        targets.push({ name: '@electron-forge/maker-zip', config: {} });
    }
    const results = await forge.make({ ...options, skipPackage: true, overrideTargets: targets });
    // Squirrel 的 .nupkg 与 RELEASES 是自动更新喂料：应用没接 autoUpdater，没人会来下载它们，
    // 留在发布目录只占体积。两者成对丢弃（只有清单没有包、或反之都无意义），Setup.exe 与 zip 保留。
    const artifacts = results.flatMap(result => result.artifacts).filter(file => !file.endsWith('.nupkg') && path.basename(file) !== 'RELEASES');
    if (!artifacts.length || !artifacts.some(file => file.endsWith('.zip'))) throw new Error('Missing release artifacts or portable ZIP');

    // 先查重名再落盘：重名会在任何写入之前抛错，原发布目录不受影响。
    const names = new Set();
    for (const artifact of artifacts) {
        const name = path.basename(artifact);
        if (names.has(name)) throw new Error(`Duplicate release artifact: ${name}`);
        names.add(name);
    }

    // 就地生成和覆盖，不删除目录里已有的其他文件：产物、源码包与 README 只覆盖同名文件。
    await fs.mkdir(destination, { recursive: true });
    for (const artifact of artifacts) {
        await fs.copyFile(artifact, path.join(destination, path.basename(artifact)));
    }
    await copySource(root, path.join(destination, 'Source Code'));
    await fs.copyFile(path.join(root, 'README.md'), path.join(destination, 'README.md'));
    console.log(`Release ready: ${destination}`);
    return destination;
}

if (require.main === module) {
    release().catch(error => {
        console.error('Release failed:', error);
        process.exitCode = 1;
    });
}

module.exports = { SOURCE_ENTRIES, copySource, release };
