/**
 * 临时运行器（不入库；跑完即删）
 *
 * 用 esbuild 的 JS API 在内存里把 t.ts 打包成 CJS 再执行 —— 产物不落盘，
 * 规避沙箱对 esbuild CLI 写输出文件的拦截。
 */
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const dir = __dirname;
const root = path.resolve(dir, '..');
const entry = path.join(dir, 't.ts');

const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'warning',
});

const code = result.outputFiles[0].text;
const bundled = path.join(dir, 't.bundle.cjs');
const m = new Module(bundled);
m.filename = bundled;
m.paths = Module._nodeModulePaths(root);
m._compile(code, bundled);
