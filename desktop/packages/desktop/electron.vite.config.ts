import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import UnoCSS from 'unocss/vite';
import unoConfig from '../../uno.config.ts';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// The app's version, from the repo-root package.json: the one electron-builder packages (app.getVersion()), which a
// release tag sets and the updater compares with the releases.
const rootPackageJson = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')) as {
  version: string;
};

// Build builtin MCP servers after main process bundle so they survive out/main/ cleanup.
function buildMcpServersPlugin() {
  return {
    name: 'vite-plugin-build-mcp-servers',
    closeBundle() {
      execSync(`node "${resolve('scripts/build-mcp-servers.js')}"`, { stdio: 'inherit' });
    },
  };
}

// Icon Park transform plugin (replaces webpack icon-park-loader)
function iconParkPlugin() {
  return {
    name: 'vite-plugin-icon-park',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (!id.endsWith('.tsx') || id.includes('node_modules')) return null;
      if (!source.includes('@icon-park/react')) return null;
      const transformedSource = source.replace(
        /import\s+\{\s+([a-zA-Z, ]*)\s+\}\s+from\s+['"]@icon-park\/react['"](;?)/g,
        function (str, match) {
          if (!match) return str;
          const components = match.split(',');
          const importComponent = str.replace(
            match,
            components.map((key: string) => `${key} as _${key.trim()}`).join(', ')
          );
          const hoc = `import IconParkHOC from '@renderer/components/IconParkHOC';
          ${components.map((key: string) => `const ${key.trim()} = IconParkHOC(_${key.trim()})`).join(';\n')}`;
          return importComponent + ';' + hoc;
        }
      );
      if (transformedSource !== source) return { code: transformedSource, map: null } as { code: string; map: null };
      return null;
    },
  };
}

// Common path aliases for main process and workers
const desktopSrcRoot = resolve('packages/desktop/src');
const rendererRoot = resolve('packages/desktop/src/renderer');

const mainAliases = {
  '@': desktopSrcRoot,
  '@common': resolve('packages/desktop/src/common'),
  '@renderer': rendererRoot,
  '@process': resolve('packages/desktop/src/process'),
  '@worker': resolve('packages/desktop/src/process/worker'),
  '@xterm/headless': resolve('packages/desktop/src/common/utils/shims/xterm-headless.ts'),
};

