import { Middleware } from '../middleware.js';
import * as Flag from '../flags.js';
import { getTriplitDir, loadTsModule } from '../filesystem.js';
import path from 'path';
import fs from 'fs';

export const projectSchemaMiddleware = Middleware({
  name: 'Project Schema',
  flags: {
    schemaPath: Flag.String({
      description: 'File path to the local schema file',
      required: false,
      char: 'P',
    }),
    noSchema: Flag.Boolean({
      description: 'Do not load a schema file',
      char: 'N',
    }),
  },
  run: async ({ flags }) => {
    if (flags.noSchema) return { schema: undefined };
    let schemaPath =
      flags.schemaPath ??
      process.env.TRIPLIT_SCHEMA_PATH ??
      path.join(getTriplitDir(), 'schema.ts');
    if (!fs.existsSync(schemaPath)) {
      return `Schema file not found at ${schemaPath}. If you would like to run without a schema file, use the --noSchema flag.`;
    }
    const result = await loadTsModule(schemaPath);
    if (!result) {
      return `Failed to load schema file at ${schemaPath}. If you would like to run without a schema file, use the --noSchema flag.`;
    }
    if (!result.schema) {
      return `${schemaPath} does not export an object named 'schema'. Please export one. If you would like to run without a schema file, use the --noSchema flag.`;
    }

    return { ...result } as { schema: any; roles?: any };
  },
});
