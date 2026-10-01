const fs = require('node:fs/promises');
const path = require('node:path');

const SOURCE_ENTRIES = [
    'src', 'scripts', 'package.json', 'package-lock.json', 'forge.config.js',
    'entitlements.plist', 'LICENSE', 'README.md', '.gitignore', '.prettierrc', '.prettierignore',
];

function inside(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path must be inside the workspace: ${target}`);
    }
    return target;
}

async function copySource(root, destination) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of SOURCE_ENTRIES) {
        const source = path.join(root, entry);
        await fs.cp(source, path.join(destination, entry), {
            recursive: true,
            filter: async file => {
                const relative = path.relative(root, file).split(path.sep).join('/');
                if (relative === 'src/data' || relative.startsWith('src/data/') || /(?:^|\/)(?:\.env(?:\..*)?|.*\.log)$/.test(relative)) {
                    return false;
                }
                if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Unexpected source symlink: ${relative}`);
                return true;
            },
        });
    }
}

async function release({ root = path.resolve(__dirname, '..'), forge, config } = {}) {
    root = await fs.realpath(root);
    const output = inside(root, path.join(root, 'out'));
    await fs.mkdir(output, { recursive: true });
    // Refuse redirected output folders before building or moving existing releases.
    if (await fs.realpath(output) !== output) throw new Error('out must be a real directory inside the workspace');
    const work = await fs.mkdtemp(path.join(output, 'release-build-'));
    const stage = path.join(work, 'release');
    const destination = inside(root, path.join(root, 'release'));
    const backup = inside(root, path.join(work, 'previous-release'));
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
    const artifacts = results.flatMap(result => result.artifacts);
    if (!artifacts.length || !artifacts.some(file => file.endsWith('.zip'))) throw new Error('Missing release artifacts or portable ZIP');

    await fs.mkdir(stage);
    const names = new Set();
    for (const artifact of artifacts) {
        const name = path.basename(artifact);
        if (names.has(name)) throw new Error(`Duplicate release artifact: ${name}`);
        names.add(name);
        await fs.copyFile(artifact, path.join(stage, name));
    }
    await copySource(root, path.join(stage, 'Source Code'));
    await fs.copyFile(path.join(root, 'README.md'), path.join(stage, 'README.md'));

    let previous = false;
    try {
        const stat = await fs.lstat(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('release must be a real directory');
        await fs.rename(destination, backup);
        previous = true;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    try {
        await fs.rename(stage, destination);
    } catch (error) {
        if (previous) await fs.rename(backup, destination);
        throw error;
    }
    console.log(`Release ready: ${destination}`);
    if (previous) console.log(`Previous release preserved: ${backup}`);
    return destination;
}

if (require.main === module) {
    release().catch(error => {
        console.error('Release failed:', error);
        process.exitCode = 1;
    });
}

module.exports = { SOURCE_ENTRIES, copySource, release };
