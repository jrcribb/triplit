import path from 'path';
import fs from 'fs';
import {
  applyMigration,
  createMigration,
  getMigrationsStatus,
  projectHasUntrackedChanges,
} from '../../migration.js';
import { serverRequesterMiddleware } from '../../middleware/add-server-requester.js';
import { getMigrationsDir } from '../../filesystem.js';
import { blue, italic, red } from 'ansis/colors';
import DB, { schemaToJSON } from '@triplit/db';
import { schemaFileContentFromMigrations, writeSchemaFile } from './codegen.js';
import { Command } from '../../command.js';

const pullMigrationName = 'sync_with_remote';

export default Command({
  description:
    'Fetches the remote database schema and generates a migration based on any changes',
  middleware: [serverRequesterMiddleware],
  run: async ({ ctx }) => {
    console.log(`Pulling latest migrations from sync server: `, blue(ctx.url));
    console.log();
    const res = await getMigrationsStatus({ ctx });
    const { status, server, project } = res;
    if (status === 'SERVER_UNTRACKED_CHANGES') {
      // Create a DB up to the latest server migration
      const latest = server.migrationIds.at(-1) ?? 0;
      const db = new DB<any>({
        migrations: project.migrations.filter((m) => m.version <= latest),
      });
      const tempSchema = schemaToJSON(await db.getSchema())?.collections;
      const timestamp = Date.now();
      const migration = createMigration(
        tempSchema ?? {},
        server.schema ?? {},
        timestamp,
        latest,
        pullMigrationName
      );

      if (!migration) {
        console.log(
          'Could not detect any changes to the schema. This is unexpected, please report this to Triplit.'
        );
        return;
      }

      const fileName = path.join(
        getMigrationsDir(),
        `${timestamp}_${pullMigrationName}.json`
      );

      fs.writeFileSync(
        fileName,
        JSON.stringify(migration, null, 2) + '\n',
        'utf8'
      );

      // @ts-ignore
      console.log(blue`Migration file created at ${fileName}`);

      console.log(
        // @ts-ignore
        blue`applying ${italic('up')} migration with id ${migration.version}`
      );
      // TODO: handle failed migration
      await applyMigration(migration, 'up', ctx);

      if (
        !projectHasUntrackedChanges(project.schemaHash, project.migrationsHash)
      ) {
        try {
          console.log('\n...Regenerating schema file with the new migration\n');
          const newMigrations = [...project.migrations, migration];
          const fileContent = await schemaFileContentFromMigrations(
            newMigrations
          );
          await writeSchemaFile(fileContent);
        } catch (e) {
          console.log(
            red(
              `An error occurred regenerating your schema file. You may re-run \`triplit migrate codegen\`. If that fails you may need to manually edit your schema file to reflect the changes applied in the latest migration.`
            )
          );
          console.error(e);
        }
      } else {
        // console.log(
        //   'Your schema.ts file has untracked changes. Run `triplit migrate create [migration_name]` and `triplit migrate up` to track the changes and push them to the remote.\n'
        // );
      }
      return;
    }

    console.log(
      'The server has no untracked changes. Please run `triplit migrate status` for more information.'
    );
    return;
  },
});
