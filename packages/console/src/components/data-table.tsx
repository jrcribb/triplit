import {
  Cell,
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Input,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Select,
  Textarea,
  Tooltip,
  cn,
  SetInput,
  Button,
  Code,
} from '@triplit/ui';
import { PARSE_FUNCS } from './create-entity-sheet';
import { TriplitClient } from '@triplit/client';
import { AttributeDefinition } from '@triplit/db';
import {
  CollectionAttributeDefinition,
  QueryAttributeDefinition,
  RecordAttributeDefinition,
  ValueAttributeDefinition,
} from '@triplit/db/src/data-types/serialization';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { set } from 'lodash';

async function updateTriplitValue(
  attribute: string,
  client: TriplitClient,
  collection: string,
  entityId: string,
  value: TriplitDataTypes
) {
  try {
    await client.update(collection, entityId, async (originalEntity) => {
      originalEntity[attribute] = value;
    });
  } catch (e) {
    console.error(e);
  }
}

async function updateTriplitSet(
  attribute: string,
  client: TriplitClient,
  collection: string,
  entityId: string,
  value: TriplitDataTypes,
  action: 'add' | 'delete' | 'null'
) {
  try {
    await client.update(collection, entityId, async (originalEntity) => {
      if (action === 'null') originalEntity[attribute] = null;
      else if (action === 'add') {
        if (originalEntity[attribute] === null) {
          originalEntity[attribute] = new Set([value]);
        } else {
          originalEntity[attribute].add(value);
        }
      } else if (action === 'delete') originalEntity[attribute].delete(value);
    });
  } catch (e) {
    console.error(e);
  }
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}

type ColumnHeaderProps = {
  attribute: string;
  onClickHeader?: () => void;
  rightIcon?: React.ReactNode;
  attributeDef?: AttributeDefinition;
} & React.HTMLAttributes<HTMLDivElement>;

export function TriplitColumnHeader(props: ColumnHeaderProps) {
  const { attribute, onClickHeader, rightIcon, attributeDef, children } = props;
  return (
    <div
      className="flex flex-row gap-2 items-center justify-between text-xs px-4 w-full h-full"
      onClick={onClickHeader}
    >
      <div className="flex flex-row items-center truncate gap-1">
        <div className="truncate">{attribute}</div>
        {attributeDef?.type && (
          <div className="font-normal text-primary/50 truncate">
            {attributeDef.type}
          </div>
        )}
        {children}
      </div>
      {rightIcon}
    </div>
  );
}

export type TriplitDataTypes =
  | string
  | number
  | boolean
  | Date
  | null
  | Record<string, any>;

function SetCellContents({
  triplitSet,
  definition,
  limit = 3,
  className,
}: {
  triplitSet: Set<any> | null;
  definition: CollectionAttributeDefinition;
  limit?: number;
  className?: string;
}) {
  if (!triplitSet) return null;
  const items = [...triplitSet];
  return (
    <div className="flex flex-row gap-1 items-center">
      <div>{'{'}</div>
      {items.slice(0, limit).map((item) => (
        <div
          key={item}
          className={cn('bg-secondary px-1 py-0.5 rounded-sm', className)}
        >
          <CellValue value={item} definition={definition} />
        </div>
      ))}
      {items.length > limit && (
        <Tooltip
          label={
            <SetCellContents
              definition={definition}
              triplitSet={triplitSet}
              limit={Infinity}
              className="border bg-inherit"
            />
          }
        >
          <div>+{items.length - limit}</div>
        </Tooltip>
      )}
      <div>{'}'}</div>
    </div>
  );
}

function RecordCellContents({
  record,
  definition,
  limit = 3,
  className,
}: {
  record: Record<string, any>;
  definition?: RecordAttributeDefinition;
  limit?: number;
  className?: string;
}) {
  if (!record) return null;
  const items = Object.entries(record);
  return (
    <div className="flex flex-row gap-1 items-center">
      <div>{'{'}</div>
      {items.slice(0, limit).map(([key, value]) => (
        <div
          key={key}
          className={cn(
            'bg-secondary px-1 py-0.5 rounded-sm flex flex-row items-center gap-1',
            className
          )}
        >
          <div>{key} :</div>
          <CellValue value={value} definition={definition?.properties[key]} />
        </div>
      ))}
      {items.length > limit && (
        <Tooltip
          label={
            <RecordCellContents
              record={record}
              limit={Infinity}
              className="border bg-inherit"
            />
          }
        >
          <div>+{items.length - limit}</div>
        </Tooltip>
      )}
      <div>{'}'}</div>
    </div>
  );
}

