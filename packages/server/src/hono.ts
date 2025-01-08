import {
  DB,
  TriplitError,
  DurableClock,
  DBConfig,
  Storage,
  getRolesFromSession,
  normalizeSessionVars,
  sessionRolesAreEquivalent,
} from '@triplit/db';
import {
  InvalidAuthenticationSchemeError,
  MalformedMessagePayloadError,
  NoTokenProvidedError,
} from '@triplit/server-core/errors';
import {
  Server as TriplitServer,
  Route,
  SyncConnection,
} from '@triplit/server-core';
import {
  ClientSyncMessage,
  ParseResult,
  ServerCloseReason,
} from '@triplit/types/sync';
import { logger } from './logger.js';
import { parseAndValidateToken, ProjectJWT } from '@triplit/server-core/token';
import { Hono } from 'hono';
import { StatusCode } from 'hono/utils/http-status';

import { WSContext, type UpgradeWebSocket, WSMessageReceive } from 'hono/ws';

import { logger as honoLogger } from 'hono/logger';
import { cors } from 'hono/cors';

import { TriplitClient } from '@triplit/client';

type Variables = {
  token: ProjectJWT;
};

export type ServerOptions = {
  storage?: Storage | (() => Storage);
  dbOptions?: DBConfig;
  watchMode?: boolean;
  verboseLogs?: boolean;
  upstream?: {
    url: string;
    token: string;
  };
  jwtSecret: string;
  projectId?: string;
  // do we still need this?
  claimsPath?: string;
  externalJwtSecret?: string;
};

