/**
 * sql.js（SQLite WASM）运行时字节 —— 构建期内联进 main.js
 *
 * 本文件是 .wasm 内联的引用点：esbuild.config.mjs 配置了 loader
 * { ".wasm": "base64" }，因此下方的 import 在构建期会被替换为该 wasm
 * 文件的 base64 字符串，不会生成独立的 sql-wasm.wasm 文件。
 *
 * 使用方式（重构中的 SqliteCache）：
 *   const SQL = await initSqlJs({ wasmBinary: sqlWasmBinary });
 *
 * 若日后改回「外部 sql-wasm.wasm 文件」模式：删除本文件并恢复
 * esbuild.config.mjs 中的 wasm 文件复制逻辑即可。
 */

// @ts-expect-error sql.js 未提供 .wasm 模块的类型声明；esbuild 以 base64 loader 处理该导入
import sqlWasmBase64 from "sql.js/dist/sql-wasm.wasm";

/** base64 → Uint8Array（Electron/Chromium 渲染进程均内置 atob） */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const wasmBytes = base64ToBytes(sqlWasmBase64);

/**
 * sql-wasm.wasm 的二进制内容（ArrayBuffer），供 initSqlJs({ wasmBinary }) 使用。
 * 该 ArrayBuffer 无视图偏移，内容即完整 wasm，可直接透传。
 */
export const sqlWasmBinary: ArrayBuffer = wasmBytes.buffer;
