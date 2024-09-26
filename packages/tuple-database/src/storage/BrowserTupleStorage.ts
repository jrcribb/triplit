import { TupleStorageApi } from "../database/sync/types.js"
import { InMemoryTupleStorage } from "./InMemoryTupleStorage.js"
import { WriteOps } from "./types.js"

function load(key: string) {
	const result = localStorage.getItem(key)
	if (!result) return
	try {
		return JSON.parse(result)
	} catch (error) {}
}

function save(key: string, value: any) {
	localStorage.setItem(key, JSON.stringify(value))
}

export class BrowserTupleStorage
	extends InMemoryTupleStorage
	implements TupleStorageApi
{
	constructor(public localStorageKey: string) {
		super(load(localStorageKey))
	}

	commit(writes: WriteOps): void {
		super.commit(writes)
		save(this.localStorageKey, this.data)
	}
}
