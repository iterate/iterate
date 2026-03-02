import type { D1Database } from '@cloudflare/workers-types';

export type SelectRouteByIdParams = {
	routeId: string;
}

export type SelectRouteByIdResult = {
	id: string;
	metadata: string;
	created_at: string;
	updated_at: string;
}

export async function selectRouteById(db: D1Database, params: SelectRouteByIdParams): Promise<SelectRouteByIdResult | null> {
	const sql = `
	SELECT id, metadata, created_at, updated_at
	FROM routes
	WHERE id = ?
	
	`
	return db.prepare(sql)
		.bind(params.routeId)
		.raw({ columnNames: false })
		.then(rows => rows.length > 0 ? mapArrayToSelectRouteByIdResult(rows[0]) : null);
}

function mapArrayToSelectRouteByIdResult(data: any) {
	const result: SelectRouteByIdResult = {
		id: data[0],
		metadata: data[1],
		created_at: data[2],
		updated_at: data[3]
	}
	return result;
}