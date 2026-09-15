/**
 * sql.js 运行时（最简封装）—— p4_data 双层缓存共用的初始化入口
 *
 * 本模块 import 了 p2_tools/sqlWasm 导出的内联字节：wasm 已在构建期由
 * esbuild 以 base64 内联进 main.js（见 esbuild.config.mjs 的 loader 配置），
 * 因此运行期无需任何外部 sql-wasm.wasm 文件。
 *
 * SqliteCache（cache/ 子目录）落地时改为调用本模块的 getSqlJs() 即可。
 */
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import { sqlWasmBinary } from "./sqlWasm";

let sqlPromise: Promise<SqlJsStatic> | null = null;

/** 获取（并缓存）sql.js 运行时；首次调用完成 wasm 实例化 */
export function getSqlJs(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({ wasmBinary: sqlWasmBinary });
  return sqlPromise;
}
