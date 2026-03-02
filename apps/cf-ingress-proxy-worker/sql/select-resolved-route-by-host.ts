import type { D1Database } from '@cloudflare/workers-types';

export type SelectResolvedRouteByHostParams = {
	host: string;
}

export type SelectResolvedRouteByHostResult = {
	routeId: string;
	pattern: string;
	target: string;
	headers: string;
	metadata: string;
}

export async function selectResolvedRouteByHost(db: D1Database, params: SelectResolvedRouteByHostParams): Promise<SelectResolvedRouteByHostResult | null> {
	const sql = `
	SELECT
	  rp.route_id AS routeId,
	  rp.pattern AS pattern,
	  rp.target AS target,
	  rp.headers AS headers,
	  r.metadata AS metadata
	FROM route_patterns rp
	INNER JOIN routes r ON r.id = rp.route_id
	WHERE ? GLOB rp.pattern
	ORDER BY
	  CASE WHEN rp.pattern NOT LIKE '%*%' THEN 1 ELSE 0 END DESC,
	  length(rp.pattern) DESC,
	  rp.id ASC
	LIMIT 1
	
	`
	return db.prepare(sql)
		.bind(params.host)
		.raw({ columnNames: false })
		.then(rows => rows.length > 0 ? mapArrayToSelectResolvedRouteByHostResult(rows[0]) : null);
}

function mapArrayToSelectResolvedRouteByHostResult(data: any) {
	const result: SelectResolvedRouteByHostResult = {
		routeId: data[0],
		pattern: data[1],
		target: data[2],
		headers: data[3],
		metadata: data[4]
	}
	return result;
}