export default defineConfig(({ mode }) => {
  const isDevelopment = mode === 'development';

  return {
    main: {
      plugins: [
        // externalizeDepsPlugin replaces our custom getExternalDeps() + pluginExternalizeDynamicImports.
        // 'fix-path' excluded so it gets bundled inline (only 3KB).
        // '@aionui/web-host' excluded so its TS sources (which use ESM ".js" import specifiers)
        // are bundled by esbuild rather than left as `require('@aionui/web-host')`, which Node
        // cannot resolve because the package ships no compiled .js files (workspace-only).
        externalizeDepsPlugin({ exclude: ['fix-path', '@aionui/web-host'] }),
        ...(isDevelopment
          ? [
              {
                name: 'dev-build-mcp-servers',
                closeBundle() {
                  execSync(`node "${resolve(__dirname, '../../scripts/build-mcp-servers.js')}"`, {
                    stdio: 'inherit',
                  });
                },
              },
            ]
          : []),
        ...(!isDevelopment
          ? [
              viteStaticCopy({
                structured: false,
                // electron-vite builds main process as SSR; viteStaticCopy defaults
                // to environment: "client" and silently skips non-client environments.
                environment: 'ssr',
                targets: [
                  // Use single * glob to copy top-level items (directories) with their contents intact.
                  // Using ** would flatten all nested files into the dest root.
                  { src: 'packages/desktop/src/renderer/assets/logos/*', dest: 'static/images' },
                ],
              }),
            ]
          : []),
        ...(isDevelopment ? [buildMcpServersPlugin()] : []),
      ],
      resolve: { alias: mainAliases, extensions: ['.ts', '.tsx', '.js', '.json'] },
      build: {
        sourcemap: isDevelopment,
        reportCompressedSize: false,
        rollupOptions: {
          input: {
            index: resolve('packages/desktop/src/index.ts'),
            // The local judge where Core ML does not run, started as a utility process (onnxruntime-node stays
            // external and loads from node_modules, which a utility process reads inside app.asar).
            localJudgeOnnx: resolve('packages/desktop/src/process/services/localJudgeOnnx/entry.ts'),
            // The native host (MU_NATIVE_HOST=1): pi in a utility process per session, imported at run time from the
            // harness it is started with (docs/native-host.md).
            nativeHost: resolve('packages/desktop/src/process/services/nativeHost/entry.ts'),
            // Built-in MCP server entry points (compiled by scripts/build-mcp-servers.js via esbuild,
            // not vite — esbuild bundles all deps for self-contained execution by external node processes)
          },
          onwarn(warning, warn) {
            if (warning.code === 'EVAL') return;
            warn(warning);
          },
        },
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
        'process.env.env': JSON.stringify(process.env.env),
      },
    },

    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@': resolve('packages/desktop/src'),
          '@common': resolve('packages/desktop/src/common'),
        },
        extensions: ['.ts', '.tsx', '.js', '.json'],
      },
      build: {
        sourcemap: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: {
            index: resolve('packages/desktop/src/preload/main.ts'),
          },
        },
      },
    },

    renderer: {
      // The renderer workspace moved under packages/desktop/src/renderer in M1.
      // Make the root explicit so Vite emits page names relative to that directory
      // instead of leaking source-relative ../../ paths into HTML asset names.
      root: rendererRoot,
      base: './',
      publicDir: resolve('public'),
      appType: 'mpa',
      server: {
        // Default to 5173; when occupied (e.g. another AionUi clone is running),
        // Vite auto-increments to the next available port.
        // electron-vite reads the actual port and sets ELECTRON_RENDERER_URL accordingly.
        port: 5173,
        // Explicit HMR host so Vite client connects directly to the Vite dev server,
        // not to the WebUI proxy server (which would reject the WebSocket and cause infinite reload).
        // Port is omitted so it automatically matches the server port.
        hmr: {
          host: 'localhost',
        },
      },
      resolve: {
        alias: {
          '@': resolve('packages/desktop/src'),
          '@common': resolve('packages/desktop/src/common'),
          '@renderer': resolve('packages/desktop/src/renderer'),
          '@process': resolve('packages/desktop/src/process'),
          '@worker': resolve('packages/desktop/src/process/worker'),
          // Force ESM version of streamdown
          streamdown: resolve('node_modules/streamdown/dist/index.js'),
        },
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.css'],
        // CodeMirror relies on module-level singletons (highlighterFacet, tag
        // sets). If Vite pre-bundles two copies of @codemirror/language (one for
        // our direct import, one nested under @uiw/react-codemirror), our custom
        // markdown HighlightStyle registers on a facet the editor never reads,
        // so the source view silently falls back to near-monochrome. Dedupe the
        // singleton packages to a single physical copy. Only packages hoisted to
        // the top-level node_modules may be deduped here — @lezer/common is not
        // hoisted under bun's isolated layout, so listing it breaks the Rollup
        // production build (cannot resolve from nested @codemirror/lang-* dirs).
        dedupe: [
          'react',
          'react-dom',
          'react-router-dom',
          '@codemirror/state',
          '@codemirror/view',
          '@codemirror/language',
          '@lezer/highlight',
        ],
      },
      plugins: [UnoCSS(unoConfig), iconParkPlugin()],
      build: {
        target: 'es2022',
        sourcemap: isDevelopment,
        minify: !isDevelopment,
        reportCompressedSize: false,
        chunkSizeWarningLimit: 1500,
        cssCodeSplit: true,
        rollupOptions: {
          input: {
            index: resolve(rendererRoot, 'index.html'),
          },
          external: ['node:crypto', 'crypto'],
          onwarn(warning, warn) {
            if (warning.code === 'EVAL') return;
            warn(warning);
          },
          output: {
            manualChunks(id: string) {
              if (!id.includes('node_modules')) return undefined;
              // Keep React and every vendor tightly coupled to it in ONE chunk.
              //
              // Splitting these into separate manual chunks (vendor-react,
              // vendor-arco, vendor-highlight, vendor-markdown, vendor-editor)
              // produced circular ESM imports between the emitted chunks:
              //   vendor-react -> vendor-editor -> vendor-highlight
              //     -> vendor-arco -> vendor-react
              // (the loose `/react/` match also pulled React wrappers such as
              // @monaco-editor/react into vendor-react, wiring it to the editor
              // chunk). With a chunk cycle, ESM evaluation order left React's
              // exports uninitialized when vendor-arco's top level ran
              // `React.createContext`, throwing
              // "Cannot read properties of undefined (reading 'createContext')"
              // and leaving #root empty — a full white screen in the packaged
              // build (dmg + electron-vite preview). Co-locating them removes the
              // cross-chunk edges entirely; a single vendor chunk is loaded from
              // disk (file://) so the extra granularity bought nothing.
              if (
                id.includes('/react-dom/') ||
                id.includes('/react/') ||
                id.includes('/@arco-design/') ||
                id.includes('/react-markdown/') ||
                id.includes('/remark-') ||
                id.includes('/rehype-') ||
                id.includes('/unified/') ||
                id.includes('/mdast-') ||
                id.includes('/hast-') ||
                id.includes('/micromark') ||
                id.includes('/react-syntax-highlighter/') ||
                id.includes('/refractor/') ||
                id.includes('/highlight.js/') ||
                id.includes('/monaco-editor/') ||
                id.includes('/@monaco-editor/') ||
                id.includes('/codemirror/') ||
                id.includes('/@codemirror/') ||
                id.includes('/katex/') ||
                // WaveDrom timing diagrams (markdown code blocks, CJS)
                id.includes('/wavedrom/')
              )
                return 'vendor';
              if (id.includes('/@icon-park/')) return 'vendor-icons';
              if (id.includes('/diff2html/')) return 'vendor-diff';
              return undefined;
            },
          },
        },
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
        'process.env.env': JSON.stringify(process.env.env),
        'process.env.AIONUI_MULTI_INSTANCE': JSON.stringify(process.env.AIONUI_MULTI_INSTANCE ?? ''),
        // The app's version (root package.json), shown on 关于 until the main process says which version runs.
        __APP_VERSION__: JSON.stringify(rootPackageJson.version),
        global: 'globalThis',
      },
      optimizeDeps: {
        exclude: ['electron'],
        include: [
          'react',
          'react-dom',
          'react-router-dom',
          'react-i18next',
          'i18next',
          '@arco-design/web-react',
          '@icon-park/react',
          'react-markdown',
          'react-syntax-highlighter',
          'react-virtuoso',
          'classnames',
          'swr',
          'eventemitter3',
          'katex',
          'diff2html',
          'remark-gfm',
          'remark-math',
          'remark-breaks',
          'rehype-raw',
          'rehype-katex',
          'wavedrom',
          // Pre-bundle the CodeMirror entry points together so they share a
          // single @codemirror/language copy (see dedupe note above); otherwise
          // the markdown source view loses its custom syntax highlighting.
          '@uiw/react-codemirror',
          '@codemirror/lang-markdown',
          '@codemirror/language',
        ],
      },
    },
  };
});
