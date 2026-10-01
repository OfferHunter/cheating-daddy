const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SOURCE_ENTRIES, release } = require('./release');

async function fixture() {
    await fs.mkdir(path.join(__dirname, '../out'), { recursive: true });
    const root = await fs.mkdtemp(path.join(__dirname, '../out/release-test-'));
    for (const entry of SOURCE_ENTRIES) {
        if (['src', 'scripts'].includes(entry)) {
            await fs.mkdir(path.join(root, entry));
            await fs.writeFile(path.join(root, entry, 'example.js'), '// source');
        } else await fs.writeFile(path.join(root, entry), entry);
    }
    for (const dir of ['release', '.license-private', 'src/data', 'node_modules']) {
        await fs.mkdir(path.join(root, dir), { recursive: true });
        await fs.writeFile(path.join(root, dir, 'marker'), 'do not ship');
    }
    return root;
}

test('release runs package once, collects only current artifacts and preserves the previous release', async () => {
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
    assert.equal(await fs.readFile(path.join(output, 'README.md'), 'utf8'), 'README.md');
    for (const entry of SOURCE_ENTRIES) await fs.access(path.join(output, 'Source Code', entry));
    for (const entry of ['.license-private', 'node_modules', 'src/data', 'release']) {
        await assert.rejects(fs.access(path.join(output, 'Source Code', entry)));
    }
    const builds = await fs.readdir(path.join(root, 'out'));
    assert.equal(await fs.readFile(path.join(root, 'out', builds[0], 'previous-release', 'marker'), 'utf8'), 'do not ship');
});

test('failed build leaves the existing release untouched', async () => {
    const root = await fixture();
    await assert.rejects(release({ root, config: { makers: [] }, forge: { async package() { throw new Error('build failed'); } } }), /build failed/);
    assert.equal(await fs.readFile(path.join(root, 'release', 'marker'), 'utf8'), 'do not ship');
});
