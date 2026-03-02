import type { D1Database } from '@cloudflare/workers-types';

export type SelectRoutesResult = {
	id: string;
	metadata: string;
	created_at: string;
	updated_at: string;
}

export async function selectRoutes(db: D1Database): Promise<SelectRoutesResult[]> {
	const sql = `
	SELECT id, metadata, created_at, updated_at
	FROM routes
	ORDER BY created_at ASC, id ASC
	
	`
	return db.prepare(sql)
		.raw({ columnNames: false })
		.then(rows => rows.map(row => mapArrayToSelectRoutesResult(row)));
}

function mapArrayToSelectRoutesResult(data: any) {
	const result: SelectRoutesResult = {
		id: data[0],
		metadata: data[1],
		created_at: data[2],
		updated_at: data[3]
	}
	return result;
}