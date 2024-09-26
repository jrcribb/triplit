import { useEffect, useMemo, useRef } from "react"
import { subscribeQuery } from "./database/sync/subscribeQuery.js"
import { TupleDatabaseClientApi } from "./database/sync/types.js"
import { shallowEqual } from "./helpers/shallowEqual.js"
import { useRerender } from "./helpers/useRerender.js"
import { KeyValuePair } from "./storage/types.js"

/** Useful for managing UI state for React with a TupleDatabase. */
export function useTupleDatabase<S extends KeyValuePair, T, A extends any[]>(
	db: TupleDatabaseClientApi<S>,
	fn: (db: TupleDatabaseClientApi<S>, ...arg: A) => T,
	args: A
) {
	const rerender = useRerender()
	const resultRef = useRef<T>({} as any)

	const destroy = useMemo(() => {
		const { result, destroy } = subscribeQuery(
			db,
			(db) => fn(db, ...args),
			(result) => {
				if (!shallowEqual(resultRef.current, result)) {
					resultRef.current = result
					rerender()
				}
			}
		)
		resultRef.current = result
		return destroy
	}, [db, fn, ...args])

	useEffect(() => {
		return destroy
	}, [destroy])

	return resultRef.current
}
