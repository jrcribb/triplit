import { Flag, FlagsToTypes } from './flags.js';

/**
 *
 * @param def
 * @returns Either a context object to merge into the current context, or a string to print to the console as an error messages.
 */
export function Middleware<
  Args extends string[] = string[],
  Flags extends Record<string, Flag> = Record<string, Flag>,
  Ctx extends Record<string, any> = Record<string, any>
>(
  def: MiddlewareDefinition<Args, Flags, Ctx>
): MiddlewareDefinition<Args, Flags, Ctx> {
  return def;
}

export interface MiddlewareDefinition<
  Args extends string[],
  Flags extends { [key: string]: Flag } | undefined,
  Ctx extends Record<string, any>
> {
  name: string;
  description?: string;
  args?: Args;
  flags?: Flags;
  run: (params: {
    flags: FlagsToTypes<Flags>;
    args: Args;
  }) => Ctx | Promise<Ctx> | string | Promise<string>;
}
