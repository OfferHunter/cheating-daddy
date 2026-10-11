const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SOURCE_ENTRIES, release } = require('./release');

const execFileAsync = promisify(execFile);

async function fixture() {
    await fs.mkdir(path.join(__dirname, '../out'), { recursive: true });
    const root = await fs.mkdtemp(path.join(__dirname, '../out/release-test-'));
    // 发布目录、私钥与依赖目录都不是源码条目：验证它们不会被复制进源码包。
    for (const dir of ['release', '.license-private', 'node_modules']) {
        await fs.mkdir(path.join(root, dir), { recursive: true });
        await fs.writeFile(path.join(root, dir, 'marker'), 'do not ship');
    }
    for (const entry of SOURCE_ENTRIES) {
        await fs.mkdir(path.dirname(path.join(root, entry)), { recursive: true });
        await fs.writeFile(path.join(root, entry), `content:${entry}`);
    }
    // src 与 scripts 当目录用，并塞进靠 .gitignore 排除、以及必须显式排除的东西。
    for (const dir of ['src', 'scripts']) await fs.rm(path.join(root, dir));
    await fs.mkdir(path.join(root, 'src/data'), { recursive: true });
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/index.js'), 'app');
    await fs.writeFile(path.join(root, 'src/data/secret'), 'do not ship');
    await fs.writeFile(path.join(root, 'src/.env'), 'SECRET');
    await fs.writeFile(path.join(root, 'src/debug.log'), 'noise');
    await fs.writeFile(path.join(root, 'src/notes.gitignore'), 'keep me');
    await fs.writeFile(path.join(root, 'src/.gitignore'), 'ignored');
    await fs.writeFile(path.join(root, 'scripts/release.js'), 'source');
    await fs.writeFile(path.join(root, '.gitignore'), 'src/data\n*.log\n.env\nnode_modules/\nrelease/\n.license-private/\n');
    // 真造一个 git 仓库：排除逻辑完全由 .gitignore 决定。
    await execFileAsync('git', ['init', '-q'], { cwd: root });
    return root;
}

test('release writes artifacts plus source, keeping existing files', async () => {
    const root = await fixture();
    const calls = [];
    const forge = {
        async package(options) { calls.push('package'); await fs.mkdir(options.outDir, { recursive: true }); },
        async make(options) {
            calls.push('make');
            assert.equal(options.skipPackage, true);
            assert.ok(options.overrideTargets.some(target => target.name === '@electron-forge/maker-zip'));
            const artifacts = ['Setup.exe', 'portable.zip', 'app.nupkg', 'RELEASES'].map(name => path.join(options.outDir, name));
            for (const artifact of artifacts) await fs.writeFile(artifact, 'artifact');
            return [{ artifacts }];
        },
    };
    const output = await release({ root, forge, config: { makers: [] } });
    assert.deepEqual(calls, ['package', 'make']);
    assert.equal(await fs.readFile(path.join(output, 'README.md'), 'utf8'), 'content:README.md');
    assert.equal(await fs.readFile(path.join(output, 'Setup.exe'), 'utf8'), 'artifact');
    assert.equal(await fs.readFile(path.join(output, 'portable.zip'), 'utf8'), 'artifact');
    // Squirrel 的自动更新喂料不进发布目录。
    for (const entry of ['app.nupkg', 'RELEASES']) {
        await assert.rejects(fs.access(path.join(output, entry)));
    }

    // 源码包：必需条目带过来了；被忽略的、以及 .git/.gitignore 一个没带。
    const source = path.join(output, 'Source Code');
    assert.equal(await fs.readFile(path.join(source, 'package.json'), 'utf8'), 'content:package.json');
    assert.equal(await fs.readFile(path.join(source, 'src/index.js'), 'utf8'), 'app');
    assert.equal(await fs.readFile(path.join(source, 'scripts/release.js'), 'utf8'), 'source');
    assert.equal(await fs.readFile(path.join(source, 'src/notes.gitignore'), 'utf8'), 'keep me');
    for (const entry of ['src/data', 'src/.env', 'src/debug.log', 'src/.gitignore', '.git', '.gitignore', '.license-private', 'node_modules']) {
        await assert.rejects(fs.access(path.join(source, entry)), undefined, `${entry} must not be packaged`);
    }

    // 已有的 marker 不被删除：发布只新增或覆盖同名产物。
    assert.equal(await fs.readFile(path.join(output, 'marker'), 'utf8'), 'do not ship');
});

test('failed build leaves the existing release untouched', async () => {
    const root = await fixture();
    await assert.rejects(release({ root, config: { makers: [] }, forge: { async package() { throw new Error('build failed'); } } }), /build failed/);
    assert.equal(await fs.readFile(path.join(root, 'release', 'marker'), 'utf8'), 'do not ship');
});
