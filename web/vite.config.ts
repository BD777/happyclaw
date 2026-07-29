import path from 'path';
import { defineConfig, type IndexHtmlTransformResult, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000';
const WS_PROXY_TARGET =
  process.env.VITE_WS_PROXY_TARGET || 'ws://127.0.0.1:3000';

const APP_BASE = (() => {
  const raw = (process.env.VITE_BASE_PATH || '/').trim();
  if (!raw) return '/';
  let base = raw;
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
})();

/**
 * /chat 是默认落地页，但 ChatPage 走 React.lazy：没有这些标签时，它的分片
 * （含静态依赖 MarkdownRenderer，两者约占聊天首屏 JS 的 93%）要等入口 JS
 * 下载并执行、AuthGuard 放行之后才开始下载。预加载让它们与入口并行到达。
 */
function preloadChatChunks(): Plugin {
  return {
    name: 'happyclaw:preload-chat-chunks',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx): IndexHtmlTransformResult {
        if (!ctx.bundle) return html;
        const tags: Extract<
          IndexHtmlTransformResult,
          { tags: unknown[] }
        >['tags'] = [];
        for (const [fileName, output] of Object.entries(ctx.bundle)) {
          if (
            output.type === 'chunk' &&
            (output.name === 'ChatPage' || output.name === 'MarkdownRenderer')
          ) {
            tags.push({
              tag: 'link',
              attrs: {
                rel: 'modulepreload',
                crossorigin: true,
                href: `${APP_BASE}${fileName}`,
              },
              injectTo: 'head',
            });
          } else if (
            output.type === 'asset' &&
            /^assets\/MarkdownRenderer-.*\.css$/.test(fileName)
          ) {
            tags.push({
              tag: 'link',
              attrs: {
                rel: 'preload',
                as: 'style',
                crossorigin: true,
                href: `${APP_BASE}${fileName}`,
              },
              injectTo: 'head',
            });
          }
        }
        return { html, tags };
      },
    },
  };
}

export default defineConfig({
  base: APP_BASE,
  plugins: [react(), tailwindcss(), preloadChatChunks()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    allowedHosts: true,
    hmr: {
      // VS Code Remote port forwarding requires explicit HMR client config
      clientPort: 5173,
    },
    proxy: {
      '/api': API_PROXY_TARGET,
      '/ws': {
        target: WS_PROXY_TARGET,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
  },
});