function CellValue(props: {
  definition: AttributeDefinition;
  value: TriplitDataTypes;
}) {
  const { definition, value } = props;
  if (value === null) return <span className="text-primary/50">null</span>;
  if (value === undefined) return '';
  if (definition.type === 'record' && value instanceof Object)
    return <RecordCellContents record={value} definition={definition} />;
  if (definition.type === 'set' && value instanceof Set)
    return (
      <SetCellContents definition={definition} triplitSet={value as Set<any>} />
    );
  if (definition.type === 'date' && value instanceof Date)
    return (value as Date).toISOString();
  return JSON.stringify(value, null, 2);
}

type TriplitRelationCellProps = {
  queryDef: QueryAttributeDefinition;
  onClickRelationLink: () => void;
};

export function RelationCell({
  queryDef,
  onClickRelationLink,
}: TriplitRelationCellProps) {
  const { collectionName: linkedCollection } = queryDef?.query;
  return (
    <Button
      variant={'link'}
      className="text-blue-500 text-xs px-4 h-auto"
      onClick={onClickRelationLink}
    >
      {linkedCollection} <ArrowSquareOut className="w-3 h-3 ml-1" />
    </Button>
  );
}

type TriplitDataCellProps = {
  entityId: string;
  selected: boolean;
  client: TriplitClient<any>;
  collection: string;
  attribute: string;
  value: TriplitDataTypes;
  attributeDef?: AttributeDefinition;
  onSelectCell: () => void;
  editable?: boolean;
};

