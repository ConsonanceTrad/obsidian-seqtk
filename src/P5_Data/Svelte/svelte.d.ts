/** 让 TypeScript 认识 .svelte 组件模块（编译由 esbuild + esbuild-svelte 完成，tsc 仅需此类型） */
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<any>;
  export default component;
}
