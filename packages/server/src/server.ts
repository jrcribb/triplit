import url from 'url';
import * as Sentry from '@sentry/node';
import path from 'path';
import { createRequire } from 'module';
import { createTriplitHonoServer } from './hono.js';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

function initSentry() {
  if (process.env.SENTRY_DSN) {
    let packageDotJson;
    // Warning: this is not bundler friendly
    // Adding this with node 22 dropping support for assert (https://v8.dev/features/import-attributes#deprecation-and-eventual-removal-of-assert), preferring 'with'
    // Issue: https://github.com/nodejs/node/issues/51622
    // TODO: properly import package.json so in a way that works with bundlers, typescript, and all versions of node
    // You may also need to upgrade typescript to support 'with' syntax
    try {
      const require = createRequire(import.meta.url);
      const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
      packageDotJson = require(path.join(__dirname, '../package.json'));
    } catch {}
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: packageDotJson?.version ?? 'unknown',
    });
  }
}

function captureException(e: any) {
  if (Sentry.isInitialized() && e instanceof Error) {
    Sentry.captureException(e);
  }
}

export function createServer(
  options: Parameters<typeof createTriplitHonoServer>[0]
) {
  let app = new Hono();
  initSentry();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // @ts-expect-error
  app = createTriplitHonoServer(
    options,
    upgradeWebSocket,
    captureException,
    app
  );

  return function startServer(port: number, onOpen?: (() => void) | undefined) {
    const server = serve({ fetch: app.fetch, port }, onOpen);
    injectWebSocket(server);
    return {
      close: (onClose?: () => void) => {
        server.close();
        onClose && onClose();
      },
    };
  };
}