export function createTriplitHonoServer(
  options: ServerOptions,
  upgradeWebSocket: UpgradeWebSocket,
  captureException?: (e: unknown) => void,
  honoApp?: Hono
) {
  const dbSource = !!options?.storage
    ? typeof options.storage === 'function'
      ? options.storage()
      : options.storage
    : undefined;
  if (options?.verboseLogs) logger.verbose = true;
  const dbOptions: Partial<DBConfig> = {
    experimental: {},
  };
  Object.assign(dbOptions, options?.dbOptions);
  const db = options.upstream
    ? new TriplitClient({
        serverUrl: options.upstream.url,
        token: options.upstream.token,
        syncSchema: true,
        skipRules: false,
      })
    : new DB({
        source: dbSource,
        clock: new DurableClock(),
        // Can this be removed?
        tenantId: options.projectId,
        ...dbOptions,
      });

  // @ts-expect-error
  const server = new TriplitServer(db, captureException);

  function parseAndValidateTokenWithOptions(token: string) {
    return parseAndValidateToken(token, options.jwtSecret, options.projectId, {
      payloadPath: options.claimsPath,
      externalSecret: options.externalJwtSecret,
    });
  }

  const app = (honoApp ?? new Hono()) as Hono<{ Variables: Variables }>;

  app.use(honoLogger());
  app.use(cors());

  // app.use(async (c, next) => {
  //   const reqBody = await c.req.text();
  //   const route = new URL(c.req.url).pathname;

  //   logger.logRequest(c.req.method, route, reqBody ?? undefined);
  //   const start = Date.now();
  //   await next();
  //   logger.logResponse(c.req.method, route, c.res.status, Date.now() - start);
  // });

  app.onError((error, c) => {
    console.error(error);
    if (error instanceof TriplitError) {
      if (error.status === 500) captureException?.(error);
      return c.json(error.toJSON(), error.status as StatusCode);
    }
    captureException?.(error);
    return c.text('Internal server error', 500);
  });

  app.get('/healthcheck', (c) => {
    return c.text('OK', 200);
  });

  app.get(
    '/',
    upgradeWebSocket((c) => {
      let syncConnection: SyncConnection | undefined = undefined;
      return {
        onOpen: async (_event, ws) => {
          let token: ProjectJWT | undefined = undefined;

          try {
            const { data, error } = await parseAndValidateTokenWithOptions(
              c.req.query('token')!
            );
            if (error) throw error;
            token = data;
          } catch (e) {
            captureException?.(e);
            closeSocket(
              ws,
              {
                type: 'UNAUTHORIZED',
                retry: false,
                message: e instanceof Error ? e.message : undefined,
              },
              1008
            );
            return;
          }
          try {
            const clientId = c.req.query('client') as string;
            const clientHash = c.req.query('schema')
              ? parseInt(c.req.query('schema') as string)
              : undefined;
            const syncSchema = c.req.query('sync-schema') === 'true';

            syncConnection = server.openConnection(token, {
              clientId,
              clientSchemaHash: clientHash,
              syncSchema,
            });
            const schemaIncompatibility =
              await syncConnection.isClientSchemaCompatible();
            if (schemaIncompatibility) {
              schemaIncompatibility.retry = !!options?.watchMode;
              closeSocket(ws, schemaIncompatibility, 1008);
              return;
            }
            // @ts-expect-error
            ws.tokenExpiration = token.exp;
            syncConnection!.addListener((messageType, payload) => {
              if (
                // @ts-expect-error
                ws.tokenExpiration &&
                // @ts-expect-error
                ws.tokenExpiration * 1000 < Date.now()
              ) {
                closeSocket(ws, { type: 'TOKEN_EXPIRED', retry: false }, 1008);
                return;
              }
              sendMessage(ws, messageType, payload);
            });
          } catch (e) {
            console.error(e);
            captureException?.(e);
            closeSocket(
              ws,
              {
                type: 'INTERNAL_ERROR',
                retry: false,
                message: e instanceof Error ? e.message : undefined,
              },
              1011
            );
            return;
          }
        },
        async onMessage(event, ws) {
          if (
            // @ts-expect-error
            ws.tokenExpiration &&
            // @ts-expect-error
            ws.tokenExpiration * 1000 < Date.now()
          ) {
            closeSocket(ws, { type: 'TOKEN_EXPIRED', retry: false }, 1008);
            return;
          }
          const { data: parsedMessage, error } = parseClientMessage(event.data);
          if (error)
            return sendErrorMessage(
              ws,
              undefined,
              new MalformedMessagePayloadError(),
              {
                message: event.data,
              }
            );
          logger.logMessage('received', parsedMessage);
          if (parsedMessage.type === 'UPDATE_TOKEN') {
            const { token: newToken } = parsedMessage.payload;
            const { data, error } =
              await parseAndValidateTokenWithOptions(newToken);
            if (error) {
              closeSocket(
                ws,
                {
                  type: 'UNAUTHORIZED',
                  message: error.message,
                  retry: false,
                },
                1008
              );
              return;
            }
            const newTokenRoles = getRolesFromSession(
              syncConnection?.db.schema,
              normalizeSessionVars(data)
            );

            const existingTokenRoles = getRolesFromSession(
              syncConnection?.db.schema,
              // @ts-expect-error
              normalizeSessionVars(syncConnection?.token)
            );
            if (!sessionRolesAreEquivalent(newTokenRoles, existingTokenRoles)) {
              closeSocket(
                ws,
                {
                  type: 'ROLES_MISMATCH',
                  message: "Roles for new token don't match the old token.",
                  retry: false,
                },
                1008
              );
              return;
            }
            // @ts-expect-error
            ws.tokenExpiration = data?.exp;
            return;
          }

          syncConnection!.dispatchCommand(parsedMessage!);
        },
        onClose: (event, ws) => {
          if (!syncConnection) return;

          server.closeConnection(syncConnection.options.clientId);

          // Should this use the closeSocket function?
          ws.close(event.code, event.reason);
        },
        onError: (event, ws) => {
          captureException?.(event);
          closeSocket(ws, { type: 'INTERNAL_ERROR', retry: false }, 1011);
        },
      };
    })
  );

  app.use('*', async (c, next) => {
    const authHeader = c.req.header('authorization');
    if (!authHeader) {
      throw new NoTokenProvidedError('Missing authorization header');
    }
    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer') {
      throw new InvalidAuthenticationSchemeError();
    }
    if (!token) {
      throw new NoTokenProvidedError('Missing authorization token');
    }
    try {
      const { data, error } = await parseAndValidateTokenWithOptions(token);
      if (error) throw error;
      c.set('token', data);
      return next();
    } catch (e) {
      let triplitError: TriplitError;
      if (e instanceof TriplitError) triplitError = e;
      else if (e instanceof Error) triplitError = new TriplitError(e.message);
      else
        triplitError = new TriplitError(
          'An unknown error occurred while parsing token'
        );
      throw triplitError;
    }
  });

  app.post('/bulk-insert-file', async (c) => {
    const body = await c.req.formData();
    if (!body.has('data')) {
      return c.text('No data provided for file upload', 400);
    }
    const data = JSON.parse(body.get('data') as string);
    const token = c.get('token');
    const { statusCode, payload } = await server.handleRequest(
      ['bulk-insert'],
      data,
      token
    );
    return c.json(payload, statusCode as StatusCode);
  });
  app.post('*', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch (e) {}
    const token = c.get('token');
    const { statusCode, payload } = await server.handleRequest(
      new URL(c.req.url).pathname.slice(1).split('/') as Route,
      body,
      token
    );
    return c.json(payload, statusCode as StatusCode);
  });

  return app;
}

function sendMessage(
  socket: WSContext,
  type: any,
  payload: any,
  options: { dropIfClosed?: boolean } = {}
) {
  const message = JSON.stringify({ type, payload });
  // OPEN = 1
  if (socket.readyState === 1) {
    socket.send(message);
    logger.logMessage('sent', { type, payload });
  }
}

function sendErrorMessage(
  socket: WSContext,
  originalMessage: ClientSyncMessage | undefined, // message is undefined if we cannot parse it
  error: TriplitError,
  metadata?: any
) {
  const messageType = originalMessage?.type;
  let payload = {
    messageType,
    error: error.toJSON(),
    metadata,
  };
  sendMessage(socket, 'ERROR', payload);
}

function closeSocket(
  socket: WSContext,
  reason: ServerCloseReason,
  code?: number
) {
  // Send message informing client of upcoming close, may include message containing reason
  sendMessage(socket, 'CLOSE', reason, { dropIfClosed: true });
  // Close connection
  // Close payload must remain under 125 bytes
  socket.close(
    code,
    JSON.stringify({ type: reason.type, retry: reason.retry })
  );
}

function parseClientMessage(
  message: WSMessageReceive
): ParseResult<ClientSyncMessage> {
  // TODO: do more validation here
  try {
    const parsedMessage = JSON.parse(message.toString());
    return { data: parsedMessage, error: undefined };
  } catch (e) {
    // @ts-ignore
    return { data: undefined, error: e };
  }
}
