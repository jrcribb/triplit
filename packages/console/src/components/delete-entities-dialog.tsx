import { TriplitClient } from '@triplit/client';
import {
  Code,
  Button,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@triplit/ui';
import { useState } from 'react';
import { Trash } from '@phosphor-icons/react';
import { RoleFilters } from './role-filters.js';
import { type CollectionPermissions } from '@triplit/db';

type DeleteEntitiesDialogProps = {
  entityIds: string[];
  collectionName: string;
  permissions?: CollectionPermissions<any, any>;
  client: TriplitClient<any>;
};

async function deleteEntities(
  client: TriplitClient<any>,
  collectionName: string,
  entityIds: string[]
) {
  await client.transact(async (tx) => {
    await Promise.all(entityIds.map((id) => tx.delete(collectionName, id)));
  });
}

export function DeleteEntitiesDialog(props: DeleteEntitiesDialogProps) {
  const [open, setOpen] = useState(false);
  const { collectionName, client, entityIds, permissions } = props;
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          size={'sm'}
          variant={'destructive'}
          className="py-1 h-auto px-2 ml-3"
        >
          <Trash className=" mr-2" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {entityIds.length}{' '}
            {entityIds.length > 1 ? 'entities' : 'entity'} from{' '}
            <Code>{collectionName}</Code>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the
            entities from this collection.
          </AlertDialogDescription>
          {permissions && (
            <RoleFilters
              client={client}
              permissions={permissions}
              rule={'delete'}
            />
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              await deleteEntities(client, collectionName, entityIds);
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
