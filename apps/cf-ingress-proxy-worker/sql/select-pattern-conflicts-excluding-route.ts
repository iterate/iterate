import type { D1Database } from '@cloudflare/workers-types';

export type SelectPatternConflictsExcludingRouteParams = {
	patterns: string[];
	excludeRouteId: string;
}

export type SelectPatternConflictsExcludingRouteResult = {
	routeId: string;
	pattern: string;
}

export async function selectPatternConflictsExcludingRoute(db: D1Database, params: SelectPatternConflictsExcludingRouteParams): Promise<SelectPatternConflictsExcludingRouteResult[]> {
	const sql = `
	SELECT route_id AS routeId, pattern
	FROM route_patterns
	WHERE pattern IN (${params.patterns.map(() => '?')})
	  AND route_id != ?
	ORDER BY route_id ASC, pattern ASC
	
	`
	return db.prepare(sql)
		.bind(...params.patterns, params.excludeRouteId)
		.raw({ columnNames: false })
		.then(rows => rows.map(row => mapArrayToSelectPatternConflictsExcludingRouteResult(row)));
}

function mapArrayToSelectPatternConflictsExcludingRouteResult(data: any) {
	const result: SelectPatternConflictsExcludingRouteResult = {
		routeId: data[0],
		pattern: data[1]
	}
	return result;
}