export function DataCell({
  value,
  entityId,
  attribute,
  attributeDef = { type: 'string', options: { nullable: true } },
  onSelectCell = () => {},
  selected = false,
  client,
  collection,
  editable = true,
}: TriplitDataCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  useEffect(() => {
    if (!selected) setIsEditing(false);
  }, [selected]);
  return (
    <Popover open={isEditing} onOpenChange={setIsEditing}>
      <PopoverTrigger
        onClick={() => {
          onSelectCell();
          selected && setIsEditing(!isEditing);
        }}
        disabled={!editable}
        // setting height manually until we can figure out how to get these to fill the row
        className={`text-left px-3 py-2 border truncate w-full h-[38px] ${
          selected ? 'border-blue-600' : 'border-transparent'
        }`}
      >
        <CellValue
          definition={attributeDef ?? { type: 'string', options: {} }}
          value={value}
        />
      </PopoverTrigger>

      <PopoverContent className="text-xs p-1" align="start">
        {attributeDef?.type === 'set' ? (
          <SetCellEditor
            set={value}
            definition={attributeDef}
            onChangeSet={(value, action) => {
              updateTriplitSet(
                attribute,
                client,
                collection,
                entityId,
                value,
                action
              );
            }}
          />
        ) : attributeDef?.type === 'record' ? (
          <RecordCellEditor
            value={value}
            definition={attributeDef}
            onSubmit={(newValue) => {
              updateTriplitValue(
                attribute,
                client,
                collection,
                entityId,
                newValue
              );
              setIsEditing(false);
            }}
            onBlur={() => setIsEditing(false)}
          />
        ) : (
          <ValueCellEditor
            value={value}
            definition={attributeDef as ValueAttributeDefinition}
            onBlur={() => setIsEditing(false)}
            onSubmit={(newValue: TriplitDataTypes) => {
              if (newValue !== value)
                updateTriplitValue(
                  attribute,
                  client,
                  collection,
                  entityId,
                  newValue
                );
              setIsEditing(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

type SetCellEditorProps = {
  onChangeSet(value: string | null, action: 'add' | 'delete' | 'null'): void;
  set: Set<string> | undefined;
  definition: CollectionAttributeDefinition;
};

function SetCellEditor(props: SetCellEditorProps) {
  const { set, onChangeSet, definition } = props;
  const nullable = definition.options?.nullable;
  return (
    <div className="flex flex-col p-1 gap-1 items-start">
      <SetInput
        value={set}
        onAddItem={(value) => {
          onChangeSet(value, 'add');
        }}
        onRemoveItem={(value) => {
          onChangeSet(value, 'delete');
        }}
        parse={PARSE_FUNCS[definition.items.type]}
        renderItem={(value) => (
          <CellValue value={value} definition={definition.items} />
        )}
      />
      {nullable && (
        <Button
          className="text-xs h-auto py-1 px-2 justify-self-start"
          variant={'ghost'}
          onClick={(e) => {
            onChangeSet(null, 'null');
          }}
        >
          Set to <Code className="text-xs ml-1">null</Code>
        </Button>
      )}
    </div>
  );
}

type ValueCellEditorProps = {
  value: TriplitDataTypes;
  definition: ValueAttributeDefinition;
  onSubmit: (newValue: TriplitDataTypes) => void;
  onBlur: () => void;
};

function coerceStringToTriplitType(
  value: string | null | Array<any>,
  definition: AttributeDefinition
) {
  const { type } = definition;
  if (value === null || value === null) return value;
  if (type === 'number') return Number(value);
  if (type === 'boolean') return JSON.parse(value);
  if (type === 'date') return new Date(value);
  if (type === 'set') return new Set(value);
  if (type === 'record')
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        coerceStringToTriplitType(value, definition.properties[key]),
      ])
    );
  return value;
}

function coerceTriplitTypeToInput(
  value: TriplitDataTypes,
  definition: AttributeDefinition
) {
  const { type } = definition;
  if (type === 'record' && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        coerceTriplitTypeToInput(value, definition.properties[key]),
      ])
    );
  if (value === null || value === undefined) return '';
  if (type && type === 'date')
    return new Date(value as string | Date).toISOString();
  return String(value);
}

function ValueCellEditor(props: ValueCellEditorProps) {
  const { value, definition, onSubmit, onBlur } = props;
  const { type, options } = definition;
  const nullable = !!options?.nullable;
  const [draftValue, setDraftValue] = useState<string>(
    type ? coerceTriplitTypeToInput(value, definition) : JSON.stringify(value)
  );
  const [error, setError] = useState('');
  const EditorInput = useMemo(() => {
    if (type === 'date') return DateInput;
    if (type === 'boolean') return BooleanInput;
    if (type === 'number') return NumberInput;
    return StringInput;
  }, [type]);

  const submitNewValue = useCallback(() => {
    try {
      const submitValue = type
        ? coerceStringToTriplitType(draftValue, definition)
        : JSON.parse(draftValue);
      onSubmit(submitValue);
    } catch (e: any) {
      setError(e.message);
    }
  }, [definition, draftValue]);

  return (
    <div>
      <EditorInput
        onChange={(newValue) => {
          setDraftValue(newValue);
          setError('');
        }}
        value={draftValue}
      />
      {error && <div className="text-red-500 my-1 text-xs">{error}</div>}
      <div className="flex flex-row gap-1 justify-end mt-1">
        {nullable && (
          <Button
            className="text-xs h-auto py-1 px-2 justify-self-start"
            variant={'ghost'}
            onClick={(e) => {
              onSubmit(null);
            }}
          >
            Set to <Code className="text-xs ml-1">null</Code>
          </Button>
        )}
        <Button
          onClick={(e) => {
            onBlur();
          }}
          size={'sm'}
          className="text-xs h-auto py-1 px-2"
          variant={'outline'}
        >
          Cancel
        </Button>
        <Button
          onClick={(e) => {
            e.preventDefault();
            submitNewValue();
          }}
          size={'sm'}
          className="text-xs h-auto py-1 px-2"
        >
          Save
        </Button>
      </div>
    </div>
  );
}

type RecordCellEditorProps = {
  value: Record<string, any>;
  definition: RecordAttributeDefinition;
  onSubmit: (newValue: Record<string, any>) => void;
  onBlur: () => void;
};

function RecordCellEditor(props: RecordCellEditorProps) {
  const { value, definition, onSubmit, onBlur } = props;
  const { properties } = definition;
  const [draftValue, setDraftValue] = useState<string>(
    coerceTriplitTypeToInput(value, definition)
  );

  const EditorInputs = useMemo(() => {
    return Object.keys(properties).map((key) => {
      const type = properties[key].type;
      if (type === 'date') return DateInput;
      if (type === 'boolean') return BooleanInput;
      if (type === 'number') return NumberInput;
      return StringInput;
    });
  }, [properties]);

  return (
    <div className="flex flex-col gap-2">
      {EditorInputs.map((EditorInput, index) => {
        const key = Object.keys(properties)[index];
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="text-xs ml-1">{key}</div>
            <EditorInput
              onChange={(newValue) => {
                setDraftValue((draftValue) => {
                  const newDraftValue = { ...draftValue };
                  newDraftValue[key] = newValue;
                  return newDraftValue;
                });
              }}
              value={draftValue[key]}
            />
          </div>
        );
      })}
      <div className="flex flex-row gap-1 justify-end mt-1">
        <Button
          onClick={(e) => {
            onBlur();
          }}
          size={'sm'}
          className="text-xs h-auto py-1 px-2"
          variant={'outline'}
        >
          Cancel
        </Button>
        <Button
          onClick={(e) => {
            e.preventDefault();
            onSubmit(coerceStringToTriplitType(draftValue, definition));
          }}
          size={'sm'}
          className="text-xs h-auto py-1 px-2"
        >
          Save
        </Button>
      </div>
    </div>
  );
}

type InputProps = {
  value: string;
  onChange: (newValue: any) => void;
};

function NumberInput(props: InputProps) {
  const { value, onChange } = props;
  return (
    <Input
      autoFocus
      type="number"
      value={value || undefined}
      onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
    />
  );
}

function BooleanInput(props: InputProps) {
  const { value, onChange } = props;
  return (
    <Select
      data={['false', 'true']}
      value={value}
      onValueChange={(value) => onChange(value)}
    />
  );
}

function StringInput(props: InputProps) {
  const { value, onChange } = props;
  return (
    <Textarea
      className="bg-muted"
      autoFocus
      value={value as string}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

function DateInput(props: InputProps) {
  const { value, onChange } = props;
  return (
    <Input
      autoFocus
      type="text"
      maxLength={24}
      value={value as string}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function DataTable<TData, TValue>({
  columns,
  data,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    defaultColumn: {
      size: 150,
      minSize: 50,
      maxSize: 1000,
    },
    getRowId: (row) => row.id,
  });

  return (
    <Table
      className="bg-popover text-xs w-full border-r border-t"
      style={{ width: table.getCenterTotalSize() }}
    >
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className={``}>
            {headerGroup.headers.map((header, index) => {
              return (
                <TableHead
                  key={header.id}
                  className="px-0 relative truncate "
                  style={{ width: header.getSize() }}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                  {header.id !== 'new_column_creator' && (
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      className="cursor-col-resize absolute right-0 top-0 w-2 h-full"
                    />
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody className="">
        {table.getRowModel().rows?.length ? (
          table.getRowModel().rows.map((row) => {
            return (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() && 'selected'}
              >
                {row.getVisibleCells().map((cell) => (
                  // This key shouldn't use index
                  <FlashingCell key={cell.id} cell={cell} />
                ))}
              </TableRow>
            );
          })
        ) : (
          <TableRow className="bg-popover hover:bg-inherit">
            <TableCell
              colSpan={columns.length}
              className="h-24 w-full text-center text-muted-foreground"
            >
              No results
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function FlashingCell({ cell }: { cell: Cell<any, any> }) {
  const stringifiedValue = useMemo(() => {
    const value = cell.getValue();
    if (typeof value !== 'object' || value === null) return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Set) return JSON.stringify([...value]);
    if (value instanceof Map) return JSON.stringify([...value]);
    return JSON.stringify(value);
  }, [cell.getValue()]);
  const [hasRecentlyChanged, setHasRecentlyChanged] = useState(false);

  const prevState = useRef(undefined);
  // const [isFirstRender, setIsFirstRender] = useState(true);

  useEffect(() => {
    if (
      prevState.current !== stringifiedValue &&
      prevState.current !== undefined
    ) {
      setHasRecentlyChanged(true);
      setTimeout(() => {
        setHasRecentlyChanged(false);
      }, 1000);
    }
    prevState.current = stringifiedValue;
  }, [stringifiedValue]);

  return (
    <TableCell
      className={`truncate p-0 transition-colors ${
        hasRecentlyChanged ? 'bg-muted' : 'bg-transparent'
      }`}
      style={{ width: cell.column.getSize() }}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </TableCell>
  );
}
