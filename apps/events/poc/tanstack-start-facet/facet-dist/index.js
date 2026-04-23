import {
  a as __toESM,
  n as require_react,
  r as __commonJSMin,
  t as require_jsx_runtime,
} from "./assets/jsx-runtime-B8ri5dzN.js";
import {
  $ as View,
  A as inArray,
  B as notIlike,
  C as and,
  D as gt$1,
  E as exists,
  F as lte,
  G as getTableColumns,
  H as notLike,
  I as ne$2,
  J as mapResultRow,
  K as getTableLikeName,
  L as not,
  M as isNull,
  N as like,
  O as gte,
  P as lt$1,
  Q as SQL,
  R as notBetween,
  S as desc,
  T as eq,
  U as or$1,
  V as notInArray,
  W as applyMixins,
  X as orderSelectedFields,
  Y as mapUpdateSet,
  Z as Param,
  at as Column,
  b as SQLiteColumn,
  ct as getTableName,
  dt as is,
  et as fillPlaceholders,
  f as resolveManifestAssetLink,
  h as createMemoryHistory,
  i as Match,
  it as WithSubquery,
  j as isNotNull,
  k as ilike,
  l as CatchBoundary,
  lt as getTableUniqueName,
  nt as ViewBaseConfig,
  o as SafeFragment,
  ot as Columns,
  q as haveSameKeys,
  r as WebSocketResponse,
  rt as Subquery,
  st as Table,
  t as schema_exports,
  tt as sql,
  u as ErrorComponent,
  ut as entityKind,
  v as executeRewriteInput,
  w as between,
  x as asc,
  y as SQLiteTable,
  z as notExists,
} from "./assets/schema-CqGeDXDz.js";
import {
  D as createLRUCache,
  M as decodePath,
  O as invariant,
  a as matchContext,
  d as isNotFound,
  n as require_react_dom,
  o as useRouter,
  s as routerContext,
  t as getServerFnById,
  u as rootRouteId,
} from "./assets/__23tanstack-start-server-fn-resolver-CRZD-Up_.js";
import {
  a as runWithStartContext,
  c as FrameType,
  d as TSS_SERVER_FUNCTION,
  f as X_TSS_RAW_RESPONSE,
  g as isResolvedRedirect,
  h as isRedirect,
  i as getStartContext,
  l as TSS_CONTENT_TYPE_FRAMED_VERSIONED,
  m as mergeHeaders,
  n as flattenMiddlewares,
  o as createNullProtoObject,
  p as X_TSS_SERIALIZED,
  r as getStartOptions,
  s as safeObjectMerge,
  u as TSS_FORMDATA_CONTEXT,
} from "./assets/createServerFn-Df2o8xb7.js";
import { DurableObject } from "cloudflare:workers";
import { ReadableStream as ReadableStream$1 } from "node:stream/web";
import { PassThrough, Readable } from "node:stream";
import { AsyncLocalStorage as AsyncLocalStorage$1 } from "node:async_hooks";
//#region node_modules/drizzle-orm/logger.js
var ConsoleLogWriter = class {
  static [entityKind] = "ConsoleLogWriter";
  write(message) {
    console.log(message);
  }
};
var DefaultLogger = class {
  static [entityKind] = "DefaultLogger";
  writer;
  constructor(config) {
    this.writer = config?.writer ?? new ConsoleLogWriter();
  }
  logQuery(query, params) {
    const stringifiedParams = params.map((p) => {
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    });
    const paramsStr = stringifiedParams.length
      ? ` -- params: [${stringifiedParams.join(", ")}]`
      : "";
    this.writer.write(`Query: ${query}${paramsStr}`);
  }
};
var NoopLogger = class {
  static [entityKind] = "NoopLogger";
  logQuery() {}
};
//#endregion
//#region node_modules/drizzle-orm/pg-core/table.js
var InlineForeignKeys = Symbol.for("drizzle:PgInlineForeignKeys");
var EnableRLS = Symbol.for("drizzle:EnableRLS");
var PgTable = class extends Table {
  static [entityKind] = "PgTable";
  /** @internal */
  static Symbol = Object.assign({}, Table.Symbol, {
    InlineForeignKeys,
    EnableRLS,
  });
  /**@internal */
  [InlineForeignKeys] = [];
  /** @internal */
  [EnableRLS] = false;
  /** @internal */
  [Table.Symbol.ExtraConfigBuilder] = void 0;
  /** @internal */
  [Table.Symbol.ExtraConfigColumns] = {};
};
//#endregion
//#region node_modules/drizzle-orm/pg-core/primary-keys.js
var PrimaryKeyBuilder = class {
  static [entityKind] = "PgPrimaryKeyBuilder";
  /** @internal */
  columns;
  /** @internal */
  name;
  constructor(columns, name) {
    this.columns = columns;
    this.name = name;
  }
  /** @internal */
  build(table) {
    return new PrimaryKey(table, this.columns, this.name);
  }
};
var PrimaryKey = class {
  constructor(table, columns, name) {
    this.table = table;
    this.columns = columns;
    this.name = name;
  }
  static [entityKind] = "PgPrimaryKey";
  columns;
  name;
  getName() {
    return (
      this.name ??
      `${this.table[PgTable.Symbol.Name]}_${this.columns.map((column) => column.name).join("_")}_pk`
    );
  }
};
//#endregion
//#region node_modules/drizzle-orm/relations.js
var Relation = class {
  constructor(sourceTable, referencedTable, relationName) {
    this.sourceTable = sourceTable;
    this.referencedTable = referencedTable;
    this.relationName = relationName;
    this.referencedTableName = referencedTable[Table.Symbol.Name];
  }
  static [entityKind] = "Relation";
  referencedTableName;
  fieldName;
};
var Relations = class {
  constructor(table, config) {
    this.table = table;
    this.config = config;
  }
  static [entityKind] = "Relations";
};
var One = class One extends Relation {
  constructor(sourceTable, referencedTable, config, isNullable) {
    super(sourceTable, referencedTable, config?.relationName);
    this.config = config;
    this.isNullable = isNullable;
  }
  static [entityKind] = "One";
  withFieldName(fieldName) {
    const relation = new One(this.sourceTable, this.referencedTable, this.config, this.isNullable);
    relation.fieldName = fieldName;
    return relation;
  }
};
var Many = class Many extends Relation {
  constructor(sourceTable, referencedTable, config) {
    super(sourceTable, referencedTable, config?.relationName);
    this.config = config;
  }
  static [entityKind] = "Many";
  withFieldName(fieldName) {
    const relation = new Many(this.sourceTable, this.referencedTable, this.config);
    relation.fieldName = fieldName;
    return relation;
  }
};
function getOperators() {
  return {
    and,
    between,
    eq,
    exists,
    gt: gt$1,
    gte,
    ilike,
    inArray,
    isNull,
    isNotNull,
    like,
    lt: lt$1,
    lte,
    ne: ne$2,
    not,
    notBetween,
    notExists,
    notLike,
    notIlike,
    notInArray,
    or: or$1,
    sql,
  };
}
function getOrderByOperators() {
  return {
    sql,
    asc,
    desc,
  };
}
function extractTablesRelationalConfig(schema, configHelpers) {
  if (Object.keys(schema).length === 1 && "default" in schema && !is(schema["default"], Table))
    schema = schema["default"];
  const tableNamesMap = {};
  const relationsBuffer = {};
  const tablesConfig = {};
  for (const [key, value] of Object.entries(schema))
    if (is(value, Table)) {
      const dbName = getTableUniqueName(value);
      const bufferedRelations = relationsBuffer[dbName];
      tableNamesMap[dbName] = key;
      tablesConfig[key] = {
        tsName: key,
        dbName: value[Table.Symbol.Name],
        schema: value[Table.Symbol.Schema],
        columns: value[Table.Symbol.Columns],
        relations: bufferedRelations?.relations ?? {},
        primaryKey: bufferedRelations?.primaryKey ?? [],
      };
      for (const column of Object.values(value[Table.Symbol.Columns]))
        if (column.primary) tablesConfig[key].primaryKey.push(column);
      const extraConfig = value[Table.Symbol.ExtraConfigBuilder]?.(
        value[Table.Symbol.ExtraConfigColumns],
      );
      if (extraConfig) {
        for (const configEntry of Object.values(extraConfig))
          if (is(configEntry, PrimaryKeyBuilder))
            tablesConfig[key].primaryKey.push(...configEntry.columns);
      }
    } else if (is(value, Relations)) {
      const dbName = getTableUniqueName(value.table);
      const tableName = tableNamesMap[dbName];
      const relations2 = value.config(configHelpers(value.table));
      let primaryKey;
      for (const [relationName, relation] of Object.entries(relations2))
        if (tableName) {
          const tableConfig = tablesConfig[tableName];
          tableConfig.relations[relationName] = relation;
        } else {
          if (!(dbName in relationsBuffer))
            relationsBuffer[dbName] = {
              relations: {},
              primaryKey,
            };
          relationsBuffer[dbName].relations[relationName] = relation;
        }
    }
  return {
    tables: tablesConfig,
    tableNamesMap,
  };
}
function createOne(sourceTable) {
  return function one(table, config) {
    return new One(
      sourceTable,
      table,
      config,
      config?.fields.reduce((res, f) => res && f.notNull, true) ?? false,
    );
  };
}
function createMany(sourceTable) {
  return function many(referencedTable, config) {
    return new Many(sourceTable, referencedTable, config);
  };
}
function normalizeRelation(schema, tableNamesMap, relation) {
  if (is(relation, One) && relation.config)
    return {
      fields: relation.config.fields,
      references: relation.config.references,
    };
  const referencedTableTsName = tableNamesMap[getTableUniqueName(relation.referencedTable)];
  if (!referencedTableTsName)
    throw new Error(`Table "${relation.referencedTable[Table.Symbol.Name]}" not found in schema`);
  const referencedTableConfig = schema[referencedTableTsName];
  if (!referencedTableConfig)
    throw new Error(`Table "${referencedTableTsName}" not found in schema`);
  const sourceTable = relation.sourceTable;
  const sourceTableTsName = tableNamesMap[getTableUniqueName(sourceTable)];
  if (!sourceTableTsName)
    throw new Error(`Table "${sourceTable[Table.Symbol.Name]}" not found in schema`);
  const reverseRelations = [];
  for (const referencedTableRelation of Object.values(referencedTableConfig.relations))
    if (
      (relation.relationName &&
        relation !== referencedTableRelation &&
        referencedTableRelation.relationName === relation.relationName) ||
      (!relation.relationName && referencedTableRelation.referencedTable === relation.sourceTable)
    )
      reverseRelations.push(referencedTableRelation);
  if (reverseRelations.length > 1)
    throw relation.relationName
      ? /* @__PURE__ */ new Error(
          `There are multiple relations with name "${relation.relationName}" in table "${referencedTableTsName}"`,
        )
      : /* @__PURE__ */ new Error(
          `There are multiple relations between "${referencedTableTsName}" and "${relation.sourceTable[Table.Symbol.Name]}". Please specify relation name`,
        );
  if (reverseRelations[0] && is(reverseRelations[0], One) && reverseRelations[0].config)
    return {
      fields: reverseRelations[0].config.references,
      references: reverseRelations[0].config.fields,
    };
  throw new Error(
    `There is not enough information to infer relation "${sourceTableTsName}.${relation.fieldName}"`,
  );
}
function createTableRelationsHelpers(sourceTable) {
  return {
    one: createOne(sourceTable),
    many: createMany(sourceTable),
  };
}
function mapRelationalRow(
  tablesConfig,
  tableConfig,
  row,
  buildQueryResultSelection,
  mapColumnValue = (value) => value,
) {
  const result = {};
  for (const [selectionItemIndex, selectionItem] of buildQueryResultSelection.entries())
    if (selectionItem.isJson) {
      const relation = tableConfig.relations[selectionItem.tsKey];
      const rawSubRows = row[selectionItemIndex];
      const subRows = typeof rawSubRows === "string" ? JSON.parse(rawSubRows) : rawSubRows;
      result[selectionItem.tsKey] = is(relation, One)
        ? subRows &&
          mapRelationalRow(
            tablesConfig,
            tablesConfig[selectionItem.relationTableTsKey],
            subRows,
            selectionItem.selection,
            mapColumnValue,
          )
        : subRows.map((subRow) =>
            mapRelationalRow(
              tablesConfig,
              tablesConfig[selectionItem.relationTableTsKey],
              subRow,
              selectionItem.selection,
              mapColumnValue,
            ),
          );
    } else {
      const value = mapColumnValue(row[selectionItemIndex]);
      const field = selectionItem.field;
      let decoder;
      if (is(field, Column)) decoder = field;
      else if (is(field, SQL)) decoder = field.decoder;
      else decoder = field.sql.decoder;
      result[selectionItem.tsKey] = value === null ? null : decoder.mapFromDriverValue(value);
    }
  return result;
}
//#endregion
//#region node_modules/drizzle-orm/alias.js
var ColumnAliasProxyHandler = class {
  constructor(table) {
    this.table = table;
  }
  static [entityKind] = "ColumnAliasProxyHandler";
  get(columnObj, prop) {
    if (prop === "table") return this.table;
    return columnObj[prop];
  }
};
var TableAliasProxyHandler = class {
  constructor(alias, replaceOriginalName) {
    this.alias = alias;
    this.replaceOriginalName = replaceOriginalName;
  }
  static [entityKind] = "TableAliasProxyHandler";
  get(target, prop) {
    if (prop === Table.Symbol.IsAlias) return true;
    if (prop === Table.Symbol.Name) return this.alias;
    if (this.replaceOriginalName && prop === Table.Symbol.OriginalName) return this.alias;
    if (prop === ViewBaseConfig)
      return {
        ...target[ViewBaseConfig],
        name: this.alias,
        isAlias: true,
      };
    if (prop === Table.Symbol.Columns) {
      const columns = target[Table.Symbol.Columns];
      if (!columns) return columns;
      const proxiedColumns = {};
      Object.keys(columns).map((key) => {
        proxiedColumns[key] = new Proxy(
          columns[key],
          new ColumnAliasProxyHandler(new Proxy(target, this)),
        );
      });
      return proxiedColumns;
    }
    const value = target[prop];
    if (is(value, Column))
      return new Proxy(value, new ColumnAliasProxyHandler(new Proxy(target, this)));
    return value;
  }
};
function aliasedTable(table, tableAlias) {
  return new Proxy(table, new TableAliasProxyHandler(tableAlias, false));
}
function aliasedTableColumn(column, tableAlias) {
  return new Proxy(
    column,
    new ColumnAliasProxyHandler(
      new Proxy(column.table, new TableAliasProxyHandler(tableAlias, false)),
    ),
  );
}
function mapColumnsInAliasedSQLToAlias(query, alias) {
  return new SQL.Aliased(mapColumnsInSQLToAlias(query.sql, alias), query.fieldAlias);
}
function mapColumnsInSQLToAlias(query, alias) {
  return sql.join(
    query.queryChunks.map((c) => {
      if (is(c, Column)) return aliasedTableColumn(c, alias);
      if (is(c, SQL)) return mapColumnsInSQLToAlias(c, alias);
      if (is(c, SQL.Aliased)) return mapColumnsInAliasedSQLToAlias(c, alias);
      return c;
    }),
  );
}
//#endregion
//#region node_modules/drizzle-orm/selection-proxy.js
var SelectionProxyHandler = class SelectionProxyHandler {
  static [entityKind] = "SelectionProxyHandler";
  config;
  constructor(config) {
    this.config = { ...config };
  }
  get(subquery, prop) {
    if (prop === "_")
      return {
        ...subquery["_"],
        selectedFields: new Proxy(subquery._.selectedFields, this),
      };
    if (prop === ViewBaseConfig)
      return {
        ...subquery[ViewBaseConfig],
        selectedFields: new Proxy(subquery[ViewBaseConfig].selectedFields, this),
      };
    if (typeof prop === "symbol") return subquery[prop];
    const value = (
      is(subquery, Subquery)
        ? subquery._.selectedFields
        : is(subquery, View)
          ? subquery[ViewBaseConfig].selectedFields
          : subquery
    )[prop];
    if (is(value, SQL.Aliased)) {
      if (this.config.sqlAliasedBehavior === "sql" && !value.isSelectionField) return value.sql;
      const newValue = value.clone();
      newValue.isSelectionField = true;
      return newValue;
    }
    if (is(value, SQL)) {
      if (this.config.sqlBehavior === "sql") return value;
      throw new Error(
        `You tried to reference "${prop}" field from a subquery, which is a raw SQL field, but it doesn't have an alias declared. Please add an alias to the field using ".as('alias')" method.`,
      );
    }
    if (is(value, Column)) {
      if (this.config.alias)
        return new Proxy(
          value,
          new ColumnAliasProxyHandler(
            new Proxy(
              value.table,
              new TableAliasProxyHandler(
                this.config.alias,
                this.config.replaceOriginalName ?? false,
              ),
            ),
          ),
        );
      return value;
    }
    if (typeof value !== "object" || value === null) return value;
    return new Proxy(value, new SelectionProxyHandler(this.config));
  }
};
//#endregion
//#region node_modules/drizzle-orm/query-promise.js
var QueryPromise = class {
  static [entityKind] = "QueryPromise";
  [Symbol.toStringTag] = "QueryPromise";
  catch(onRejected) {
    return this.then(void 0, onRejected);
  }
  finally(onFinally) {
    return this.then(
      (value) => {
        onFinally?.();
        return value;
      },
      (reason) => {
        onFinally?.();
        throw reason;
      },
    );
  }
  then(onFulfilled, onRejected) {
    return this.execute().then(onFulfilled, onRejected);
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/utils.js
function extractUsedTable(table) {
  if (is(table, SQLiteTable)) return [`${table[Table.Symbol.BaseName]}`];
  if (is(table, Subquery)) return table._.usedTables ?? [];
  if (is(table, SQL)) return table.usedTables ?? [];
  return [];
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/delete.js
var SQLiteDeleteBase = class extends QueryPromise {
  constructor(table, session, dialect, withList) {
    super();
    this.table = table;
    this.session = session;
    this.dialect = dialect;
    this.config = {
      table,
      withList,
    };
  }
  static [entityKind] = "SQLiteDelete";
  /** @internal */
  config;
  /**
   * Adds a `where` clause to the query.
   *
   * Calling this method will delete only those rows that fulfill a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/delete}
   *
   * @param where the `where` clause.
   *
   * @example
   * You can use conditional operators and `sql function` to filter the rows to be deleted.
   *
   * ```ts
   * // Delete all cars with green color
   * db.delete(cars).where(eq(cars.color, 'green'));
   * // or
   * db.delete(cars).where(sql`${cars.color} = 'green'`)
   * ```
   *
   * You can logically combine conditional operators with `and()` and `or()` operators:
   *
   * ```ts
   * // Delete all BMW cars with a green color
   * db.delete(cars).where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
   *
   * // Delete all cars with the green or blue color
   * db.delete(cars).where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
   * ```
   */
  where(where) {
    this.config.where = where;
    return this;
  }
  orderBy(...columns) {
    if (typeof columns[0] === "function") {
      const orderBy = columns[0](
        new Proxy(
          this.config.table[Table.Symbol.Columns],
          new SelectionProxyHandler({
            sqlAliasedBehavior: "alias",
            sqlBehavior: "sql",
          }),
        ),
      );
      const orderByArray = Array.isArray(orderBy) ? orderBy : [orderBy];
      this.config.orderBy = orderByArray;
    } else {
      const orderByArray = columns;
      this.config.orderBy = orderByArray;
    }
    return this;
  }
  limit(limit) {
    this.config.limit = limit;
    return this;
  }
  returning(fields = this.table[SQLiteTable.Symbol.Columns]) {
    this.config.returning = orderSelectedFields(fields);
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildDeleteQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  /** @internal */
  _prepare(isOneTimeQuery = true) {
    return this.session[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.dialect.sqlToQuery(this.getSQL()),
      this.config.returning,
      this.config.returning ? "all" : "run",
      true,
      void 0,
      {
        type: "delete",
        tables: extractUsedTable(this.config.table),
      },
    );
  }
  prepare() {
    return this._prepare(false);
  }
  run = (placeholderValues) => {
    return this._prepare().run(placeholderValues);
  };
  all = (placeholderValues) => {
    return this._prepare().all(placeholderValues);
  };
  get = (placeholderValues) => {
    return this._prepare().get(placeholderValues);
  };
  values = (placeholderValues) => {
    return this._prepare().values(placeholderValues);
  };
  async execute(placeholderValues) {
    return this._prepare().execute(placeholderValues);
  }
  $dynamic() {
    return this;
  }
};
//#endregion
//#region node_modules/drizzle-orm/casing.js
function toSnakeCase(input) {
  return (input.replace(/['\u2019]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [])
    .map((word) => word.toLowerCase())
    .join("_");
}
function toCamelCase(input) {
  return (
    input.replace(/['\u2019]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? []
  ).reduce((acc, word, i) => {
    return acc + (i === 0 ? word.toLowerCase() : `${word[0].toUpperCase()}${word.slice(1)}`);
  }, "");
}
function noopCase(input) {
  return input;
}
var CasingCache = class {
  static [entityKind] = "CasingCache";
  /** @internal */
  cache = {};
  cachedTables = {};
  convert;
  constructor(casing) {
    this.convert =
      casing === "snake_case" ? toSnakeCase : casing === "camelCase" ? toCamelCase : noopCase;
  }
  getColumnCasing(column) {
    if (!column.keyAsName) return column.name;
    const key = `${column.table[Table.Symbol.Schema] ?? "public"}.${column.table[Table.Symbol.OriginalName]}.${column.name}`;
    if (!this.cache[key]) this.cacheTable(column.table);
    return this.cache[key];
  }
  cacheTable(table) {
    const tableKey = `${table[Table.Symbol.Schema] ?? "public"}.${table[Table.Symbol.OriginalName]}`;
    if (!this.cachedTables[tableKey]) {
      for (const column of Object.values(table[Table.Symbol.Columns])) {
        const columnKey = `${tableKey}.${column.name}`;
        this.cache[columnKey] = this.convert(column.name);
      }
      this.cachedTables[tableKey] = true;
    }
  }
  clearCache() {
    this.cache = {};
    this.cachedTables = {};
  }
};
//#endregion
//#region node_modules/drizzle-orm/errors.js
var DrizzleError = class extends Error {
  static [entityKind] = "DrizzleError";
  constructor({ message, cause }) {
    super(message);
    this.name = "DrizzleError";
    this.cause = cause;
  }
};
var DrizzleQueryError = class DrizzleQueryError extends Error {
  constructor(query, params, cause) {
    super(`Failed query: ${query}
params: ${params}`);
    this.query = query;
    this.params = params;
    this.cause = cause;
    Error.captureStackTrace(this, DrizzleQueryError);
    if (cause) this.cause = cause;
  }
};
var TransactionRollbackError = class extends DrizzleError {
  static [entityKind] = "TransactionRollbackError";
  constructor() {
    super({ message: "Rollback" });
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/view-base.js
var SQLiteViewBase = class extends View {
  static [entityKind] = "SQLiteViewBase";
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/dialect.js
var SQLiteDialect = class {
  static [entityKind] = "SQLiteDialect";
  /** @internal */
  casing;
  constructor(config) {
    this.casing = new CasingCache(config?.casing);
  }
  escapeName(name) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  escapeParam(_num) {
    return "?";
  }
  escapeString(str) {
    return `'${str.replace(/'/g, "''")}'`;
  }
  buildWithCTE(queries) {
    if (!queries?.length) return void 0;
    const withSqlChunks = [sql`with `];
    for (const [i, w] of queries.entries()) {
      withSqlChunks.push(sql`${sql.identifier(w._.alias)} as (${w._.sql})`);
      if (i < queries.length - 1) withSqlChunks.push(sql`, `);
    }
    withSqlChunks.push(sql` `);
    return sql.join(withSqlChunks);
  }
  buildDeleteQuery({ table, where, returning, withList, limit, orderBy }) {
    const withSql = this.buildWithCTE(withList);
    const returningSql = returning
      ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}`
      : void 0;
    return sql`${withSql}delete from ${table}${where ? sql` where ${where}` : void 0}${returningSql}${this.buildOrderBy(orderBy)}${this.buildLimit(limit)}`;
  }
  buildUpdateSet(table, set) {
    const tableColumns = table[Table.Symbol.Columns];
    const columnNames = Object.keys(tableColumns).filter(
      (colName) => set[colName] !== void 0 || tableColumns[colName]?.onUpdateFn !== void 0,
    );
    const setSize = columnNames.length;
    return sql.join(
      columnNames.flatMap((colName, i) => {
        const col = tableColumns[colName];
        const onUpdateFnResult = col.onUpdateFn?.();
        const value =
          set[colName] ??
          (is(onUpdateFnResult, SQL) ? onUpdateFnResult : sql.param(onUpdateFnResult, col));
        const res = sql`${sql.identifier(this.casing.getColumnCasing(col))} = ${value}`;
        if (i < setSize - 1) return [res, sql.raw(", ")];
        return [res];
      }),
    );
  }
  buildUpdateQuery({ table, set, where, returning, withList, joins, from, limit, orderBy }) {
    const withSql = this.buildWithCTE(withList);
    const setSql = this.buildUpdateSet(table, set);
    const fromSql = from && sql.join([sql.raw(" from "), this.buildFromTable(from)]);
    const joinsSql = this.buildJoins(joins);
    const returningSql = returning
      ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}`
      : void 0;
    return sql`${withSql}update ${table} set ${setSql}${fromSql}${joinsSql}${where ? sql` where ${where}` : void 0}${returningSql}${this.buildOrderBy(orderBy)}${this.buildLimit(limit)}`;
  }
  /**
   * Builds selection SQL with provided fields/expressions
   *
   * Examples:
   *
   * `select <selection> from`
   *
   * `insert ... returning <selection>`
   *
   * If `isSingleTable` is true, then columns won't be prefixed with table name
   */
  buildSelection(fields, { isSingleTable = false } = {}) {
    const columnsLen = fields.length;
    const chunks = fields.flatMap(({ field }, i) => {
      const chunk = [];
      if (is(field, SQL.Aliased) && field.isSelectionField)
        chunk.push(sql.identifier(field.fieldAlias));
      else if (is(field, SQL.Aliased) || is(field, SQL)) {
        const query = is(field, SQL.Aliased) ? field.sql : field;
        if (isSingleTable)
          chunk.push(
            new SQL(
              query.queryChunks.map((c) => {
                if (is(c, Column)) return sql.identifier(this.casing.getColumnCasing(c));
                return c;
              }),
            ),
          );
        else chunk.push(query);
        if (is(field, SQL.Aliased)) chunk.push(sql` as ${sql.identifier(field.fieldAlias)}`);
      } else if (is(field, Column)) {
        const tableName = field.table[Table.Symbol.Name];
        if (field.columnType === "SQLiteNumericBigInt")
          if (isSingleTable)
            chunk.push(sql`cast(${sql.identifier(this.casing.getColumnCasing(field))} as text)`);
          else
            chunk.push(
              sql`cast(${sql.identifier(tableName)}.${sql.identifier(this.casing.getColumnCasing(field))} as text)`,
            );
        else if (isSingleTable) chunk.push(sql.identifier(this.casing.getColumnCasing(field)));
        else
          chunk.push(
            sql`${sql.identifier(tableName)}.${sql.identifier(this.casing.getColumnCasing(field))}`,
          );
      } else if (is(field, Subquery)) {
        const entries = Object.entries(field._.selectedFields);
        if (entries.length === 1) {
          const entry = entries[0][1];
          const fieldDecoder = is(entry, SQL)
            ? entry.decoder
            : is(entry, Column)
              ? { mapFromDriverValue: (v) => entry.mapFromDriverValue(v) }
              : entry.sql.decoder;
          if (fieldDecoder) field._.sql.decoder = fieldDecoder;
        }
        chunk.push(field);
      }
      if (i < columnsLen - 1) chunk.push(sql`, `);
      return chunk;
    });
    return sql.join(chunks);
  }
  buildJoins(joins) {
    if (!joins || joins.length === 0) return;
    const joinsArray = [];
    if (joins)
      for (const [index, joinMeta] of joins.entries()) {
        if (index === 0) joinsArray.push(sql` `);
        const table = joinMeta.table;
        const onSql = joinMeta.on ? sql` on ${joinMeta.on}` : void 0;
        if (is(table, SQLiteTable)) {
          const tableName = table[SQLiteTable.Symbol.Name];
          const tableSchema = table[SQLiteTable.Symbol.Schema];
          const origTableName = table[SQLiteTable.Symbol.OriginalName];
          const alias = tableName === origTableName ? void 0 : joinMeta.alias;
          joinsArray.push(
            sql`${sql.raw(joinMeta.joinType)} join ${tableSchema ? sql`${sql.identifier(tableSchema)}.` : void 0}${sql.identifier(origTableName)}${alias && sql` ${sql.identifier(alias)}`}${onSql}`,
          );
        } else joinsArray.push(sql`${sql.raw(joinMeta.joinType)} join ${table}${onSql}`);
        if (index < joins.length - 1) joinsArray.push(sql` `);
      }
    return sql.join(joinsArray);
  }
  buildLimit(limit) {
    return typeof limit === "object" || (typeof limit === "number" && limit >= 0)
      ? sql` limit ${limit}`
      : void 0;
  }
  buildOrderBy(orderBy) {
    const orderByList = [];
    if (orderBy)
      for (const [index, orderByValue] of orderBy.entries()) {
        orderByList.push(orderByValue);
        if (index < orderBy.length - 1) orderByList.push(sql`, `);
      }
    return orderByList.length > 0 ? sql` order by ${sql.join(orderByList)}` : void 0;
  }
  buildFromTable(table) {
    if (is(table, Table) && table[Table.Symbol.IsAlias])
      return sql`${sql`${sql.identifier(table[Table.Symbol.Schema] ?? "")}.`.if(table[Table.Symbol.Schema])}${sql.identifier(table[Table.Symbol.OriginalName])} ${sql.identifier(table[Table.Symbol.Name])}`;
    return table;
  }
  buildSelectQuery({
    withList,
    fields,
    fieldsFlat,
    where,
    having,
    table,
    joins,
    orderBy,
    groupBy,
    limit,
    offset,
    distinct,
    setOperators,
  }) {
    const fieldsList = fieldsFlat ?? orderSelectedFields(fields);
    for (const f of fieldsList)
      if (
        is(f.field, Column) &&
        getTableName(f.field.table) !==
          (is(table, Subquery)
            ? table._.alias
            : is(table, SQLiteViewBase)
              ? table[ViewBaseConfig].name
              : is(table, SQL)
                ? void 0
                : getTableName(table)) &&
        !((table2) =>
          joins?.some(
            ({ alias }) =>
              alias ===
              (table2[Table.Symbol.IsAlias] ? getTableName(table2) : table2[Table.Symbol.BaseName]),
          ))(f.field.table)
      ) {
        const tableName = getTableName(f.field.table);
        throw new Error(
          `Your "${f.path.join("->")}" field references a column "${tableName}"."${f.field.name}", but the table "${tableName}" is not part of the query! Did you forget to join it?`,
        );
      }
    const isSingleTable = !joins || joins.length === 0;
    const withSql = this.buildWithCTE(withList);
    const distinctSql = distinct ? sql` distinct` : void 0;
    const selection = this.buildSelection(fieldsList, { isSingleTable });
    const tableSql = this.buildFromTable(table);
    const joinsSql = this.buildJoins(joins);
    const whereSql = where ? sql` where ${where}` : void 0;
    const havingSql = having ? sql` having ${having}` : void 0;
    const groupByList = [];
    if (groupBy)
      for (const [index, groupByValue] of groupBy.entries()) {
        groupByList.push(groupByValue);
        if (index < groupBy.length - 1) groupByList.push(sql`, `);
      }
    const finalQuery = sql`${withSql}select${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupByList.length > 0 ? sql` group by ${sql.join(groupByList)}` : void 0}${havingSql}${this.buildOrderBy(orderBy)}${this.buildLimit(limit)}${offset ? sql` offset ${offset}` : void 0}`;
    if (setOperators.length > 0) return this.buildSetOperations(finalQuery, setOperators);
    return finalQuery;
  }
  buildSetOperations(leftSelect, setOperators) {
    const [setOperator, ...rest] = setOperators;
    if (!setOperator) throw new Error("Cannot pass undefined values to any set operator");
    if (rest.length === 0)
      return this.buildSetOperationQuery({
        leftSelect,
        setOperator,
      });
    return this.buildSetOperations(
      this.buildSetOperationQuery({
        leftSelect,
        setOperator,
      }),
      rest,
    );
  }
  buildSetOperationQuery({
    leftSelect,
    setOperator: { type, isAll, rightSelect, limit, orderBy, offset },
  }) {
    const leftChunk = sql`${leftSelect.getSQL()} `;
    const rightChunk = sql`${rightSelect.getSQL()}`;
    let orderBySql;
    if (orderBy && orderBy.length > 0) {
      const orderByValues = [];
      for (const singleOrderBy of orderBy)
        if (is(singleOrderBy, SQLiteColumn)) orderByValues.push(sql.identifier(singleOrderBy.name));
        else if (is(singleOrderBy, SQL)) {
          for (let i = 0; i < singleOrderBy.queryChunks.length; i++) {
            const chunk = singleOrderBy.queryChunks[i];
            if (is(chunk, SQLiteColumn))
              singleOrderBy.queryChunks[i] = sql.identifier(this.casing.getColumnCasing(chunk));
          }
          orderByValues.push(sql`${singleOrderBy}`);
        } else orderByValues.push(sql`${singleOrderBy}`);
      orderBySql = sql` order by ${sql.join(orderByValues, sql`, `)}`;
    }
    const limitSql =
      typeof limit === "object" || (typeof limit === "number" && limit >= 0)
        ? sql` limit ${limit}`
        : void 0;
    const operatorChunk = sql.raw(`${type} ${isAll ? "all " : ""}`);
    const offsetSql = offset ? sql` offset ${offset}` : void 0;
    return sql`${leftChunk}${operatorChunk}${rightChunk}${orderBySql}${limitSql}${offsetSql}`;
  }
  buildInsertQuery({ table, values: valuesOrSelect, onConflict, returning, withList, select }) {
    const valuesSqlList = [];
    const columns = table[Table.Symbol.Columns];
    const colEntries = Object.entries(columns).filter(([_, col]) => !col.shouldDisableInsert());
    const insertOrder = colEntries.map(([, column]) =>
      sql.identifier(this.casing.getColumnCasing(column)),
    );
    if (select) {
      const select2 = valuesOrSelect;
      if (is(select2, SQL)) valuesSqlList.push(select2);
      else valuesSqlList.push(select2.getSQL());
    } else {
      const values = valuesOrSelect;
      valuesSqlList.push(sql.raw("values "));
      for (const [valueIndex, value] of values.entries()) {
        const valueList = [];
        for (const [fieldName, col] of colEntries) {
          const colValue = value[fieldName];
          if (colValue === void 0 || (is(colValue, Param) && colValue.value === void 0)) {
            let defaultValue;
            if (col.default !== null && col.default !== void 0)
              defaultValue = is(col.default, SQL) ? col.default : sql.param(col.default, col);
            else if (col.defaultFn !== void 0) {
              const defaultFnResult = col.defaultFn();
              defaultValue = is(defaultFnResult, SQL)
                ? defaultFnResult
                : sql.param(defaultFnResult, col);
            } else if (!col.default && col.onUpdateFn !== void 0) {
              const onUpdateFnResult = col.onUpdateFn();
              defaultValue = is(onUpdateFnResult, SQL)
                ? onUpdateFnResult
                : sql.param(onUpdateFnResult, col);
            } else defaultValue = sql`null`;
            valueList.push(defaultValue);
          } else valueList.push(colValue);
        }
        valuesSqlList.push(valueList);
        if (valueIndex < values.length - 1) valuesSqlList.push(sql`, `);
      }
    }
    const withSql = this.buildWithCTE(withList);
    const valuesSql = sql.join(valuesSqlList);
    const returningSql = returning
      ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}`
      : void 0;
    return sql`${withSql}insert into ${table} ${insertOrder} ${valuesSql}${onConflict?.length ? sql.join(onConflict) : void 0}${returningSql}`;
  }
  sqlToQuery(sql2, invokeSource) {
    return sql2.toQuery({
      casing: this.casing,
      escapeName: this.escapeName,
      escapeParam: this.escapeParam,
      escapeString: this.escapeString,
      invokeSource,
    });
  }
  buildRelationalQuery({
    fullSchema,
    schema,
    tableNamesMap,
    table,
    tableConfig,
    queryConfig: config,
    tableAlias,
    nestedQueryRelation,
    joinOn,
  }) {
    let selection = [];
    let limit,
      offset,
      orderBy = [],
      where;
    const joins = [];
    if (config === true)
      selection = Object.entries(tableConfig.columns).map(([key, value]) => ({
        dbKey: value.name,
        tsKey: key,
        field: aliasedTableColumn(value, tableAlias),
        relationTableTsKey: void 0,
        isJson: false,
        selection: [],
      }));
    else {
      const aliasedColumns = Object.fromEntries(
        Object.entries(tableConfig.columns).map(([key, value]) => [
          key,
          aliasedTableColumn(value, tableAlias),
        ]),
      );
      if (config.where) {
        const whereSql =
          typeof config.where === "function"
            ? config.where(aliasedColumns, getOperators())
            : config.where;
        where = whereSql && mapColumnsInSQLToAlias(whereSql, tableAlias);
      }
      const fieldsSelection = [];
      let selectedColumns = [];
      if (config.columns) {
        let isIncludeMode = false;
        for (const [field, value] of Object.entries(config.columns)) {
          if (value === void 0) continue;
          if (field in tableConfig.columns) {
            if (!isIncludeMode && value === true) isIncludeMode = true;
            selectedColumns.push(field);
          }
        }
        if (selectedColumns.length > 0)
          selectedColumns = isIncludeMode
            ? selectedColumns.filter((c) => config.columns?.[c] === true)
            : Object.keys(tableConfig.columns).filter((key) => !selectedColumns.includes(key));
      } else selectedColumns = Object.keys(tableConfig.columns);
      for (const field of selectedColumns) {
        const column = tableConfig.columns[field];
        fieldsSelection.push({
          tsKey: field,
          value: column,
        });
      }
      let selectedRelations = [];
      if (config.with)
        selectedRelations = Object.entries(config.with)
          .filter((entry) => !!entry[1])
          .map(([tsKey, queryConfig]) => ({
            tsKey,
            queryConfig,
            relation: tableConfig.relations[tsKey],
          }));
      let extras;
      if (config.extras) {
        extras =
          typeof config.extras === "function"
            ? config.extras(aliasedColumns, { sql })
            : config.extras;
        for (const [tsKey, value] of Object.entries(extras))
          fieldsSelection.push({
            tsKey,
            value: mapColumnsInAliasedSQLToAlias(value, tableAlias),
          });
      }
      for (const { tsKey, value } of fieldsSelection)
        selection.push({
          dbKey: is(value, SQL.Aliased) ? value.fieldAlias : tableConfig.columns[tsKey].name,
          tsKey,
          field: is(value, Column) ? aliasedTableColumn(value, tableAlias) : value,
          relationTableTsKey: void 0,
          isJson: false,
          selection: [],
        });
      let orderByOrig =
        typeof config.orderBy === "function"
          ? config.orderBy(aliasedColumns, getOrderByOperators())
          : (config.orderBy ?? []);
      if (!Array.isArray(orderByOrig)) orderByOrig = [orderByOrig];
      orderBy = orderByOrig.map((orderByValue) => {
        if (is(orderByValue, Column)) return aliasedTableColumn(orderByValue, tableAlias);
        return mapColumnsInSQLToAlias(orderByValue, tableAlias);
      });
      limit = config.limit;
      offset = config.offset;
      for (const {
        tsKey: selectedRelationTsKey,
        queryConfig: selectedRelationConfigValue,
        relation,
      } of selectedRelations) {
        const normalizedRelation = normalizeRelation(schema, tableNamesMap, relation);
        const relationTableTsName = tableNamesMap[getTableUniqueName(relation.referencedTable)];
        const relationTableAlias = `${tableAlias}_${selectedRelationTsKey}`;
        const joinOn2 = and(
          ...normalizedRelation.fields.map((field2, i) =>
            eq(
              aliasedTableColumn(normalizedRelation.references[i], relationTableAlias),
              aliasedTableColumn(field2, tableAlias),
            ),
          ),
        );
        const builtRelation = this.buildRelationalQuery({
          fullSchema,
          schema,
          tableNamesMap,
          table: fullSchema[relationTableTsName],
          tableConfig: schema[relationTableTsName],
          queryConfig: is(relation, One)
            ? selectedRelationConfigValue === true
              ? { limit: 1 }
              : {
                  ...selectedRelationConfigValue,
                  limit: 1,
                }
            : selectedRelationConfigValue,
          tableAlias: relationTableAlias,
          joinOn: joinOn2,
          nestedQueryRelation: relation,
        });
        const field = sql`(${builtRelation.sql})`.as(selectedRelationTsKey);
        selection.push({
          dbKey: selectedRelationTsKey,
          tsKey: selectedRelationTsKey,
          field,
          relationTableTsKey: relationTableTsName,
          isJson: true,
          selection: builtRelation.selection,
        });
      }
    }
    if (selection.length === 0)
      throw new DrizzleError({
        message: `No fields selected for table "${tableConfig.tsName}" ("${tableAlias}"). You need to have at least one item in "columns", "with" or "extras". If you need to select all columns, omit the "columns" key or set it to undefined.`,
      });
    let result;
    where = and(joinOn, where);
    if (nestedQueryRelation) {
      let field = sql`json_array(${sql.join(
        selection.map(({ field: field2 }) =>
          is(field2, SQLiteColumn)
            ? sql.identifier(this.casing.getColumnCasing(field2))
            : is(field2, SQL.Aliased)
              ? field2.sql
              : field2,
        ),
        sql`, `,
      )})`;
      if (is(nestedQueryRelation, Many))
        field = sql`coalesce(json_group_array(${field}), json_array())`;
      const nestedSelection = [
        {
          dbKey: "data",
          tsKey: "data",
          field: field.as("data"),
          isJson: true,
          relationTableTsKey: tableConfig.tsName,
          selection,
        },
      ];
      if (limit !== void 0 || offset !== void 0 || orderBy.length > 0) {
        result = this.buildSelectQuery({
          table: aliasedTable(table, tableAlias),
          fields: {},
          fieldsFlat: [
            {
              path: [],
              field: sql.raw("*"),
            },
          ],
          where,
          limit,
          offset,
          orderBy,
          setOperators: [],
        });
        where = void 0;
        limit = void 0;
        offset = void 0;
        orderBy = void 0;
      } else result = aliasedTable(table, tableAlias);
      result = this.buildSelectQuery({
        table: is(result, SQLiteTable) ? result : new Subquery(result, {}, tableAlias),
        fields: {},
        fieldsFlat: nestedSelection.map(({ field: field2 }) => ({
          path: [],
          field: is(field2, Column) ? aliasedTableColumn(field2, tableAlias) : field2,
        })),
        joins,
        where,
        limit,
        offset,
        orderBy,
        setOperators: [],
      });
    } else
      result = this.buildSelectQuery({
        table: aliasedTable(table, tableAlias),
        fields: {},
        fieldsFlat: selection.map(({ field }) => ({
          path: [],
          field: is(field, Column) ? aliasedTableColumn(field, tableAlias) : field,
        })),
        joins,
        where,
        limit,
        offset,
        orderBy,
        setOperators: [],
      });
    return {
      tableTsKey: tableConfig.tsName,
      sql: result,
      selection,
    };
  }
};
var SQLiteSyncDialect = class extends SQLiteDialect {
  static [entityKind] = "SQLiteSyncDialect";
  migrate(migrations, session, config) {
    const migrationsTable =
      config === void 0
        ? "__drizzle_migrations"
        : typeof config === "string"
          ? "__drizzle_migrations"
          : (config.migrationsTable ?? "__drizzle_migrations");
    const migrationTableCreate = sql`
			CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			)
		`;
    session.run(migrationTableCreate);
    const lastDbMigration =
      session.values(
        sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`,
      )[0] ?? void 0;
    session.run(sql`BEGIN`);
    try {
      for (const migration of migrations)
        if (!lastDbMigration || Number(lastDbMigration[2]) < migration.folderMillis) {
          for (const stmt of migration.sql) session.run(sql.raw(stmt));
          session.run(
            sql`INSERT INTO ${sql.identifier(migrationsTable)} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`,
          );
        }
      session.run(sql`COMMIT`);
    } catch (e) {
      session.run(sql`ROLLBACK`);
      throw e;
    }
  }
};
//#endregion
//#region node_modules/drizzle-orm/query-builders/query-builder.js
var TypedQueryBuilder = class {
  static [entityKind] = "TypedQueryBuilder";
  /** @internal */
  getSelectedFields() {
    return this._.selectedFields;
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/select.js
var SQLiteSelectBuilder = class {
  static [entityKind] = "SQLiteSelectBuilder";
  fields;
  session;
  dialect;
  withList;
  distinct;
  constructor(config) {
    this.fields = config.fields;
    this.session = config.session;
    this.dialect = config.dialect;
    this.withList = config.withList;
    this.distinct = config.distinct;
  }
  from(source) {
    const isPartialSelect = !!this.fields;
    let fields;
    if (this.fields) fields = this.fields;
    else if (is(source, Subquery))
      fields = Object.fromEntries(
        Object.keys(source._.selectedFields).map((key) => [key, source[key]]),
      );
    else if (is(source, SQLiteViewBase)) fields = source[ViewBaseConfig].selectedFields;
    else if (is(source, SQL)) fields = {};
    else fields = getTableColumns(source);
    return new SQLiteSelectBase({
      table: source,
      fields,
      isPartialSelect,
      session: this.session,
      dialect: this.dialect,
      withList: this.withList,
      distinct: this.distinct,
    });
  }
};
var SQLiteSelectQueryBuilderBase = class extends TypedQueryBuilder {
  static [entityKind] = "SQLiteSelectQueryBuilder";
  _;
  /** @internal */
  config;
  joinsNotNullableMap;
  tableName;
  isPartialSelect;
  session;
  dialect;
  cacheConfig = void 0;
  usedTables = /* @__PURE__ */ new Set();
  constructor({ table, fields, isPartialSelect, session, dialect, withList, distinct }) {
    super();
    this.config = {
      withList,
      table,
      fields: { ...fields },
      distinct,
      setOperators: [],
    };
    this.isPartialSelect = isPartialSelect;
    this.session = session;
    this.dialect = dialect;
    this._ = {
      selectedFields: fields,
      config: this.config,
    };
    this.tableName = getTableLikeName(table);
    this.joinsNotNullableMap = typeof this.tableName === "string" ? { [this.tableName]: true } : {};
    for (const item of extractUsedTable(table)) this.usedTables.add(item);
  }
  /** @internal */
  getUsedTables() {
    return [...this.usedTables];
  }
  createJoin(joinType) {
    return (table, on) => {
      const baseTableName = this.tableName;
      const tableName = getTableLikeName(table);
      for (const item of extractUsedTable(table)) this.usedTables.add(item);
      if (
        typeof tableName === "string" &&
        this.config.joins?.some((join) => join.alias === tableName)
      )
        throw new Error(`Alias "${tableName}" is already used in this query`);
      if (!this.isPartialSelect) {
        if (Object.keys(this.joinsNotNullableMap).length === 1 && typeof baseTableName === "string")
          this.config.fields = { [baseTableName]: this.config.fields };
        if (typeof tableName === "string" && !is(table, SQL)) {
          const selection = is(table, Subquery)
            ? table._.selectedFields
            : is(table, View)
              ? table[ViewBaseConfig].selectedFields
              : table[Table.Symbol.Columns];
          this.config.fields[tableName] = selection;
        }
      }
      if (typeof on === "function")
        on = on(
          new Proxy(
            this.config.fields,
            new SelectionProxyHandler({
              sqlAliasedBehavior: "sql",
              sqlBehavior: "sql",
            }),
          ),
        );
      if (!this.config.joins) this.config.joins = [];
      this.config.joins.push({
        on,
        table,
        joinType,
        alias: tableName,
      });
      if (typeof tableName === "string")
        switch (joinType) {
          case "left":
            this.joinsNotNullableMap[tableName] = false;
            break;
          case "right":
            this.joinsNotNullableMap = Object.fromEntries(
              Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false]),
            );
            this.joinsNotNullableMap[tableName] = true;
            break;
          case "cross":
          case "inner":
            this.joinsNotNullableMap[tableName] = true;
            break;
          case "full":
            this.joinsNotNullableMap = Object.fromEntries(
              Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false]),
            );
            this.joinsNotNullableMap[tableName] = false;
            break;
        }
      return this;
    };
  }
  /**
   * Executes a `left join` operation by adding another table to the current query.
   *
   * Calling this method associates each row of the table with the corresponding row from the joined table, if a match is found. If no matching row exists, it sets all columns of the joined table to null.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#left-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User; pets: Pet | null; }[] = await db.select()
   *   .from(users)
   *   .leftJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number; petId: number | null; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .leftJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  leftJoin = this.createJoin("left");
  /**
   * Executes a `right join` operation by adding another table to the current query.
   *
   * Calling this method associates each row of the joined table with the corresponding row from the main table, if a match is found. If no matching row exists, it sets all columns of the main table to null.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#right-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User | null; pets: Pet; }[] = await db.select()
   *   .from(users)
   *   .rightJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number | null; petId: number; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .rightJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  rightJoin = this.createJoin("right");
  /**
   * Executes an `inner join` operation, creating a new table by combining rows from two tables that have matching values.
   *
   * Calling this method retrieves rows that have corresponding entries in both joined tables. Rows without matching entries in either table are excluded, resulting in a table that includes only matching pairs.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#inner-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User; pets: Pet; }[] = await db.select()
   *   .from(users)
   *   .innerJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number; petId: number; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .innerJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  innerJoin = this.createJoin("inner");
  /**
   * Executes a `full join` operation by combining rows from two tables into a new table.
   *
   * Calling this method retrieves all rows from both main and joined tables, merging rows with matching values and filling in `null` for non-matching columns.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#full-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User | null; pets: Pet | null; }[] = await db.select()
   *   .from(users)
   *   .fullJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number | null; petId: number | null; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .fullJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  fullJoin = this.createJoin("full");
  /**
   * Executes a `cross join` operation by combining rows from two tables into a new table.
   *
   * Calling this method retrieves all rows from both main and joined tables, merging all rows from each table.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#cross-join}
   *
   * @param table the table to join.
   *
   * @example
   *
   * ```ts
   * // Select all users, each user with every pet
   * const usersWithPets: { user: User; pets: Pet; }[] = await db.select()
   *   .from(users)
   *   .crossJoin(pets)
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number; petId: number; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .crossJoin(pets)
   * ```
   */
  crossJoin = this.createJoin("cross");
  createSetOperator(type, isAll) {
    return (rightSelection) => {
      const rightSelect =
        typeof rightSelection === "function"
          ? rightSelection(getSQLiteSetOperators())
          : rightSelection;
      if (!haveSameKeys(this.getSelectedFields(), rightSelect.getSelectedFields()))
        throw new Error(
          "Set operator error (union / intersect / except): selected fields are not the same or are in a different order",
        );
      this.config.setOperators.push({
        type,
        isAll,
        rightSelect,
      });
      return this;
    };
  }
  /**
   * Adds `union` set operator to the query.
   *
   * Calling this method will combine the result sets of the `select` statements and remove any duplicate rows that appear across them.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#union}
   *
   * @example
   *
   * ```ts
   * // Select all unique names from customers and users tables
   * await db.select({ name: users.name })
   *   .from(users)
   *   .union(
   *     db.select({ name: customers.name }).from(customers)
   *   );
   * // or
   * import { union } from 'drizzle-orm/sqlite-core'
   *
   * await union(
   *   db.select({ name: users.name }).from(users),
   *   db.select({ name: customers.name }).from(customers)
   * );
   * ```
   */
  union = this.createSetOperator("union", false);
  /**
   * Adds `union all` set operator to the query.
   *
   * Calling this method will combine the result-set of the `select` statements and keep all duplicate rows that appear across them.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#union-all}
   *
   * @example
   *
   * ```ts
   * // Select all transaction ids from both online and in-store sales
   * await db.select({ transaction: onlineSales.transactionId })
   *   .from(onlineSales)
   *   .unionAll(
   *     db.select({ transaction: inStoreSales.transactionId }).from(inStoreSales)
   *   );
   * // or
   * import { unionAll } from 'drizzle-orm/sqlite-core'
   *
   * await unionAll(
   *   db.select({ transaction: onlineSales.transactionId }).from(onlineSales),
   *   db.select({ transaction: inStoreSales.transactionId }).from(inStoreSales)
   * );
   * ```
   */
  unionAll = this.createSetOperator("union", true);
  /**
   * Adds `intersect` set operator to the query.
   *
   * Calling this method will retain only the rows that are present in both result sets and eliminate duplicates.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#intersect}
   *
   * @example
   *
   * ```ts
   * // Select course names that are offered in both departments A and B
   * await db.select({ courseName: depA.courseName })
   *   .from(depA)
   *   .intersect(
   *     db.select({ courseName: depB.courseName }).from(depB)
   *   );
   * // or
   * import { intersect } from 'drizzle-orm/sqlite-core'
   *
   * await intersect(
   *   db.select({ courseName: depA.courseName }).from(depA),
   *   db.select({ courseName: depB.courseName }).from(depB)
   * );
   * ```
   */
  intersect = this.createSetOperator("intersect", false);
  /**
   * Adds `except` set operator to the query.
   *
   * Calling this method will retrieve all unique rows from the left query, except for the rows that are present in the result set of the right query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#except}
   *
   * @example
   *
   * ```ts
   * // Select all courses offered in department A but not in department B
   * await db.select({ courseName: depA.courseName })
   *   .from(depA)
   *   .except(
   *     db.select({ courseName: depB.courseName }).from(depB)
   *   );
   * // or
   * import { except } from 'drizzle-orm/sqlite-core'
   *
   * await except(
   *   db.select({ courseName: depA.courseName }).from(depA),
   *   db.select({ courseName: depB.courseName }).from(depB)
   * );
   * ```
   */
  except = this.createSetOperator("except", false);
  /** @internal */
  addSetOperators(setOperators) {
    this.config.setOperators.push(...setOperators);
    return this;
  }
  /**
   * Adds a `where` clause to the query.
   *
   * Calling this method will select only those rows that fulfill a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#filtering}
   *
   * @param where the `where` clause.
   *
   * @example
   * You can use conditional operators and `sql function` to filter the rows to be selected.
   *
   * ```ts
   * // Select all cars with green color
   * await db.select().from(cars).where(eq(cars.color, 'green'));
   * // or
   * await db.select().from(cars).where(sql`${cars.color} = 'green'`)
   * ```
   *
   * You can logically combine conditional operators with `and()` and `or()` operators:
   *
   * ```ts
   * // Select all BMW cars with a green color
   * await db.select().from(cars).where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
   *
   * // Select all cars with the green or blue color
   * await db.select().from(cars).where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
   * ```
   */
  where(where) {
    if (typeof where === "function")
      where = where(
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({
            sqlAliasedBehavior: "sql",
            sqlBehavior: "sql",
          }),
        ),
      );
    this.config.where = where;
    return this;
  }
  /**
   * Adds a `having` clause to the query.
   *
   * Calling this method will select only those rows that fulfill a specified condition. It is typically used with aggregate functions to filter the aggregated data based on a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#aggregations}
   *
   * @param having the `having` clause.
   *
   * @example
   *
   * ```ts
   * // Select all brands with more than one car
   * await db.select({
   * 	brand: cars.brand,
   * 	count: sql<number>`cast(count(${cars.id}) as int)`,
   * })
   *   .from(cars)
   *   .groupBy(cars.brand)
   *   .having(({ count }) => gt(count, 1));
   * ```
   */
  having(having) {
    if (typeof having === "function")
      having = having(
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({
            sqlAliasedBehavior: "sql",
            sqlBehavior: "sql",
          }),
        ),
      );
    this.config.having = having;
    return this;
  }
  groupBy(...columns) {
    if (typeof columns[0] === "function") {
      const groupBy = columns[0](
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({
            sqlAliasedBehavior: "alias",
            sqlBehavior: "sql",
          }),
        ),
      );
      this.config.groupBy = Array.isArray(groupBy) ? groupBy : [groupBy];
    } else this.config.groupBy = columns;
    return this;
  }
  orderBy(...columns) {
    if (typeof columns[0] === "function") {
      const orderBy = columns[0](
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({
            sqlAliasedBehavior: "alias",
            sqlBehavior: "sql",
          }),
        ),
      );
      const orderByArray = Array.isArray(orderBy) ? orderBy : [orderBy];
      if (this.config.setOperators.length > 0)
        this.config.setOperators.at(-1).orderBy = orderByArray;
      else this.config.orderBy = orderByArray;
    } else {
      const orderByArray = columns;
      if (this.config.setOperators.length > 0)
        this.config.setOperators.at(-1).orderBy = orderByArray;
      else this.config.orderBy = orderByArray;
    }
    return this;
  }
  /**
   * Adds a `limit` clause to the query.
   *
   * Calling this method will set the maximum number of rows that will be returned by this query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#limit--offset}
   *
   * @param limit the `limit` clause.
   *
   * @example
   *
   * ```ts
   * // Get the first 10 people from this query.
   * await db.select().from(people).limit(10);
   * ```
   */
  limit(limit) {
    if (this.config.setOperators.length > 0) this.config.setOperators.at(-1).limit = limit;
    else this.config.limit = limit;
    return this;
  }
  /**
   * Adds an `offset` clause to the query.
   *
   * Calling this method will skip a number of rows when returning results from this query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#limit--offset}
   *
   * @param offset the `offset` clause.
   *
   * @example
   *
   * ```ts
   * // Get the 10th-20th people from this query.
   * await db.select().from(people).offset(10).limit(10);
   * ```
   */
  offset(offset) {
    if (this.config.setOperators.length > 0) this.config.setOperators.at(-1).offset = offset;
    else this.config.offset = offset;
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildSelectQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  as(alias) {
    const usedTables = [];
    usedTables.push(...extractUsedTable(this.config.table));
    if (this.config.joins)
      for (const it of this.config.joins) usedTables.push(...extractUsedTable(it.table));
    return new Proxy(
      new Subquery(this.getSQL(), this.config.fields, alias, false, [...new Set(usedTables)]),
      new SelectionProxyHandler({
        alias,
        sqlAliasedBehavior: "alias",
        sqlBehavior: "error",
      }),
    );
  }
  /** @internal */
  getSelectedFields() {
    return new Proxy(
      this.config.fields,
      new SelectionProxyHandler({
        alias: this.tableName,
        sqlAliasedBehavior: "alias",
        sqlBehavior: "error",
      }),
    );
  }
  $dynamic() {
    return this;
  }
};
var SQLiteSelectBase = class extends SQLiteSelectQueryBuilderBase {
  static [entityKind] = "SQLiteSelect";
  /** @internal */
  _prepare(isOneTimeQuery = true) {
    if (!this.session)
      throw new Error(
        "Cannot execute a query on a query builder. Please use a database instance instead.",
      );
    const fieldsList = orderSelectedFields(this.config.fields);
    const query = this.session[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.dialect.sqlToQuery(this.getSQL()),
      fieldsList,
      "all",
      true,
      void 0,
      {
        type: "select",
        tables: [...this.usedTables],
      },
      this.cacheConfig,
    );
    query.joinsNotNullableMap = this.joinsNotNullableMap;
    return query;
  }
  $withCache(config) {
    this.cacheConfig =
      config === void 0
        ? {
            config: {},
            enable: true,
            autoInvalidate: true,
          }
        : config === false
          ? { enable: false }
          : {
              enable: true,
              autoInvalidate: true,
              ...config,
            };
    return this;
  }
  prepare() {
    return this._prepare(false);
  }
  run = (placeholderValues) => {
    return this._prepare().run(placeholderValues);
  };
  all = (placeholderValues) => {
    return this._prepare().all(placeholderValues);
  };
  get = (placeholderValues) => {
    return this._prepare().get(placeholderValues);
  };
  values = (placeholderValues) => {
    return this._prepare().values(placeholderValues);
  };
  async execute() {
    return this.all();
  }
};
applyMixins(SQLiteSelectBase, [QueryPromise]);
function createSetOperator(type, isAll) {
  return (leftSelect, rightSelect, ...restSelects) => {
    const setOperators = [rightSelect, ...restSelects].map((select) => ({
      type,
      isAll,
      rightSelect: select,
    }));
    for (const setOperator of setOperators)
      if (
        !haveSameKeys(leftSelect.getSelectedFields(), setOperator.rightSelect.getSelectedFields())
      )
        throw new Error(
          "Set operator error (union / intersect / except): selected fields are not the same or are in a different order",
        );
    return leftSelect.addSetOperators(setOperators);
  };
}
var getSQLiteSetOperators = () => ({
  union,
  unionAll,
  intersect,
  except,
});
var union = createSetOperator("union", false);
var unionAll = createSetOperator("union", true);
var intersect = createSetOperator("intersect", false);
var except = createSetOperator("except", false);
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/query-builder.js
var QueryBuilder = class {
  static [entityKind] = "SQLiteQueryBuilder";
  dialect;
  dialectConfig;
  constructor(dialect) {
    this.dialect = is(dialect, SQLiteDialect) ? dialect : void 0;
    this.dialectConfig = is(dialect, SQLiteDialect) ? void 0 : dialect;
  }
  $with = (alias, selection) => {
    const queryBuilder = this;
    const as = (qb) => {
      if (typeof qb === "function") qb = qb(queryBuilder);
      return new Proxy(
        new WithSubquery(
          qb.getSQL(),
          selection ?? ("getSelectedFields" in qb ? (qb.getSelectedFields() ?? {}) : {}),
          alias,
          true,
        ),
        new SelectionProxyHandler({
          alias,
          sqlAliasedBehavior: "alias",
          sqlBehavior: "error",
        }),
      );
    };
    return { as };
  };
  with(...queries) {
    const self = this;
    function select(fields) {
      return new SQLiteSelectBuilder({
        fields: fields ?? void 0,
        session: void 0,
        dialect: self.getDialect(),
        withList: queries,
      });
    }
    function selectDistinct(fields) {
      return new SQLiteSelectBuilder({
        fields: fields ?? void 0,
        session: void 0,
        dialect: self.getDialect(),
        withList: queries,
        distinct: true,
      });
    }
    return {
      select,
      selectDistinct,
    };
  }
  select(fields) {
    return new SQLiteSelectBuilder({
      fields: fields ?? void 0,
      session: void 0,
      dialect: this.getDialect(),
    });
  }
  selectDistinct(fields) {
    return new SQLiteSelectBuilder({
      fields: fields ?? void 0,
      session: void 0,
      dialect: this.getDialect(),
      distinct: true,
    });
  }
  getDialect() {
    if (!this.dialect) this.dialect = new SQLiteSyncDialect(this.dialectConfig);
    return this.dialect;
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/insert.js
var SQLiteInsertBuilder = class {
  constructor(table, session, dialect, withList) {
    this.table = table;
    this.session = session;
    this.dialect = dialect;
    this.withList = withList;
  }
  static [entityKind] = "SQLiteInsertBuilder";
  values(values) {
    values = Array.isArray(values) ? values : [values];
    if (values.length === 0) throw new Error("values() must be called with at least one value");
    const mappedValues = values.map((entry) => {
      const result = {};
      const cols = this.table[Table.Symbol.Columns];
      for (const colKey of Object.keys(entry)) {
        const colValue = entry[colKey];
        result[colKey] = is(colValue, SQL) ? colValue : new Param(colValue, cols[colKey]);
      }
      return result;
    });
    return new SQLiteInsertBase(
      this.table,
      mappedValues,
      this.session,
      this.dialect,
      this.withList,
    );
  }
  select(selectQuery) {
    const select =
      typeof selectQuery === "function" ? selectQuery(new QueryBuilder()) : selectQuery;
    if (!is(select, SQL) && !haveSameKeys(this.table[Columns], select._.selectedFields))
      throw new Error(
        "Insert select error: selected fields are not the same or are in a different order compared to the table definition",
      );
    return new SQLiteInsertBase(
      this.table,
      select,
      this.session,
      this.dialect,
      this.withList,
      true,
    );
  }
};
var SQLiteInsertBase = class extends QueryPromise {
  constructor(table, values, session, dialect, withList, select) {
    super();
    this.session = session;
    this.dialect = dialect;
    this.config = {
      table,
      values,
      withList,
      select,
    };
  }
  static [entityKind] = "SQLiteInsert";
  /** @internal */
  config;
  returning(fields = this.config.table[SQLiteTable.Symbol.Columns]) {
    this.config.returning = orderSelectedFields(fields);
    return this;
  }
  /**
   * Adds an `on conflict do nothing` clause to the query.
   *
   * Calling this method simply avoids inserting a row as its alternative action.
   *
   * See docs: {@link https://orm.drizzle.team/docs/insert#on-conflict-do-nothing}
   *
   * @param config The `target` and `where` clauses.
   *
   * @example
   * ```ts
   * // Insert one row and cancel the insert if there's a conflict
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoNothing();
   *
   * // Explicitly specify conflict target
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoNothing({ target: cars.id });
   * ```
   */
  onConflictDoNothing(config = {}) {
    if (!this.config.onConflict) this.config.onConflict = [];
    if (config.target === void 0) this.config.onConflict.push(sql` on conflict do nothing`);
    else {
      const targetSql = Array.isArray(config.target)
        ? sql`${config.target}`
        : sql`${[config.target]}`;
      const whereSql = config.where ? sql` where ${config.where}` : sql``;
      this.config.onConflict.push(sql` on conflict ${targetSql} do nothing${whereSql}`);
    }
    return this;
  }
  /**
   * Adds an `on conflict do update` clause to the query.
   *
   * Calling this method will update the existing row that conflicts with the row proposed for insertion as its alternative action.
   *
   * See docs: {@link https://orm.drizzle.team/docs/insert#upserts-and-conflicts}
   *
   * @param config The `target`, `set` and `where` clauses.
   *
   * @example
   * ```ts
   * // Update the row if there's a conflict
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoUpdate({
   *     target: cars.id,
   *     set: { brand: 'Porsche' }
   *   });
   *
   * // Upsert with 'where' clause
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoUpdate({
   *     target: cars.id,
   *     set: { brand: 'newBMW' },
   *     where: sql`${cars.createdAt} > '2023-01-01'::date`,
   *   });
   * ```
   */
  onConflictDoUpdate(config) {
    if (config.where && (config.targetWhere || config.setWhere))
      throw new Error(
        'You cannot use both "where" and "targetWhere"/"setWhere" at the same time - "where" is deprecated, use "targetWhere" or "setWhere" instead.',
      );
    if (!this.config.onConflict) this.config.onConflict = [];
    const whereSql = config.where ? sql` where ${config.where}` : void 0;
    const targetWhereSql = config.targetWhere ? sql` where ${config.targetWhere}` : void 0;
    const setWhereSql = config.setWhere ? sql` where ${config.setWhere}` : void 0;
    const targetSql = Array.isArray(config.target)
      ? sql`${config.target}`
      : sql`${[config.target]}`;
    const setSql = this.dialect.buildUpdateSet(
      this.config.table,
      mapUpdateSet(this.config.table, config.set),
    );
    this.config.onConflict.push(
      sql` on conflict ${targetSql}${targetWhereSql} do update set ${setSql}${whereSql}${setWhereSql}`,
    );
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildInsertQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  /** @internal */
  _prepare(isOneTimeQuery = true) {
    return this.session[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.dialect.sqlToQuery(this.getSQL()),
      this.config.returning,
      this.config.returning ? "all" : "run",
      true,
      void 0,
      {
        type: "insert",
        tables: extractUsedTable(this.config.table),
      },
    );
  }
  prepare() {
    return this._prepare(false);
  }
  run = (placeholderValues) => {
    return this._prepare().run(placeholderValues);
  };
  all = (placeholderValues) => {
    return this._prepare().all(placeholderValues);
  };
  get = (placeholderValues) => {
    return this._prepare().get(placeholderValues);
  };
  values = (placeholderValues) => {
    return this._prepare().values(placeholderValues);
  };
  async execute() {
    return this.config.returning ? this.all() : this.run();
  }
  $dynamic() {
    return this;
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/update.js
var SQLiteUpdateBuilder = class {
  constructor(table, session, dialect, withList) {
    this.table = table;
    this.session = session;
    this.dialect = dialect;
    this.withList = withList;
  }
  static [entityKind] = "SQLiteUpdateBuilder";
  set(values) {
    return new SQLiteUpdateBase(
      this.table,
      mapUpdateSet(this.table, values),
      this.session,
      this.dialect,
      this.withList,
    );
  }
};
var SQLiteUpdateBase = class extends QueryPromise {
  constructor(table, set, session, dialect, withList) {
    super();
    this.session = session;
    this.dialect = dialect;
    this.config = {
      set,
      table,
      withList,
      joins: [],
    };
  }
  static [entityKind] = "SQLiteUpdate";
  /** @internal */
  config;
  from(source) {
    this.config.from = source;
    return this;
  }
  createJoin(joinType) {
    return (table, on) => {
      const tableName = getTableLikeName(table);
      if (
        typeof tableName === "string" &&
        this.config.joins.some((join) => join.alias === tableName)
      )
        throw new Error(`Alias "${tableName}" is already used in this query`);
      if (typeof on === "function") {
        const from = this.config.from
          ? is(table, SQLiteTable)
            ? table[Table.Symbol.Columns]
            : is(table, Subquery)
              ? table._.selectedFields
              : is(table, SQLiteViewBase)
                ? table[ViewBaseConfig].selectedFields
                : void 0
          : void 0;
        on = on(
          new Proxy(
            this.config.table[Table.Symbol.Columns],
            new SelectionProxyHandler({
              sqlAliasedBehavior: "sql",
              sqlBehavior: "sql",
            }),
          ),
          from &&
            new Proxy(
              from,
              new SelectionProxyHandler({
                sqlAliasedBehavior: "sql",
                sqlBehavior: "sql",
              }),
            ),
        );
      }
      this.config.joins.push({
        on,
        table,
        joinType,
        alias: tableName,
      });
      return this;
    };
  }
  leftJoin = this.createJoin("left");
  rightJoin = this.createJoin("right");
  innerJoin = this.createJoin("inner");
  fullJoin = this.createJoin("full");
  /**
   * Adds a 'where' clause to the query.
   *
   * Calling this method will update only those rows that fulfill a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/update}
   *
   * @param where the 'where' clause.
   *
   * @example
   * You can use conditional operators and `sql function` to filter the rows to be updated.
   *
   * ```ts
   * // Update all cars with green color
   * db.update(cars).set({ color: 'red' })
   *   .where(eq(cars.color, 'green'));
   * // or
   * db.update(cars).set({ color: 'red' })
   *   .where(sql`${cars.color} = 'green'`)
   * ```
   *
   * You can logically combine conditional operators with `and()` and `or()` operators:
   *
   * ```ts
   * // Update all BMW cars with a green color
   * db.update(cars).set({ color: 'red' })
   *   .where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
   *
   * // Update all cars with the green or blue color
   * db.update(cars).set({ color: 'red' })
   *   .where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
   * ```
   */
  where(where) {
    this.config.where = where;
    return this;
  }
  orderBy(...columns) {
    if (typeof columns[0] === "function") {
      const orderBy = columns[0](
        new Proxy(
          this.config.table[Table.Symbol.Columns],
          new SelectionProxyHandler({
            sqlAliasedBehavior: "alias",
            sqlBehavior: "sql",
          }),
        ),
      );
      const orderByArray = Array.isArray(orderBy) ? orderBy : [orderBy];
      this.config.orderBy = orderByArray;
    } else {
      const orderByArray = columns;
      this.config.orderBy = orderByArray;
    }
    return this;
  }
  limit(limit) {
    this.config.limit = limit;
    return this;
  }
  returning(fields = this.config.table[SQLiteTable.Symbol.Columns]) {
    this.config.returning = orderSelectedFields(fields);
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildUpdateQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  /** @internal */
  _prepare(isOneTimeQuery = true) {
    return this.session[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.dialect.sqlToQuery(this.getSQL()),
      this.config.returning,
      this.config.returning ? "all" : "run",
      true,
      void 0,
      {
        type: "insert",
        tables: extractUsedTable(this.config.table),
      },
    );
  }
  prepare() {
    return this._prepare(false);
  }
  run = (placeholderValues) => {
    return this._prepare().run(placeholderValues);
  };
  all = (placeholderValues) => {
    return this._prepare().all(placeholderValues);
  };
  get = (placeholderValues) => {
    return this._prepare().get(placeholderValues);
  };
  values = (placeholderValues) => {
    return this._prepare().values(placeholderValues);
  };
  async execute() {
    return this.config.returning ? this.all() : this.run();
  }
  $dynamic() {
    return this;
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/count.js
var SQLiteCountBuilder = class SQLiteCountBuilder extends SQL {
  constructor(params) {
    super(SQLiteCountBuilder.buildEmbeddedCount(params.source, params.filters).queryChunks);
    this.params = params;
    this.session = params.session;
    this.sql = SQLiteCountBuilder.buildCount(params.source, params.filters);
  }
  sql;
  static [entityKind] = "SQLiteCountBuilderAsync";
  [Symbol.toStringTag] = "SQLiteCountBuilderAsync";
  session;
  static buildEmbeddedCount(source, filters) {
    return sql`(select count(*) from ${source}${sql.raw(" where ").if(filters)}${filters})`;
  }
  static buildCount(source, filters) {
    return sql`select count(*) from ${source}${sql.raw(" where ").if(filters)}${filters}`;
  }
  then(onfulfilled, onrejected) {
    return Promise.resolve(this.session.count(this.sql)).then(onfulfilled, onrejected);
  }
  catch(onRejected) {
    return this.then(void 0, onRejected);
  }
  finally(onFinally) {
    return this.then(
      (value) => {
        onFinally?.();
        return value;
      },
      (reason) => {
        onFinally?.();
        throw reason;
      },
    );
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/query.js
var RelationalQueryBuilder = class {
  constructor(mode, fullSchema, schema, tableNamesMap, table, tableConfig, dialect, session) {
    this.mode = mode;
    this.fullSchema = fullSchema;
    this.schema = schema;
    this.tableNamesMap = tableNamesMap;
    this.table = table;
    this.tableConfig = tableConfig;
    this.dialect = dialect;
    this.session = session;
  }
  static [entityKind] = "SQLiteAsyncRelationalQueryBuilder";
  findMany(config) {
    return this.mode === "sync"
      ? new SQLiteSyncRelationalQuery(
          this.fullSchema,
          this.schema,
          this.tableNamesMap,
          this.table,
          this.tableConfig,
          this.dialect,
          this.session,
          config ? config : {},
          "many",
        )
      : new SQLiteRelationalQuery(
          this.fullSchema,
          this.schema,
          this.tableNamesMap,
          this.table,
          this.tableConfig,
          this.dialect,
          this.session,
          config ? config : {},
          "many",
        );
  }
  findFirst(config) {
    return this.mode === "sync"
      ? new SQLiteSyncRelationalQuery(
          this.fullSchema,
          this.schema,
          this.tableNamesMap,
          this.table,
          this.tableConfig,
          this.dialect,
          this.session,
          config
            ? {
                ...config,
                limit: 1,
              }
            : { limit: 1 },
          "first",
        )
      : new SQLiteRelationalQuery(
          this.fullSchema,
          this.schema,
          this.tableNamesMap,
          this.table,
          this.tableConfig,
          this.dialect,
          this.session,
          config
            ? {
                ...config,
                limit: 1,
              }
            : { limit: 1 },
          "first",
        );
  }
};
var SQLiteRelationalQuery = class extends QueryPromise {
  constructor(
    fullSchema,
    schema,
    tableNamesMap,
    table,
    tableConfig,
    dialect,
    session,
    config,
    mode,
  ) {
    super();
    this.fullSchema = fullSchema;
    this.schema = schema;
    this.tableNamesMap = tableNamesMap;
    this.table = table;
    this.tableConfig = tableConfig;
    this.dialect = dialect;
    this.session = session;
    this.config = config;
    this.mode = mode;
  }
  static [entityKind] = "SQLiteAsyncRelationalQuery";
  /** @internal */
  mode;
  /** @internal */
  getSQL() {
    return this.dialect.buildRelationalQuery({
      fullSchema: this.fullSchema,
      schema: this.schema,
      tableNamesMap: this.tableNamesMap,
      table: this.table,
      tableConfig: this.tableConfig,
      queryConfig: this.config,
      tableAlias: this.tableConfig.tsName,
    }).sql;
  }
  /** @internal */
  _prepare(isOneTimeQuery = false) {
    const { query, builtQuery } = this._toSQL();
    return this.session[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      builtQuery,
      void 0,
      this.mode === "first" ? "get" : "all",
      true,
      (rawRows, mapColumnValue) => {
        const rows = rawRows.map((row) =>
          mapRelationalRow(this.schema, this.tableConfig, row, query.selection, mapColumnValue),
        );
        if (this.mode === "first") return rows[0];
        return rows;
      },
    );
  }
  prepare() {
    return this._prepare(false);
  }
  _toSQL() {
    const query = this.dialect.buildRelationalQuery({
      fullSchema: this.fullSchema,
      schema: this.schema,
      tableNamesMap: this.tableNamesMap,
      table: this.table,
      tableConfig: this.tableConfig,
      queryConfig: this.config,
      tableAlias: this.tableConfig.tsName,
    });
    return {
      query,
      builtQuery: this.dialect.sqlToQuery(query.sql),
    };
  }
  toSQL() {
    return this._toSQL().builtQuery;
  }
  /** @internal */
  executeRaw() {
    if (this.mode === "first") return this._prepare(false).get();
    return this._prepare(false).all();
  }
  async execute() {
    return this.executeRaw();
  }
};
var SQLiteSyncRelationalQuery = class extends SQLiteRelationalQuery {
  static [entityKind] = "SQLiteSyncRelationalQuery";
  sync() {
    return this.executeRaw();
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/query-builders/raw.js
var SQLiteRaw = class extends QueryPromise {
  constructor(execute, getSQL, action, dialect, mapBatchResult) {
    super();
    this.execute = execute;
    this.getSQL = getSQL;
    this.dialect = dialect;
    this.mapBatchResult = mapBatchResult;
    this.config = { action };
  }
  static [entityKind] = "SQLiteRaw";
  /** @internal */
  config;
  getQuery() {
    return {
      ...this.dialect.sqlToQuery(this.getSQL()),
      method: this.config.action,
    };
  }
  mapResult(result, isFromBatch) {
    return isFromBatch ? this.mapBatchResult(result) : result;
  }
  _prepare() {
    return this;
  }
  /** @internal */
  isResponseInArrayMode() {
    return false;
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/db.js
var BaseSQLiteDatabase = class {
  constructor(resultKind, dialect, session, schema) {
    this.resultKind = resultKind;
    this.dialect = dialect;
    this.session = session;
    this._ = schema
      ? {
          schema: schema.schema,
          fullSchema: schema.fullSchema,
          tableNamesMap: schema.tableNamesMap,
        }
      : {
          schema: void 0,
          fullSchema: {},
          tableNamesMap: {},
        };
    this.query = {};
    const query = this.query;
    if (this._.schema)
      for (const [tableName, columns] of Object.entries(this._.schema))
        query[tableName] = new RelationalQueryBuilder(
          resultKind,
          schema.fullSchema,
          this._.schema,
          this._.tableNamesMap,
          schema.fullSchema[tableName],
          columns,
          dialect,
          session,
        );
    this.$cache = { invalidate: async (_params) => {} };
  }
  static [entityKind] = "BaseSQLiteDatabase";
  query;
  /**
   * Creates a subquery that defines a temporary named result set as a CTE.
   *
   * It is useful for breaking down complex queries into simpler parts and for reusing the result set in subsequent parts of the query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#with-clause}
   *
   * @param alias The alias for the subquery.
   *
   * Failure to provide an alias will result in a DrizzleTypeError, preventing the subquery from being referenced in other queries.
   *
   * @example
   *
   * ```ts
   * // Create a subquery with alias 'sq' and use it in the select query
   * const sq = db.$with('sq').as(db.select().from(users).where(eq(users.id, 42)));
   *
   * const result = await db.with(sq).select().from(sq);
   * ```
   *
   * To select arbitrary SQL values as fields in a CTE and reference them in other CTEs or in the main query, you need to add aliases to them:
   *
   * ```ts
   * // Select an arbitrary SQL value as a field in a CTE and reference it in the main query
   * const sq = db.$with('sq').as(db.select({
   *   name: sql<string>`upper(${users.name})`.as('name'),
   * })
   * .from(users));
   *
   * const result = await db.with(sq).select({ name: sq.name }).from(sq);
   * ```
   */
  $with = (alias, selection) => {
    const self = this;
    const as = (qb) => {
      if (typeof qb === "function") qb = qb(new QueryBuilder(self.dialect));
      return new Proxy(
        new WithSubquery(
          qb.getSQL(),
          selection ?? ("getSelectedFields" in qb ? (qb.getSelectedFields() ?? {}) : {}),
          alias,
          true,
        ),
        new SelectionProxyHandler({
          alias,
          sqlAliasedBehavior: "alias",
          sqlBehavior: "error",
        }),
      );
    };
    return { as };
  };
  $count(source, filters) {
    return new SQLiteCountBuilder({
      source,
      filters,
      session: this.session,
    });
  }
  /**
   * Incorporates a previously defined CTE (using `$with`) into the main query.
   *
   * This method allows the main query to reference a temporary named result set.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#with-clause}
   *
   * @param queries The CTEs to incorporate into the main query.
   *
   * @example
   *
   * ```ts
   * // Define a subquery 'sq' as a CTE using $with
   * const sq = db.$with('sq').as(db.select().from(users).where(eq(users.id, 42)));
   *
   * // Incorporate the CTE 'sq' into the main query and select from it
   * const result = await db.with(sq).select().from(sq);
   * ```
   */
  with(...queries) {
    const self = this;
    function select(fields) {
      return new SQLiteSelectBuilder({
        fields: fields ?? void 0,
        session: self.session,
        dialect: self.dialect,
        withList: queries,
      });
    }
    function selectDistinct(fields) {
      return new SQLiteSelectBuilder({
        fields: fields ?? void 0,
        session: self.session,
        dialect: self.dialect,
        withList: queries,
        distinct: true,
      });
    }
    function update(table) {
      return new SQLiteUpdateBuilder(table, self.session, self.dialect, queries);
    }
    function insert(into) {
      return new SQLiteInsertBuilder(into, self.session, self.dialect, queries);
    }
    function delete_(from) {
      return new SQLiteDeleteBase(from, self.session, self.dialect, queries);
    }
    return {
      select,
      selectDistinct,
      update,
      insert,
      delete: delete_,
    };
  }
  select(fields) {
    return new SQLiteSelectBuilder({
      fields: fields ?? void 0,
      session: this.session,
      dialect: this.dialect,
    });
  }
  selectDistinct(fields) {
    return new SQLiteSelectBuilder({
      fields: fields ?? void 0,
      session: this.session,
      dialect: this.dialect,
      distinct: true,
    });
  }
  /**
   * Creates an update query.
   *
   * Calling this method without `.where()` clause will update all rows in a table. The `.where()` clause specifies which rows should be updated.
   *
   * Use `.set()` method to specify which values to update.
   *
   * See docs: {@link https://orm.drizzle.team/docs/update}
   *
   * @param table The table to update.
   *
   * @example
   *
   * ```ts
   * // Update all rows in the 'cars' table
   * await db.update(cars).set({ color: 'red' });
   *
   * // Update rows with filters and conditions
   * await db.update(cars).set({ color: 'red' }).where(eq(cars.brand, 'BMW'));
   *
   * // Update with returning clause
   * const updatedCar: Car[] = await db.update(cars)
   *   .set({ color: 'red' })
   *   .where(eq(cars.id, 1))
   *   .returning();
   * ```
   */
  update(table) {
    return new SQLiteUpdateBuilder(table, this.session, this.dialect);
  }
  $cache;
  /**
   * Creates an insert query.
   *
   * Calling this method will create new rows in a table. Use `.values()` method to specify which values to insert.
   *
   * See docs: {@link https://orm.drizzle.team/docs/insert}
   *
   * @param table The table to insert into.
   *
   * @example
   *
   * ```ts
   * // Insert one row
   * await db.insert(cars).values({ brand: 'BMW' });
   *
   * // Insert multiple rows
   * await db.insert(cars).values([{ brand: 'BMW' }, { brand: 'Porsche' }]);
   *
   * // Insert with returning clause
   * const insertedCar: Car[] = await db.insert(cars)
   *   .values({ brand: 'BMW' })
   *   .returning();
   * ```
   */
  insert(into) {
    return new SQLiteInsertBuilder(into, this.session, this.dialect);
  }
  /**
   * Creates a delete query.
   *
   * Calling this method without `.where()` clause will delete all rows in a table. The `.where()` clause specifies which rows should be deleted.
   *
   * See docs: {@link https://orm.drizzle.team/docs/delete}
   *
   * @param table The table to delete from.
   *
   * @example
   *
   * ```ts
   * // Delete all rows in the 'cars' table
   * await db.delete(cars);
   *
   * // Delete rows with filters and conditions
   * await db.delete(cars).where(eq(cars.color, 'green'));
   *
   * // Delete with returning clause
   * const deletedCar: Car[] = await db.delete(cars)
   *   .where(eq(cars.id, 1))
   *   .returning();
   * ```
   */
  delete(from) {
    return new SQLiteDeleteBase(from, this.session, this.dialect);
  }
  run(query) {
    const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL();
    if (this.resultKind === "async")
      return new SQLiteRaw(
        async () => this.session.run(sequel),
        () => sequel,
        "run",
        this.dialect,
        this.session.extractRawRunValueFromBatchResult.bind(this.session),
      );
    return this.session.run(sequel);
  }
  all(query) {
    const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL();
    if (this.resultKind === "async")
      return new SQLiteRaw(
        async () => this.session.all(sequel),
        () => sequel,
        "all",
        this.dialect,
        this.session.extractRawAllValueFromBatchResult.bind(this.session),
      );
    return this.session.all(sequel);
  }
  get(query) {
    const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL();
    if (this.resultKind === "async")
      return new SQLiteRaw(
        async () => this.session.get(sequel),
        () => sequel,
        "get",
        this.dialect,
        this.session.extractRawGetValueFromBatchResult.bind(this.session),
      );
    return this.session.get(sequel);
  }
  values(query) {
    const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL();
    if (this.resultKind === "async")
      return new SQLiteRaw(
        async () => this.session.values(sequel),
        () => sequel,
        "values",
        this.dialect,
        this.session.extractRawValuesValueFromBatchResult.bind(this.session),
      );
    return this.session.values(sequel);
  }
  transaction(transaction, config) {
    return this.session.transaction(transaction, config);
  }
};
//#endregion
//#region node_modules/drizzle-orm/cache/core/cache.js
var Cache = class {
  static [entityKind] = "Cache";
};
var NoopCache = class extends Cache {
  strategy() {
    return "all";
  }
  static [entityKind] = "NoopCache";
  async get(_key) {}
  async put(_hashedQuery, _response, _tables, _config) {}
  async onMutate(_params) {}
};
async function hashQuery(sql, params) {
  const dataToHash = `${sql}-${JSON.stringify(params)}`;
  const data = new TextEncoder().encode(dataToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/session.js
var ExecuteResultSync = class extends QueryPromise {
  constructor(resultCb) {
    super();
    this.resultCb = resultCb;
  }
  static [entityKind] = "ExecuteResultSync";
  async execute() {
    return this.resultCb();
  }
  sync() {
    return this.resultCb();
  }
};
var SQLitePreparedQuery = class {
  constructor(mode, executeMethod, query, cache, queryMetadata, cacheConfig) {
    this.mode = mode;
    this.executeMethod = executeMethod;
    this.query = query;
    this.cache = cache;
    this.queryMetadata = queryMetadata;
    this.cacheConfig = cacheConfig;
    if (cache && cache.strategy() === "all" && cacheConfig === void 0)
      this.cacheConfig = {
        enable: true,
        autoInvalidate: true,
      };
    if (!this.cacheConfig?.enable) this.cacheConfig = void 0;
  }
  static [entityKind] = "PreparedQuery";
  /** @internal */
  joinsNotNullableMap;
  /** @internal */
  async queryWithCache(queryString, params, query) {
    if (this.cache === void 0 || is(this.cache, NoopCache) || this.queryMetadata === void 0)
      try {
        return await query();
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    if (this.cacheConfig && !this.cacheConfig.enable)
      try {
        return await query();
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    if (
      (this.queryMetadata.type === "insert" ||
        this.queryMetadata.type === "update" ||
        this.queryMetadata.type === "delete") &&
      this.queryMetadata.tables.length > 0
    )
      try {
        const [res] = await Promise.all([
          query(),
          this.cache.onMutate({ tables: this.queryMetadata.tables }),
        ]);
        return res;
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    if (!this.cacheConfig)
      try {
        return await query();
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    if (this.queryMetadata.type === "select") {
      const fromCache = await this.cache.get(
        this.cacheConfig.tag ?? (await hashQuery(queryString, params)),
        this.queryMetadata.tables,
        this.cacheConfig.tag !== void 0,
        this.cacheConfig.autoInvalidate,
      );
      if (fromCache === void 0) {
        let result;
        try {
          result = await query();
        } catch (e) {
          throw new DrizzleQueryError(queryString, params, e);
        }
        await this.cache.put(
          this.cacheConfig.tag ?? (await hashQuery(queryString, params)),
          result,
          this.cacheConfig.autoInvalidate ? this.queryMetadata.tables : [],
          this.cacheConfig.tag !== void 0,
          this.cacheConfig.config,
        );
        return result;
      }
      return fromCache;
    }
    try {
      return await query();
    } catch (e) {
      throw new DrizzleQueryError(queryString, params, e);
    }
  }
  getQuery() {
    return this.query;
  }
  mapRunResult(result, _isFromBatch) {
    return result;
  }
  mapAllResult(_result, _isFromBatch) {
    throw new Error("Not implemented");
  }
  mapGetResult(_result, _isFromBatch) {
    throw new Error("Not implemented");
  }
  execute(placeholderValues) {
    if (this.mode === "async") return this[this.executeMethod](placeholderValues);
    return new ExecuteResultSync(() => this[this.executeMethod](placeholderValues));
  }
  mapResult(response, isFromBatch) {
    switch (this.executeMethod) {
      case "run":
        return this.mapRunResult(response, isFromBatch);
      case "all":
        return this.mapAllResult(response, isFromBatch);
      case "get":
        return this.mapGetResult(response, isFromBatch);
    }
  }
};
var SQLiteSession = class {
  constructor(dialect) {
    this.dialect = dialect;
  }
  static [entityKind] = "SQLiteSession";
  prepareOneTimeQuery(
    query,
    fields,
    executeMethod,
    isResponseInArrayMode,
    customResultMapper,
    queryMetadata,
    cacheConfig,
  ) {
    return this.prepareQuery(
      query,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
      queryMetadata,
      cacheConfig,
    );
  }
  run(query) {
    const staticQuery = this.dialect.sqlToQuery(query);
    try {
      return this.prepareOneTimeQuery(staticQuery, void 0, "run", false).run();
    } catch (err) {
      throw new DrizzleError({
        cause: err,
        message: `Failed to run the query '${staticQuery.sql}'`,
      });
    }
  }
  /** @internal */
  extractRawRunValueFromBatchResult(result) {
    return result;
  }
  all(query) {
    return this.prepareOneTimeQuery(this.dialect.sqlToQuery(query), void 0, "run", false).all();
  }
  /** @internal */
  extractRawAllValueFromBatchResult(_result) {
    throw new Error("Not implemented");
  }
  get(query) {
    return this.prepareOneTimeQuery(this.dialect.sqlToQuery(query), void 0, "run", false).get();
  }
  /** @internal */
  extractRawGetValueFromBatchResult(_result) {
    throw new Error("Not implemented");
  }
  values(query) {
    return this.prepareOneTimeQuery(this.dialect.sqlToQuery(query), void 0, "run", false).values();
  }
  async count(sql) {
    return (await this.values(sql))[0][0];
  }
  /** @internal */
  extractRawValuesValueFromBatchResult(_result) {
    throw new Error("Not implemented");
  }
};
var SQLiteTransaction = class extends BaseSQLiteDatabase {
  constructor(resultType, dialect, session, schema, nestedIndex = 0) {
    super(resultType, dialect, session, schema);
    this.schema = schema;
    this.nestedIndex = nestedIndex;
  }
  static [entityKind] = "SQLiteTransaction";
  rollback() {
    throw new TransactionRollbackError();
  }
};
//#endregion
//#region node_modules/drizzle-orm/durable-sqlite/session.js
var SQLiteDOSession = class extends SQLiteSession {
  constructor(client, dialect, schema, options = {}) {
    super(dialect);
    this.client = client;
    this.schema = schema;
    this.logger = options.logger ?? new NoopLogger();
  }
  static [entityKind] = "SQLiteDOSession";
  logger;
  prepareQuery(query, fields, executeMethod, isResponseInArrayMode, customResultMapper) {
    return new SQLiteDOPreparedQuery(
      this.client,
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    );
  }
  transaction(transaction, _config) {
    const tx = new SQLiteDOTransaction("sync", this.dialect, this, this.schema);
    return this.client.transactionSync(() => transaction(tx));
  }
};
var SQLiteDOTransaction = class SQLiteDOTransaction extends SQLiteTransaction {
  static [entityKind] = "SQLiteDOTransaction";
  transaction(transaction) {
    const tx = new SQLiteDOTransaction(
      "sync",
      this.dialect,
      this.session,
      this.schema,
      this.nestedIndex + 1,
    );
    return this.session.transaction(() => transaction(tx));
  }
};
var SQLiteDOPreparedQuery = class extends SQLitePreparedQuery {
  constructor(
    client,
    query,
    logger,
    fields,
    executeMethod,
    _isResponseInArrayMode,
    customResultMapper,
  ) {
    super("sync", executeMethod, query, void 0, void 0, void 0);
    this.client = client;
    this.logger = logger;
    this.fields = fields;
    this._isResponseInArrayMode = _isResponseInArrayMode;
    this.customResultMapper = customResultMapper;
  }
  static [entityKind] = "SQLiteDOPreparedQuery";
  run(placeholderValues) {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    params.length > 0
      ? this.client.sql.exec(this.query.sql, ...params)
      : this.client.sql.exec(this.query.sql);
  }
  all(placeholderValues) {
    const { fields, joinsNotNullableMap, query, logger, client, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      const params = fillPlaceholders(query.params, placeholderValues ?? {});
      logger.logQuery(query.sql, params);
      return params.length > 0
        ? client.sql.exec(query.sql, ...params).toArray()
        : client.sql.exec(query.sql).toArray();
    }
    const rows = this.values(placeholderValues);
    if (customResultMapper) return customResultMapper(rows);
    return rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
  }
  get(placeholderValues) {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const { fields, client, joinsNotNullableMap, customResultMapper, query } = this;
    if (!fields && !customResultMapper)
      return (
        params.length > 0 ? client.sql.exec(query.sql, ...params) : client.sql.exec(query.sql)
      ).next().value;
    const rows = this.values(placeholderValues);
    const row = rows[0];
    if (!row) return;
    if (customResultMapper) return customResultMapper(rows);
    return mapResultRow(fields, row, joinsNotNullableMap);
  }
  values(placeholderValues) {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    return (
      params.length > 0
        ? this.client.sql.exec(this.query.sql, ...params)
        : this.client.sql.exec(this.query.sql)
    )
      .raw()
      .toArray();
  }
  /** @internal */
  isResponseInArrayMode() {
    return this._isResponseInArrayMode;
  }
};
//#endregion
//#region node_modules/drizzle-orm/durable-sqlite/driver.js
var DrizzleSqliteDODatabase = class extends BaseSQLiteDatabase {
  static [entityKind] = "DrizzleSqliteDODatabase";
};
function drizzle(client, config = {}) {
  const dialect = new SQLiteSyncDialect({ casing: config.casing });
  let logger;
  if (config.logger === true) logger = new DefaultLogger();
  else if (config.logger !== false) logger = config.logger;
  let schema;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }
  const db = new DrizzleSqliteDODatabase(
    "sync",
    dialect,
    new SQLiteDOSession(client, dialect, schema, { logger }),
    schema,
  );
  db.$client = client;
  return db;
}
//#endregion
//#region node_modules/drizzle-orm/durable-sqlite/migrator.js
function readMigrationFiles({ journal, migrations }) {
  const migrationQueries = [];
  for (const journalEntry of journal.entries) {
    const query = migrations[`m${journalEntry.idx.toString().padStart(4, "0")}`];
    if (!query) throw new Error(`Missing migration: ${journalEntry.tag}`);
    try {
      const result = query.split("--> statement-breakpoint").map((it) => {
        return it;
      });
      migrationQueries.push({
        sql: result,
        bps: journalEntry.breakpoints,
        folderMillis: journalEntry.when,
        hash: "",
      });
    } catch {
      throw new Error(`Failed to parse migration: ${journalEntry.tag}`);
    }
  }
  return migrationQueries;
}
async function migrate(db, config) {
  const migrations = readMigrationFiles(config);
  db.transaction((tx) => {
    try {
      const migrationsTable = "__drizzle_migrations";
      const migrationTableCreate = sql`
				CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
					id SERIAL PRIMARY KEY,
					hash text NOT NULL,
					created_at numeric
				)
			`;
      db.run(migrationTableCreate);
      const lastDbMigration =
        db.values(
          sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`,
        )[0] ?? void 0;
      for (const migration of migrations)
        if (!lastDbMigration || Number(lastDbMigration[2]) < migration.folderMillis) {
          for (const stmt of migration.sql) db.run(sql.raw(stmt));
          db.run(
            sql`INSERT INTO ${sql.identifier(migrationsTable)} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`,
          );
        }
    } catch (error) {
      tx.rollback();
      throw error;
    }
  });
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/constants.js
var GLOBAL_TSR = "$_TSR";
var TSR_SCRIPT_BARRIER_ID = "$tsr-stream-barrier";
//#endregion
//#region node_modules/seroval/dist/esm/production/index.mjs
var L$1 = ((i) => (
  (i[(i.AggregateError = 1)] = "AggregateError"),
  (i[(i.ArrowFunction = 2)] = "ArrowFunction"),
  (i[(i.ErrorPrototypeStack = 4)] = "ErrorPrototypeStack"),
  (i[(i.ObjectAssign = 8)] = "ObjectAssign"),
  (i[(i.BigIntTypedArray = 16)] = "BigIntTypedArray"),
  (i[(i.RegExp = 32)] = "RegExp"),
  i
))(L$1 || {});
var v$1 = Symbol.asyncIterator,
  mr = Symbol.hasInstance,
  R = Symbol.isConcatSpreadable,
  C = Symbol.iterator,
  pr = Symbol.match,
  dr = Symbol.matchAll,
  gr = Symbol.replace,
  yr = Symbol.search,
  Nr = Symbol.species,
  br = Symbol.split,
  vr = Symbol.toPrimitive,
  P$1 = Symbol.toStringTag,
  Cr = Symbol.unscopables;
var rt = {
    0: "Symbol.asyncIterator",
    1: "Symbol.hasInstance",
    2: "Symbol.isConcatSpreadable",
    3: "Symbol.iterator",
    4: "Symbol.match",
    5: "Symbol.matchAll",
    6: "Symbol.replace",
    7: "Symbol.search",
    8: "Symbol.species",
    9: "Symbol.split",
    10: "Symbol.toPrimitive",
    11: "Symbol.toStringTag",
    12: "Symbol.unscopables",
  },
  ve = {
    [v$1]: 0,
    [mr]: 1,
    [R]: 2,
    [C]: 3,
    [pr]: 4,
    [dr]: 5,
    [gr]: 6,
    [yr]: 7,
    [Nr]: 8,
    [br]: 9,
    [vr]: 10,
    [P$1]: 11,
    [Cr]: 12,
  },
  tt = {
    0: v$1,
    1: mr,
    2: R,
    3: C,
    4: pr,
    5: dr,
    6: gr,
    7: yr,
    8: Nr,
    9: br,
    10: vr,
    11: P$1,
    12: Cr,
  },
  nt = {
    2: "!0",
    3: "!1",
    1: "void 0",
    0: "null",
    4: "-0",
    5: "1/0",
    6: "-1/0",
    7: "0/0",
  },
  o$1 = void 0,
  ot = {
    2: !0,
    3: !1,
    1: o$1,
    0: null,
    4: -0,
    5: Number.POSITIVE_INFINITY,
    6: Number.NEGATIVE_INFINITY,
    7: NaN,
  };
var Ce = {
    0: "Error",
    1: "EvalError",
    2: "RangeError",
    3: "ReferenceError",
    4: "SyntaxError",
    5: "TypeError",
    6: "URIError",
  },
  at = {
    0: Error,
    1: EvalError,
    2: RangeError,
    3: ReferenceError,
    4: SyntaxError,
    5: TypeError,
    6: URIError,
  };
function c$1(e, r, t, n, a, s, i, u, l, g, S, d) {
  return {
    t: e,
    i: r,
    s: t,
    c: n,
    m: a,
    p: s,
    e: i,
    a: u,
    f: l,
    b: g,
    o: S,
    l: d,
  };
}
function B$1(e) {
  return c$1(2, o$1, e, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
var J = B$1(2),
  Z = B$1(3),
  Ae = B$1(1),
  Ee = B$1(0),
  st = B$1(4),
  it = B$1(5),
  ut = B$1(6),
  lt = B$1(7);
function fn(e) {
  switch (e) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case `
`:
      return "\\n";
    case "\r":
      return "\\r";
    case "\b":
      return "\\b";
    case "	":
      return "\\t";
    case "\f":
      return "\\f";
    case "<":
      return "\\x3C";
    case "\u2028":
      return "\\u2028";
    case "\u2029":
      return "\\u2029";
    default:
      return o$1;
  }
}
function y$1(e) {
  let r = "",
    t = 0,
    n;
  for (let a = 0, s = e.length; a < s; a++)
    ((n = fn(e[a])), n && ((r += e.slice(t, a) + n), (t = a + 1)));
  return (t === 0 ? (r = e) : (r += e.slice(t)), r);
}
function Sn(e) {
  switch (e) {
    case "\\\\":
      return "\\";
    case '\\"':
      return '"';
    case "\\n":
      return `
`;
    case "\\r":
      return "\r";
    case "\\b":
      return "\b";
    case "\\t":
      return "	";
    case "\\f":
      return "\f";
    case "\\x3C":
      return "<";
    case "\\u2028":
      return "\u2028";
    case "\\u2029":
      return "\u2029";
    default:
      return e;
  }
}
function D$1(e) {
  return e.replace(/(\\\\|\\"|\\n|\\r|\\b|\\t|\\f|\\u2028|\\u2029|\\x3C)/g, Sn);
}
var U = "__SEROVAL_REFS__",
  ce = "$R",
  Ie = `self.${ce}`;
function mn(e) {
  return e == null ? `${Ie}=${Ie}||[]` : `(${Ie}=${Ie}||{})["${y$1(e)}"]=[]`;
}
var Ar = /* @__PURE__ */ new Map(),
  j = /* @__PURE__ */ new Map();
function Er(e) {
  return Ar.has(e);
}
function dn(e) {
  return j.has(e);
}
function ct(e) {
  if (Er(e)) return Ar.get(e);
  throw new Re(e);
}
function ft(e) {
  if (dn(e)) return j.get(e);
  throw new Pe(e);
}
typeof globalThis != "undefined"
  ? Object.defineProperty(globalThis, U, {
      value: j,
      configurable: !0,
      writable: !1,
      enumerable: !1,
    })
  : typeof window != "undefined"
    ? Object.defineProperty(window, U, {
        value: j,
        configurable: !0,
        writable: !1,
        enumerable: !1,
      })
    : typeof self != "undefined"
      ? Object.defineProperty(self, U, {
          value: j,
          configurable: !0,
          writable: !1,
          enumerable: !1,
        })
      : typeof global != "undefined" &&
        Object.defineProperty(global, U, {
          value: j,
          configurable: !0,
          writable: !1,
          enumerable: !1,
        });
function xe(e) {
  return e instanceof EvalError
    ? 1
    : e instanceof RangeError
      ? 2
      : e instanceof ReferenceError
        ? 3
        : e instanceof SyntaxError
          ? 4
          : e instanceof TypeError
            ? 5
            : e instanceof URIError
              ? 6
              : 0;
}
function gn(e) {
  let r = Ce[xe(e)];
  return e.name !== r
    ? { name: e.name }
    : e.constructor.name !== r
      ? { name: e.constructor.name }
      : {};
}
function $$1(e, r) {
  let t = gn(e),
    n = Object.getOwnPropertyNames(e);
  for (let a = 0, s = n.length, i; a < s; a++)
    ((i = n[a]),
      i !== "name" &&
        i !== "message" &&
        (i === "stack" ? r & 4 && ((t = t || {}), (t[i] = e[i])) : ((t = t || {}), (t[i] = e[i]))));
  return t;
}
function Oe(e) {
  return Object.isFrozen(e) ? 3 : Object.isSealed(e) ? 2 : Object.isExtensible(e) ? 0 : 1;
}
function Te(e) {
  switch (e) {
    case Number.POSITIVE_INFINITY:
      return it;
    case Number.NEGATIVE_INFINITY:
      return ut;
  }
  return e !== e
    ? lt
    : Object.is(e, -0)
      ? st
      : c$1(0, o$1, e, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function X(e) {
  return c$1(1, o$1, y$1(e), o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function we(e) {
  return c$1(3, o$1, "" + e, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function mt(e) {
  return c$1(4, e, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function he(e, r) {
  let t = r.valueOf();
  return c$1(5, e, t !== t ? "" : r.toISOString(), o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function ze(e, r) {
  return c$1(6, e, o$1, y$1(r.source), r.flags, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function pt(e, r) {
  return c$1(17, e, ve[r], o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function dt(e, r) {
  return c$1(18, e, y$1(ct(r)), o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function fe$1(e, r, t) {
  return c$1(25, e, t, y$1(r), o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function _e(e, r, t) {
  return c$1(9, e, o$1, o$1, o$1, o$1, o$1, t, o$1, o$1, Oe(r), o$1);
}
function ke(e, r) {
  return c$1(21, e, o$1, o$1, o$1, o$1, o$1, o$1, r, o$1, o$1, o$1);
}
function De(e, r, t) {
  return c$1(15, e, o$1, r.constructor.name, o$1, o$1, o$1, o$1, t, r.byteOffset, o$1, r.length);
}
function Fe(e, r, t) {
  return c$1(
    16,
    e,
    o$1,
    r.constructor.name,
    o$1,
    o$1,
    o$1,
    o$1,
    t,
    r.byteOffset,
    o$1,
    r.byteLength,
  );
}
function Be(e, r, t) {
  return c$1(20, e, o$1, o$1, o$1, o$1, o$1, o$1, t, r.byteOffset, o$1, r.byteLength);
}
function Ve(e, r, t) {
  return c$1(13, e, xe(r), o$1, y$1(r.message), t, o$1, o$1, o$1, o$1, o$1, o$1);
}
function Me(e, r, t) {
  return c$1(14, e, xe(r), o$1, y$1(r.message), t, o$1, o$1, o$1, o$1, o$1, o$1);
}
function Le(e, r) {
  return c$1(7, e, o$1, o$1, o$1, o$1, o$1, r, o$1, o$1, o$1, o$1);
}
function Ue(e, r) {
  return c$1(28, o$1, o$1, o$1, o$1, o$1, o$1, [e, r], o$1, o$1, o$1, o$1);
}
function je(e, r) {
  return c$1(30, o$1, o$1, o$1, o$1, o$1, o$1, [e, r], o$1, o$1, o$1, o$1);
}
function Ye(e, r, t) {
  return c$1(31, e, o$1, o$1, o$1, o$1, o$1, t, r, o$1, o$1, o$1);
}
function qe(e, r) {
  return c$1(32, e, o$1, o$1, o$1, o$1, o$1, o$1, r, o$1, o$1, o$1);
}
function We(e, r) {
  return c$1(33, e, o$1, o$1, o$1, o$1, o$1, o$1, r, o$1, o$1, o$1);
}
function Ge(e, r) {
  return c$1(34, e, o$1, o$1, o$1, o$1, o$1, o$1, r, o$1, o$1, o$1);
}
function Ke(e, r, t, n) {
  return c$1(35, e, t, o$1, o$1, o$1, o$1, r, o$1, o$1, o$1, n);
}
var { toString: ys } = Object.prototype;
var yn = {
  parsing: 1,
  serialization: 2,
  deserialization: 3,
};
function Nn(e) {
  return `Seroval Error (step: ${yn[e]})`;
}
var bn = (e, r) => Nn(e),
  Se = class extends Error {
    constructor(t, n) {
      super(bn(t, n));
      this.cause = n;
    }
  },
  z = class extends Se {
    constructor(r) {
      super("parsing", r);
    }
  },
  He = class extends Se {
    constructor(r) {
      super("deserialization", r);
    }
  };
function _(e) {
  return `Seroval Error (specific: ${e})`;
}
var x$1 = class extends Error {
    constructor(t) {
      super(_(1));
      this.value = t;
    }
  },
  w$1 = class extends Error {
    constructor(r) {
      super(_(2));
    }
  },
  Q = class extends Error {
    constructor(r) {
      super(_(3));
    }
  },
  V = class extends Error {
    constructor(r) {
      super(_(4));
    }
  },
  Re = class extends Error {
    constructor(t) {
      super(_(5));
      this.value = t;
    }
  },
  Pe = class extends Error {
    constructor(r) {
      super(_(6));
    }
  },
  Je = class extends Error {
    constructor(r) {
      super(_(7));
    }
  },
  h$1 = class extends Error {
    constructor(r) {
      super(_(8));
    }
  },
  ee = class extends Error {
    constructor(r) {
      super(_(9));
    }
  };
var Y$1 = class {
  constructor(r, t) {
    this.value = r;
    this.replacement = t;
  }
};
var re = () => {
    let e = {
      p: 0,
      s: 0,
      f: 0,
    };
    return (
      (e.p = new Promise((r, t) => {
        ((e.s = r), (e.f = t));
      })),
      e
    );
  },
  vn = (e, r) => {
    (e.s(r), (e.p.s = 1), (e.p.v = r));
  },
  Cn = (e, r) => {
    (e.f(r), (e.p.s = 2), (e.p.v = r));
  },
  yt = re.toString(),
  Nt = vn.toString(),
  bt = Cn.toString(),
  Rr = () => {
    let e = [],
      r = [],
      t = !0,
      n = !1,
      a = 0,
      s = (l, g, S) => {
        for (S = 0; S < a; S++) r[S] && r[S][g](l);
      },
      i = (l, g, S, d) => {
        for (g = 0, S = e.length; g < S; g++)
          ((d = e[g]), !t && g === S - 1 ? l[n ? "return" : "throw"](d) : l.next(d));
      },
      u = (l, g) => (
        t && ((g = a++), (r[g] = l)),
        i(l),
        () => {
          t && ((r[g] = r[a]), (r[a--] = void 0));
        }
      );
    return {
      __SEROVAL_STREAM__: !0,
      on: (l) => u(l),
      next: (l) => {
        t && (e.push(l), s(l, "next"));
      },
      throw: (l) => {
        t && (e.push(l), s(l, "throw"), (t = !1), (n = !1), (r.length = 0));
      },
      return: (l) => {
        t && (e.push(l), s(l, "return"), (t = !1), (n = !0), (r.length = 0));
      },
    };
  },
  vt = Rr.toString(),
  Pr = (e) => (r) => () => {
    let t = 0,
      n = {
        [e]: () => n,
        next: () => {
          if (t > r.d)
            return {
              done: !0,
              value: void 0,
            };
          let a = t++,
            s = r.v[a];
          if (a === r.t) throw s;
          return {
            done: a === r.d,
            value: s,
          };
        },
      };
    return n;
  },
  Ct = Pr.toString(),
  xr = (e, r) => (t) => () => {
    let n = 0,
      a = -1,
      s = !1,
      i = [],
      u = [],
      l = (S = 0, d = u.length) => {
        for (; S < d; S++)
          u[S].s({
            done: !0,
            value: void 0,
          });
      };
    t.on({
      next: (S) => {
        let d = u.shift();
        (d &&
          d.s({
            done: !1,
            value: S,
          }),
          i.push(S));
      },
      throw: (S) => {
        let d = u.shift();
        (d && d.f(S), l(), (a = i.length), (s = !0), i.push(S));
      },
      return: (S) => {
        let d = u.shift();
        (d &&
          d.s({
            done: !0,
            value: S,
          }),
          l(),
          (a = i.length),
          i.push(S));
      },
    });
    let g = {
      [e]: () => g,
      next: () => {
        if (a === -1) {
          let K = n++;
          if (K >= i.length) {
            let et = r();
            return (u.push(et), et.p);
          }
          return {
            done: !1,
            value: i[K],
          };
        }
        if (n > a)
          return {
            done: !0,
            value: void 0,
          };
        let S = n++,
          d = i[S];
        if (S !== a)
          return {
            done: !1,
            value: d,
          };
        if (s) throw d;
        return {
          done: !0,
          value: d,
        };
      },
    };
    return g;
  },
  At = xr.toString(),
  Or = (e) => {
    let r = atob(e),
      t = r.length,
      n = new Uint8Array(t);
    for (let a = 0; a < t; a++) n[a] = r.charCodeAt(a);
    return n.buffer;
  },
  Et = Or.toString();
function Ze(e) {
  return "__SEROVAL_SEQUENCE__" in e;
}
function Tr(e, r, t) {
  return {
    __SEROVAL_SEQUENCE__: !0,
    v: e,
    t: r,
    d: t,
  };
}
function $e(e) {
  let r = [],
    t = -1,
    n = -1,
    a = e[C]();
  for (;;)
    try {
      let s = a.next();
      if ((r.push(s.value), s.done)) {
        n = r.length - 1;
        break;
      }
    } catch (s) {
      ((t = r.length), r.push(s));
    }
  return Tr(r, t, n);
}
var An = Pr(C);
function It(e) {
  return An(e);
}
var Rt = {},
  Pt = {};
var xt = {
    0: {},
    1: {},
    2: {},
    3: {},
    4: {},
    5: {},
  },
  Ot = {
    0: "[]",
    1: yt,
    2: Nt,
    3: bt,
    4: vt,
    5: Et,
  };
function M(e) {
  return "__SEROVAL_STREAM__" in e;
}
function te$1() {
  return Rr();
}
function Xe(e) {
  let r = te$1(),
    t = e[v$1]();
  async function n() {
    try {
      let a = await t.next();
      a.done ? r.return(a.value) : (r.next(a.value), await n());
    } catch (a) {
      r.throw(a);
    }
  }
  return (n().catch(() => {}), r);
}
var En = xr(v$1, re);
function Tt(e) {
  return En(e);
}
async function wr(e) {
  try {
    return [1, await e];
  } catch (r) {
    return [0, r];
  }
}
function pe$1(e, r) {
  return {
    plugins: r.plugins,
    mode: e,
    marked: /* @__PURE__ */ new Set(),
    features: 63 ^ (r.disabledFeatures || 0),
    refs: r.refs || /* @__PURE__ */ new Map(),
    depthLimit: r.depthLimit || 1e3,
  };
}
function de(e, r) {
  e.marked.add(r);
}
function hr(e, r) {
  let t = e.refs.size;
  return (e.refs.set(r, t), t);
}
function Qe(e, r) {
  let t = e.refs.get(r);
  return t != null
    ? (de(e, t),
      {
        type: 1,
        value: mt(t),
      })
    : {
        type: 0,
        value: hr(e, r),
      };
}
function q$1(e, r) {
  let t = Qe(e, r);
  return t.type === 1
    ? t
    : Er(r)
      ? {
          type: 2,
          value: dt(t.value, r),
        }
      : t;
}
function I(e, r) {
  let t = q$1(e, r);
  if (t.type !== 0) return t.value;
  if (r in ve) return pt(t.value, r);
  throw new x$1(r);
}
function k(e, r) {
  let t = Qe(e, xt[r]);
  return t.type === 1 ? t.value : c$1(26, t.value, r, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1, o$1);
}
function er(e) {
  let r = Qe(e, Rt);
  return r.type === 1
    ? r.value
    : c$1(27, r.value, o$1, o$1, o$1, o$1, o$1, o$1, I(e, C), o$1, o$1, o$1);
}
function rr(e) {
  let r = Qe(e, Pt);
  return r.type === 1
    ? r.value
    : c$1(29, r.value, o$1, o$1, o$1, o$1, o$1, [k(e, 1), I(e, v$1)], o$1, o$1, o$1, o$1);
}
function tr(e, r, t, n) {
  return c$1(t ? 11 : 10, e, o$1, o$1, o$1, n, o$1, o$1, o$1, o$1, Oe(r), o$1);
}
function nr(e, r, t, n) {
  return c$1(
    8,
    r,
    o$1,
    o$1,
    o$1,
    o$1,
    {
      k: t,
      v: n,
    },
    o$1,
    k(e, 0),
    o$1,
    o$1,
    o$1,
  );
}
function ht(e, r, t) {
  return c$1(22, r, t, o$1, o$1, o$1, o$1, o$1, k(e, 1), o$1, o$1, o$1);
}
function or(e, r, t) {
  let n = new Uint8Array(t),
    a = "";
  for (let s = 0, i = n.length; s < i; s++) a += String.fromCharCode(n[s]);
  return c$1(19, r, y$1(btoa(a)), o$1, o$1, o$1, o$1, o$1, k(e, 5), o$1, o$1, o$1);
}
function ne$1(e, r) {
  return {
    base: pe$1(e, r),
    child: void 0,
  };
}
var _r = class {
  constructor(r, t) {
    this._p = r;
    this.depth = t;
  }
  parse(r) {
    return N$1(this._p, this.depth, r);
  }
};
async function Rn(e, r, t) {
  let n = [];
  for (let a = 0, s = t.length; a < s; a++) a in t ? (n[a] = await N$1(e, r, t[a])) : (n[a] = 0);
  return n;
}
async function Pn(e, r, t, n) {
  return _e(t, n, await Rn(e, r, n));
}
async function kr(e, r, t) {
  let n = Object.entries(t),
    a = [],
    s = [];
  for (let i = 0, u = n.length; i < u; i++)
    (a.push(y$1(n[i][0])), s.push(await N$1(e, r, n[i][1])));
  return (
    C in t && (a.push(I(e.base, C)), s.push(Ue(er(e.base), await N$1(e, r, $e(t))))),
    v$1 in t && (a.push(I(e.base, v$1)), s.push(je(rr(e.base), await N$1(e, r, Xe(t))))),
    P$1 in t && (a.push(I(e.base, P$1)), s.push(X(t[P$1]))),
    R in t && (a.push(I(e.base, R)), s.push(t[R] ? J : Z)),
    {
      k: a,
      v: s,
    }
  );
}
async function zr(e, r, t, n, a) {
  return tr(t, n, a, await kr(e, r, n));
}
async function xn(e, r, t, n) {
  return ke(t, await N$1(e, r, n.valueOf()));
}
async function On(e, r, t, n) {
  return De(t, n, await N$1(e, r, n.buffer));
}
async function Tn(e, r, t, n) {
  return Fe(t, n, await N$1(e, r, n.buffer));
}
async function wn(e, r, t, n) {
  return Be(t, n, await N$1(e, r, n.buffer));
}
async function zt(e, r, t, n) {
  let a = $$1(n, e.base.features);
  return Ve(t, n, a ? await kr(e, r, a) : o$1);
}
async function hn(e, r, t, n) {
  let a = $$1(n, e.base.features);
  return Me(t, n, a ? await kr(e, r, a) : o$1);
}
async function zn(e, r, t, n) {
  let a = [],
    s = [];
  for (let [i, u] of n.entries()) (a.push(await N$1(e, r, i)), s.push(await N$1(e, r, u)));
  return nr(e.base, t, a, s);
}
async function _n(e, r, t, n) {
  let a = [];
  for (let s of n.keys()) a.push(await N$1(e, r, s));
  return Le(t, a);
}
async function _t(e, r, t, n) {
  let a = e.base.plugins;
  if (a)
    for (let s = 0, i = a.length; s < i; s++) {
      let u = a[s];
      if (u.parse.async && u.test(n))
        return fe$1(t, u.tag, await u.parse.async(n, new _r(e, r), { id: t }));
    }
  return o$1;
}
async function kn(e, r, t, n) {
  let [a, s] = await wr(n);
  return c$1(12, t, a, o$1, o$1, o$1, o$1, o$1, await N$1(e, r, s), o$1, o$1, o$1);
}
function Dn(e, r, t, n, a) {
  let s = [],
    i = t.on({
      next: (u) => {
        (de(this.base, r),
          N$1(this, e, u).then(
            (l) => {
              s.push(qe(r, l));
            },
            (l) => {
              (a(l), i());
            },
          ));
      },
      throw: (u) => {
        (de(this.base, r),
          N$1(this, e, u).then(
            (l) => {
              (s.push(We(r, l)), n(s), i());
            },
            (l) => {
              (a(l), i());
            },
          ));
      },
      return: (u) => {
        (de(this.base, r),
          N$1(this, e, u).then(
            (l) => {
              (s.push(Ge(r, l)), n(s), i());
            },
            (l) => {
              (a(l), i());
            },
          ));
      },
    });
}
async function Fn(e, r, t, n) {
  return Ye(t, k(e.base, 4), await new Promise(Dn.bind(e, r, t, n)));
}
async function Bn(e, r, t, n) {
  let a = [];
  for (let s = 0, i = n.v.length; s < i; s++) a[s] = await N$1(e, r, n.v[s]);
  return Ke(t, a, n.t, n.d);
}
async function Vn(e, r, t, n) {
  if (Array.isArray(n)) return Pn(e, r, t, n);
  if (M(n)) return Fn(e, r, t, n);
  if (Ze(n)) return Bn(e, r, t, n);
  let a = n.constructor;
  if (a === Y$1) return N$1(e, r, n.replacement);
  let s = await _t(e, r, t, n);
  if (s) return s;
  switch (a) {
    case Object:
      return zr(e, r, t, n, !1);
    case o$1:
      return zr(e, r, t, n, !0);
    case Date:
      return he(t, n);
    case Error:
    case EvalError:
    case RangeError:
    case ReferenceError:
    case SyntaxError:
    case TypeError:
    case URIError:
      return zt(e, r, t, n);
    case Number:
    case Boolean:
    case String:
    case BigInt:
      return xn(e, r, t, n);
    case ArrayBuffer:
      return or(e.base, t, n);
    case Int8Array:
    case Int16Array:
    case Int32Array:
    case Uint8Array:
    case Uint16Array:
    case Uint32Array:
    case Uint8ClampedArray:
    case Float32Array:
    case Float64Array:
      return On(e, r, t, n);
    case DataView:
      return wn(e, r, t, n);
    case Map:
      return zn(e, r, t, n);
    case Set:
      return _n(e, r, t, n);
    default:
      break;
  }
  if (a === Promise || n instanceof Promise) return kn(e, r, t, n);
  let i = e.base.features;
  if (i & 32 && a === RegExp) return ze(t, n);
  if (i & 16)
    switch (a) {
      case BigInt64Array:
      case BigUint64Array:
        return Tn(e, r, t, n);
      default:
        break;
    }
  if (
    i & 1 &&
    typeof AggregateError != "undefined" &&
    (a === AggregateError || n instanceof AggregateError)
  )
    return hn(e, r, t, n);
  if (n instanceof Error) return zt(e, r, t, n);
  if (C in n || v$1 in n) return zr(e, r, t, n, !!a);
  throw new x$1(n);
}
async function Mn(e, r, t) {
  let n = q$1(e.base, t);
  if (n.type !== 0) return n.value;
  let a = await _t(e, r, n.value, t);
  if (a) return a;
  throw new x$1(t);
}
async function N$1(e, r, t) {
  switch (typeof t) {
    case "boolean":
      return t ? J : Z;
    case "undefined":
      return Ae;
    case "string":
      return X(t);
    case "number":
      return Te(t);
    case "bigint":
      return we(t);
    case "object":
      if (t) {
        let n = q$1(e.base, t);
        return n.type === 0 ? await Vn(e, r + 1, n.value, t) : n.value;
      }
      return Ee;
    case "symbol":
      return I(e.base, t);
    case "function":
      return Mn(e, r, t);
    default:
      throw new x$1(t);
  }
}
async function oe(e, r) {
  try {
    return await N$1(e, 0, r);
  } catch (t) {
    throw t instanceof z ? t : new z(t);
  }
}
var ae = ((t) => ((t[(t.Vanilla = 1)] = "Vanilla"), (t[(t.Cross = 2)] = "Cross"), t))(ae || {});
function ni(e) {
  return e;
}
function kt(e, r) {
  for (let t = 0, n = r.length; t < n; t++) {
    let a = r[t];
    e.has(a) || (e.add(a), a.extends && kt(e, a.extends));
  }
}
function A(e) {
  if (e) {
    let r = /* @__PURE__ */ new Set();
    return (kt(r, e), [...r]);
  }
}
function Dt(e) {
  switch (e) {
    case "Int8Array":
      return Int8Array;
    case "Int16Array":
      return Int16Array;
    case "Int32Array":
      return Int32Array;
    case "Uint8Array":
      return Uint8Array;
    case "Uint16Array":
      return Uint16Array;
    case "Uint32Array":
      return Uint32Array;
    case "Uint8ClampedArray":
      return Uint8ClampedArray;
    case "Float32Array":
      return Float32Array;
    case "Float64Array":
      return Float64Array;
    case "BigInt64Array":
      return BigInt64Array;
    case "BigUint64Array":
      return BigUint64Array;
    default:
      throw new Je(e);
  }
}
var Ln = 1e6,
  Un = 1e4,
  jn = 2e4;
function Bt(e, r) {
  switch (r) {
    case 3:
      return Object.freeze(e);
    case 1:
      return Object.preventExtensions(e);
    case 2:
      return Object.seal(e);
    default:
      return e;
  }
}
var Yn = 1e3;
function Vt(e, r) {
  var t;
  return {
    mode: e,
    plugins: r.plugins,
    refs: r.refs || /* @__PURE__ */ new Map(),
    features: (t = r.features) != null ? t : 63 ^ (r.disabledFeatures || 0),
    depthLimit: r.depthLimit || Yn,
  };
}
function Mt(e) {
  return {
    mode: 1,
    base: Vt(1, e),
    child: o$1,
    state: { marked: new Set(e.markedRefs) },
  };
}
var Dr = class {
  constructor(r, t) {
    this._p = r;
    this.depth = t;
  }
  deserialize(r) {
    return p$1(this._p, this.depth, r);
  }
};
function Ut(e, r) {
  if (r < 0 || !Number.isFinite(r) || !Number.isInteger(r))
    throw new h$1({
      t: 4,
      i: r,
    });
  if (e.refs.has(r)) throw new Error("Conflicted ref id: " + r);
}
function qn(e, r, t) {
  return (Ut(e.base, r), e.state.marked.has(r) && e.base.refs.set(r, t), t);
}
function Wn(e, r, t) {
  return (Ut(e.base, r), e.base.refs.set(r, t), t);
}
function b(e, r, t) {
  return e.mode === 1 ? qn(e, r, t) : Wn(e, r, t);
}
function Fr(e, r, t) {
  if (Object.hasOwn(r, t)) return r[t];
  throw new h$1(e);
}
function Gn(e, r) {
  return b(e, r.i, ft(D$1(r.s)));
}
function Kn(e, r, t) {
  let n = t.a,
    a = n.length,
    s = b(e, t.i, new Array(a));
  for (let i = 0, u; i < a; i++) ((u = n[i]), u && (s[i] = p$1(e, r, u)));
  return (Bt(s, t.o), s);
}
function Hn(e) {
  switch (e) {
    case "constructor":
    case "__proto__":
    case "prototype":
    case "__defineGetter__":
    case "__defineSetter__":
    case "__lookupGetter__":
    case "__lookupSetter__":
      return !1;
    default:
      return !0;
  }
}
function Jn(e) {
  switch (e) {
    case v$1:
    case R:
    case P$1:
    case C:
      return !0;
    default:
      return !1;
  }
}
function Ft(e, r, t) {
  Hn(r)
    ? (e[r] = t)
    : Object.defineProperty(e, r, {
        value: t,
        configurable: !0,
        enumerable: !0,
        writable: !0,
      });
}
function Zn(e, r, t, n, a) {
  if (typeof n == "string") Ft(t, D$1(n), p$1(e, r, a));
  else {
    let s = p$1(e, r, n);
    switch (typeof s) {
      case "string":
        Ft(t, s, p$1(e, r, a));
        break;
      case "symbol":
        Jn(s) && (t[s] = p$1(e, r, a));
        break;
      default:
        throw new h$1(n);
    }
  }
}
function jt(e, r, t, n) {
  let a = t.k;
  if (a.length > 0) for (let i = 0, u = t.v, l = a.length; i < l; i++) Zn(e, r, n, a[i], u[i]);
  return n;
}
function $n(e, r, t) {
  let n = b(e, t.i, t.t === 10 ? {} : Object.create(null));
  return (jt(e, r, t.p, n), Bt(n, t.o), n);
}
function Xn(e, r) {
  return b(e, r.i, new Date(r.s));
}
function Qn(e, r) {
  if (e.base.features & 32) {
    let t = D$1(r.c);
    if (t.length > jn) throw new h$1(r);
    return b(e, r.i, new RegExp(t, r.m));
  }
  throw new w$1(r);
}
function eo(e, r, t) {
  let n = b(e, t.i, /* @__PURE__ */ new Set());
  for (let a = 0, s = t.a, i = s.length; a < i; a++) n.add(p$1(e, r, s[a]));
  return n;
}
function ro(e, r, t) {
  let n = b(e, t.i, /* @__PURE__ */ new Map());
  for (let a = 0, s = t.e.k, i = t.e.v, u = s.length; a < u; a++)
    n.set(p$1(e, r, s[a]), p$1(e, r, i[a]));
  return n;
}
function to(e, r) {
  if (r.s.length > Ln) throw new h$1(r);
  return b(e, r.i, Or(D$1(r.s)));
}
function no(e, r, t) {
  var u;
  let n = Dt(t.c),
    a = p$1(e, r, t.f),
    s = (u = t.b) != null ? u : 0;
  if (s < 0 || s > a.byteLength) throw new h$1(t);
  return b(e, t.i, new n(a, s, t.l));
}
function oo(e, r, t) {
  var i;
  let n = p$1(e, r, t.f),
    a = (i = t.b) != null ? i : 0;
  if (a < 0 || a > n.byteLength) throw new h$1(t);
  return b(e, t.i, new DataView(n, a, t.l));
}
function Yt(e, r, t, n) {
  if (t.p) {
    let a = jt(e, r, t.p, {});
    Object.defineProperties(n, Object.getOwnPropertyDescriptors(a));
  }
  return n;
}
function ao(e, r, t) {
  return Yt(e, r, t, b(e, t.i, new AggregateError([], D$1(t.m))));
}
function so(e, r, t) {
  let n = Fr(t, at, t.s);
  return Yt(e, r, t, b(e, t.i, new n(D$1(t.m))));
}
function io(e, r, t) {
  let n = re(),
    a = b(e, t.i, n.p),
    s = p$1(e, r, t.f);
  return (t.s ? n.s(s) : n.f(s), a);
}
function uo(e, r, t) {
  return b(e, t.i, Object(p$1(e, r, t.f)));
}
function lo(e, r, t) {
  let n = e.base.plugins;
  if (n) {
    let a = D$1(t.c);
    for (let s = 0, i = n.length; s < i; s++) {
      let u = n[s];
      if (u.tag === a) return b(e, t.i, u.deserialize(t.s, new Dr(e, r), { id: t.i }));
    }
  }
  throw new Q(t.c);
}
function co(e, r) {
  return b(e, r.i, b(e, r.s, re()).p);
}
function fo(e, r, t) {
  let n = e.base.refs.get(t.i);
  if (n) return (n.s(p$1(e, r, t.a[1])), o$1);
  throw new V("Promise");
}
function So(e, r, t) {
  let n = e.base.refs.get(t.i);
  if (n) return (n.f(p$1(e, r, t.a[1])), o$1);
  throw new V("Promise");
}
function mo(e, r, t) {
  p$1(e, r, t.a[0]);
  return It(p$1(e, r, t.a[1]));
}
function po(e, r, t) {
  p$1(e, r, t.a[0]);
  return Tt(p$1(e, r, t.a[1]));
}
function go(e, r, t) {
  let n = b(e, t.i, te$1()),
    a = t.a,
    s = a.length;
  if (s) for (let i = 0; i < s; i++) p$1(e, r, a[i]);
  return n;
}
function yo(e, r, t) {
  let n = e.base.refs.get(t.i);
  if (n && M(n)) return (n.next(p$1(e, r, t.f)), o$1);
  throw new V("Stream");
}
function No(e, r, t) {
  let n = e.base.refs.get(t.i);
  if (n && M(n)) return (n.throw(p$1(e, r, t.f)), o$1);
  throw new V("Stream");
}
function bo(e, r, t) {
  let n = e.base.refs.get(t.i);
  if (n && M(n)) return (n.return(p$1(e, r, t.f)), o$1);
  throw new V("Stream");
}
function vo(e, r, t) {
  return (p$1(e, r, t.f), o$1);
}
function Co(e, r, t) {
  return (p$1(e, r, t.a[1]), o$1);
}
function Ao(e, r, t) {
  let n = b(e, t.i, Tr([], t.s, t.l));
  for (let a = 0, s = t.a.length; a < s; a++) n.v[a] = p$1(e, r, t.a[a]);
  return n;
}
function p$1(e, r, t) {
  if (r > e.base.depthLimit) throw new ee(e.base.depthLimit);
  switch (((r += 1), t.t)) {
    case 2:
      return Fr(t, ot, t.s);
    case 0:
      return Number(t.s);
    case 1:
      return D$1(String(t.s));
    case 3:
      if (String(t.s).length > Un) throw new h$1(t);
      return BigInt(t.s);
    case 4:
      return e.base.refs.get(t.i);
    case 18:
      return Gn(e, t);
    case 9:
      return Kn(e, r, t);
    case 10:
    case 11:
      return $n(e, r, t);
    case 5:
      return Xn(e, t);
    case 6:
      return Qn(e, t);
    case 7:
      return eo(e, r, t);
    case 8:
      return ro(e, r, t);
    case 19:
      return to(e, t);
    case 16:
    case 15:
      return no(e, r, t);
    case 20:
      return oo(e, r, t);
    case 14:
      return ao(e, r, t);
    case 13:
      return so(e, r, t);
    case 12:
      return io(e, r, t);
    case 17:
      return Fr(t, tt, t.s);
    case 21:
      return uo(e, r, t);
    case 25:
      return lo(e, r, t);
    case 22:
      return co(e, t);
    case 23:
      return fo(e, r, t);
    case 24:
      return So(e, r, t);
    case 28:
      return mo(e, r, t);
    case 30:
      return po(e, r, t);
    case 31:
      return go(e, r, t);
    case 32:
      return yo(e, r, t);
    case 33:
      return No(e, r, t);
    case 34:
      return bo(e, r, t);
    case 27:
      return vo(e, r, t);
    case 29:
      return Co(e, r, t);
    case 35:
      return Ao(e, r, t);
    default:
      throw new w$1(t);
  }
}
function ar(e, r) {
  try {
    return p$1(e, 0, r);
  } catch (t) {
    throw new He(t);
  }
}
var Eo = () => T,
  Io = Eo.toString(),
  qt = /=>/.test(Io);
function sr(e, r) {
  return qt
    ? (e.length === 1 ? e[0] : "(" + e.join(",") + ")") +
        "=>" +
        (r.startsWith("{") ? "(" + r + ")" : r)
    : "function(" + e.join(",") + "){return " + r + "}";
}
function Wt(e, r) {
  return qt
    ? (e.length === 1 ? e[0] : "(" + e.join(",") + ")") + "=>{" + r + "}"
    : "function(" + e.join(",") + "){" + r + "}";
}
var Ht = "hjkmoquxzABCDEFGHIJKLNPQRTUVWXYZ$_",
  Gt = Ht.length,
  Jt = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$_",
  Kt = Jt.length;
function Br(e) {
  let r = e % Gt,
    t = Ht[r];
  for (e = (e - r) / Gt; e > 0; ) ((r = e % Kt), (t += Jt[r]), (e = (e - r) / Kt));
  return t;
}
var Ro = /^[$A-Z_][0-9A-Z_$]*$/i;
function Vr(e) {
  let r = e[0];
  return (r === "$" || r === "_" || (r >= "A" && r <= "Z") || (r >= "a" && r <= "z")) && Ro.test(e);
}
function ye(e) {
  switch (e.t) {
    case 0:
      return e.s + "=" + e.v;
    case 2:
      return e.s + ".set(" + e.k + "," + e.v + ")";
    case 1:
      return e.s + ".add(" + e.v + ")";
    case 3:
      return e.s + ".delete(" + e.k + ")";
  }
}
function Po(e) {
  let r = [],
    t = e[0];
  for (let n = 1, a = e.length, s, i = t; n < a; n++)
    ((s = e[n]),
      s.t === 0 && s.v === i.v
        ? (t = {
            t: 0,
            s: s.s,
            k: o$1,
            v: ye(t),
          })
        : s.t === 2 && s.s === i.s
          ? (t = {
              t: 2,
              s: ye(t),
              k: s.k,
              v: s.v,
            })
          : s.t === 1 && s.s === i.s
            ? (t = {
                t: 1,
                s: ye(t),
                k: o$1,
                v: s.v,
              })
            : s.t === 3 && s.s === i.s
              ? (t = {
                  t: 3,
                  s: ye(t),
                  k: s.k,
                  v: o$1,
                })
              : (r.push(t), (t = s)),
      (i = s));
  return (r.push(t), r);
}
function tn(e) {
  if (e.length) {
    let r = "",
      t = Po(e);
    for (let n = 0, a = t.length; n < a; n++) r += ye(t[n]) + ",";
    return r;
  }
  return o$1;
}
var xo = "Object.create(null)",
  Oo = "new Set",
  To = "new Map",
  wo = "Promise.resolve",
  ho = "Promise.reject",
  zo = {
    3: "Object.freeze",
    2: "Object.seal",
    1: "Object.preventExtensions",
    0: o$1,
  };
function nn(e, r) {
  return {
    mode: e,
    plugins: r.plugins,
    features: r.features,
    marked: new Set(r.markedRefs),
    stack: [],
    flags: [],
    assignments: [],
  };
}
function ur(e) {
  return {
    mode: 2,
    base: nn(2, e),
    state: e,
    child: o$1,
  };
}
var Mr = class {
  constructor(r) {
    this._p = r;
  }
  serialize(r) {
    return f$1(this._p, r);
  }
};
function ko(e, r) {
  let t = e.valid.get(r);
  t ?? ((t = e.valid.size), e.valid.set(r, t));
  let n = e.vars[t];
  return (n ?? ((n = Br(t)), (e.vars[t] = n)), n);
}
function Do(e) {
  return ce + "[" + e + "]";
}
function m$1(e, r) {
  return e.mode === 1 ? ko(e.state, r) : Do(r);
}
function O$1(e, r) {
  e.marked.add(r);
}
function Lr(e, r) {
  return e.marked.has(r);
}
function jr(e, r, t) {
  r !== 0 &&
    (O$1(e.base, t),
    e.base.flags.push({
      type: r,
      value: m$1(e, t),
    }));
}
function Fo(e) {
  let r = "";
  for (let t = 0, n = e.flags, a = n.length; t < a; t++) {
    let s = n[t];
    r += zo[s.type] + "(" + s.value + "),";
  }
  return r;
}
function on(e) {
  let r = tn(e.assignments),
    t = Fo(e);
  return r ? (t ? r + t : r) : t;
}
function Yr(e, r, t) {
  e.assignments.push({
    t: 0,
    s: r,
    k: o$1,
    v: t,
  });
}
function Bo(e, r, t) {
  e.base.assignments.push({
    t: 1,
    s: m$1(e, r),
    k: o$1,
    v: t,
  });
}
function ge(e, r, t, n) {
  e.base.assignments.push({
    t: 2,
    s: m$1(e, r),
    k: t,
    v: n,
  });
}
function Zt(e, r, t) {
  e.base.assignments.push({
    t: 3,
    s: m$1(e, r),
    k: t,
    v: o$1,
  });
}
function Ne(e, r, t, n) {
  Yr(e.base, m$1(e, r) + "[" + t + "]", n);
}
function Ur(e, r, t, n) {
  Yr(e.base, m$1(e, r) + "." + t, n);
}
function Vo(e, r, t, n) {
  Yr(e.base, m$1(e, r) + ".v[" + t + "]", n);
}
function F(e, r) {
  return r.t === 4 && e.stack.includes(r.i);
}
function se(e, r, t) {
  return e.mode === 1 && !Lr(e.base, r) ? t : m$1(e, r) + "=" + t;
}
function Mo(e) {
  return U + '.get("' + e.s + '")';
}
function $t(e, r, t, n) {
  return t ? (F(e.base, t) ? (O$1(e.base, r), Ne(e, r, n, m$1(e, t.i)), "") : f$1(e, t)) : "";
}
function Lo(e, r) {
  let t = r.i,
    n = r.a,
    a = n.length;
  if (a > 0) {
    e.base.stack.push(t);
    let s = $t(e, t, n[0], 0),
      i = s === "";
    for (let u = 1, l; u < a; u++) ((l = $t(e, t, n[u], u)), (s += "," + l), (i = l === ""));
    return (e.base.stack.pop(), jr(e, r.o, r.i), "[" + s + (i ? ",]" : "]"));
  }
  return "[]";
}
function Xt(e, r, t, n) {
  if (typeof t == "string") {
    let a = Number(t),
      s = (a >= 0 && a.toString() === t) || Vr(t);
    if (F(e.base, n)) {
      let i = m$1(e, n.i);
      return (
        O$1(e.base, r.i), s && a !== a ? Ur(e, r.i, t, i) : Ne(e, r.i, s ? t : '"' + t + '"', i), ""
      );
    }
    return (s ? t : '"' + t + '"') + ":" + f$1(e, n);
  }
  return "[" + f$1(e, t) + "]:" + f$1(e, n);
}
function an(e, r, t) {
  let n = t.k,
    a = n.length;
  if (a > 0) {
    let s = t.v;
    e.base.stack.push(r.i);
    let i = Xt(e, r, n[0], s[0]);
    for (let u = 1, l = i; u < a; u++) ((l = Xt(e, r, n[u], s[u])), (i += (l && i && ",") + l));
    return (e.base.stack.pop(), "{" + i + "}");
  }
  return "{}";
}
function Uo(e, r) {
  return (jr(e, r.o, r.i), an(e, r, r.p));
}
function jo(e, r, t, n) {
  let a = an(e, r, t);
  return a !== "{}" ? "Object.assign(" + n + "," + a + ")" : n;
}
function Yo(e, r, t, n, a) {
  let s = e.base,
    i = f$1(e, a),
    u = Number(n),
    l = (u >= 0 && u.toString() === n) || Vr(n);
  if (F(s, a)) l && u !== u ? Ur(e, r.i, n, i) : Ne(e, r.i, l ? n : '"' + n + '"', i);
  else {
    let g = s.assignments;
    ((s.assignments = t),
      l && u !== u ? Ur(e, r.i, n, i) : Ne(e, r.i, l ? n : '"' + n + '"', i),
      (s.assignments = g));
  }
}
function qo(e, r, t, n, a) {
  if (typeof n == "string") Yo(e, r, t, n, a);
  else {
    let s = e.base,
      i = s.stack;
    s.stack = [];
    let u = f$1(e, a);
    s.stack = i;
    let l = s.assignments;
    ((s.assignments = t), Ne(e, r.i, f$1(e, n), u), (s.assignments = l));
  }
}
function Wo(e, r, t) {
  let n = t.k,
    a = n.length;
  if (a > 0) {
    let s = [],
      i = t.v;
    e.base.stack.push(r.i);
    for (let u = 0; u < a; u++) qo(e, r, s, n[u], i[u]);
    return (e.base.stack.pop(), tn(s));
  }
  return o$1;
}
function qr(e, r, t) {
  if (r.p) {
    let n = e.base;
    if (n.features & 8) t = jo(e, r, r.p, t);
    else {
      O$1(n, r.i);
      let a = Wo(e, r, r.p);
      if (a) return "(" + se(e, r.i, t) + "," + a + m$1(e, r.i) + ")";
    }
  }
  return t;
}
function Go(e, r) {
  return (jr(e, r.o, r.i), qr(e, r, xo));
}
function Ko(e) {
  return 'new Date("' + e.s + '")';
}
function Ho(e, r) {
  if (e.base.features & 32) return "/" + r.c + "/" + r.m;
  throw new w$1(r);
}
function Qt(e, r, t) {
  let n = e.base;
  return F(n, t) ? (O$1(n, r), Bo(e, r, m$1(e, t.i)), "") : f$1(e, t);
}
function Jo(e, r) {
  let t = Oo,
    n = r.a,
    a = n.length,
    s = r.i;
  if (a > 0) {
    e.base.stack.push(s);
    let i = Qt(e, s, n[0]);
    for (let u = 1, l = i; u < a; u++) ((l = Qt(e, s, n[u])), (i += (l && i && ",") + l));
    (e.base.stack.pop(), i && (t += "([" + i + "])"));
  }
  return t;
}
function en(e, r, t, n, a) {
  let s = e.base;
  if (F(s, t)) {
    let i = m$1(e, t.i);
    if ((O$1(s, r), F(s, n))) return (ge(e, r, i, m$1(e, n.i)), "");
    if (n.t !== 4 && n.i != null && Lr(s, n.i)) {
      let l = "(" + f$1(e, n) + ",[" + a + "," + a + "])";
      return (ge(e, r, i, m$1(e, n.i)), Zt(e, r, a), l);
    }
    let u = s.stack;
    return ((s.stack = []), ge(e, r, i, f$1(e, n)), (s.stack = u), "");
  }
  if (F(s, n)) {
    let i = m$1(e, n.i);
    if ((O$1(s, r), t.t !== 4 && t.i != null && Lr(s, t.i))) {
      let l = "(" + f$1(e, t) + ",[" + a + "," + a + "])";
      return (ge(e, r, m$1(e, t.i), i), Zt(e, r, a), l);
    }
    let u = s.stack;
    return ((s.stack = []), ge(e, r, f$1(e, t), i), (s.stack = u), "");
  }
  return "[" + f$1(e, t) + "," + f$1(e, n) + "]";
}
function Zo(e, r) {
  let t = To,
    n = r.e.k,
    a = n.length,
    s = r.i,
    i = r.f,
    u = m$1(e, i.i),
    l = e.base;
  if (a > 0) {
    let g = r.e.v;
    l.stack.push(s);
    let S = en(e, s, n[0], g[0], u);
    for (let d = 1, K = S; d < a; d++) ((K = en(e, s, n[d], g[d], u)), (S += (K && S && ",") + K));
    (l.stack.pop(), S && (t += "([" + S + "])"));
  }
  return (i.t === 26 && (O$1(l, i.i), (t = "(" + f$1(e, i) + "," + t + ")")), t);
}
function $o(e, r) {
  return W(e, r.f) + '("' + r.s + '")';
}
function Xo(e, r) {
  return "new " + r.c + "(" + f$1(e, r.f) + "," + r.b + "," + r.l + ")";
}
function Qo(e, r) {
  return "new DataView(" + f$1(e, r.f) + "," + r.b + "," + r.l + ")";
}
function ea(e, r) {
  let t = r.i;
  e.base.stack.push(t);
  let n = qr(e, r, 'new AggregateError([],"' + r.m + '")');
  return (e.base.stack.pop(), n);
}
function ra(e, r) {
  return qr(e, r, "new " + Ce[r.s] + '("' + r.m + '")');
}
function ta(e, r) {
  let t,
    n = r.f,
    a = r.i,
    s = r.s ? wo : ho,
    i = e.base;
  if (F(i, n)) {
    let u = m$1(e, n.i);
    t = s + (r.s ? "().then(" + sr([], u) + ")" : "().catch(" + Wt([], "throw " + u) + ")");
  } else {
    i.stack.push(a);
    let u = f$1(e, n);
    (i.stack.pop(), (t = s + "(" + u + ")"));
  }
  return t;
}
function na(e, r) {
  return "Object(" + f$1(e, r.f) + ")";
}
function W(e, r) {
  let t = f$1(e, r);
  return r.t === 4 ? t : "(" + t + ")";
}
function oa(e, r) {
  if (e.mode === 1) throw new w$1(r);
  return "(" + se(e, r.s, W(e, r.f) + "()") + ").p";
}
function aa(e, r) {
  if (e.mode === 1) throw new w$1(r);
  return W(e, r.a[0]) + "(" + m$1(e, r.i) + "," + f$1(e, r.a[1]) + ")";
}
function sa(e, r) {
  if (e.mode === 1) throw new w$1(r);
  return W(e, r.a[0]) + "(" + m$1(e, r.i) + "," + f$1(e, r.a[1]) + ")";
}
function ia(e, r) {
  let t = e.base.plugins;
  if (t)
    for (let n = 0, a = t.length; n < a; n++) {
      let s = t[n];
      if (s.tag === r.c) return ((e.child ??= new Mr(e)), s.serialize(r.s, e.child, { id: r.i }));
    }
  throw new Q(r.c);
}
function ua(e, r) {
  let t = "",
    n = !1;
  return (
    r.f.t !== 4 && (O$1(e.base, r.f.i), (t = "(" + f$1(e, r.f) + ","), (n = !0)),
    (t += se(e, r.i, "(" + Ct + ")(" + m$1(e, r.f.i) + ")")),
    n && (t += ")"),
    t
  );
}
function la(e, r) {
  return W(e, r.a[0]) + "(" + f$1(e, r.a[1]) + ")";
}
function ca(e, r) {
  let t = r.a[0],
    n = r.a[1],
    a = e.base,
    s = "";
  (t.t !== 4 && (O$1(a, t.i), (s += "(" + f$1(e, t))),
    n.t !== 4 && (O$1(a, n.i), (s += (s ? "," : "(") + f$1(e, n))),
    s && (s += ","));
  let i = se(e, r.i, "(" + At + ")(" + m$1(e, n.i) + "," + m$1(e, t.i) + ")");
  return s ? s + i + ")" : i;
}
function fa(e, r) {
  return W(e, r.a[0]) + "(" + f$1(e, r.a[1]) + ")";
}
function Sa(e, r) {
  let t = se(e, r.i, W(e, r.f) + "()"),
    n = r.a.length;
  if (n) {
    let a = f$1(e, r.a[0]);
    for (let s = 1; s < n; s++) a += "," + f$1(e, r.a[s]);
    return "(" + t + "," + a + "," + m$1(e, r.i) + ")";
  }
  return t;
}
function ma(e, r) {
  return m$1(e, r.i) + ".next(" + f$1(e, r.f) + ")";
}
function pa(e, r) {
  return m$1(e, r.i) + ".throw(" + f$1(e, r.f) + ")";
}
function da(e, r) {
  return m$1(e, r.i) + ".return(" + f$1(e, r.f) + ")";
}
function rn(e, r, t, n) {
  let a = e.base;
  return F(a, n) ? (O$1(a, r), Vo(e, r, t, m$1(e, n.i)), "") : f$1(e, n);
}
function ga(e, r) {
  let t = r.a,
    n = t.length,
    a = r.i;
  if (n > 0) {
    e.base.stack.push(a);
    let s = rn(e, a, 0, t[0]);
    for (let i = 1, u = s; i < n; i++) ((u = rn(e, a, i, t[i])), (s += (u && s && ",") + u));
    if ((e.base.stack.pop(), s))
      return "{__SEROVAL_SEQUENCE__:!0,v:[" + s + "],t:" + r.s + ",d:" + r.l + "}";
  }
  return "{__SEROVAL_SEQUENCE__:!0,v:[],t:-1,d:0}";
}
function ya(e, r) {
  switch (r.t) {
    case 17:
      return rt[r.s];
    case 18:
      return Mo(r);
    case 9:
      return Lo(e, r);
    case 10:
      return Uo(e, r);
    case 11:
      return Go(e, r);
    case 5:
      return Ko(r);
    case 6:
      return Ho(e, r);
    case 7:
      return Jo(e, r);
    case 8:
      return Zo(e, r);
    case 19:
      return $o(e, r);
    case 16:
    case 15:
      return Xo(e, r);
    case 20:
      return Qo(e, r);
    case 14:
      return ea(e, r);
    case 13:
      return ra(e, r);
    case 12:
      return ta(e, r);
    case 21:
      return na(e, r);
    case 22:
      return oa(e, r);
    case 25:
      return ia(e, r);
    case 26:
      return Ot[r.s];
    case 35:
      return ga(e, r);
    default:
      throw new w$1(r);
  }
}
function f$1(e, r) {
  switch (r.t) {
    case 2:
      return nt[r.s];
    case 0:
      return "" + r.s;
    case 1:
      return '"' + r.s + '"';
    case 3:
      return r.s + "n";
    case 4:
      return m$1(e, r.i);
    case 23:
      return aa(e, r);
    case 24:
      return sa(e, r);
    case 27:
      return ua(e, r);
    case 28:
      return la(e, r);
    case 29:
      return ca(e, r);
    case 30:
      return fa(e, r);
    case 31:
      return Sa(e, r);
    case 32:
      return ma(e, r);
    case 33:
      return pa(e, r);
    case 34:
      return da(e, r);
    default:
      return se(e, r.i, ya(e, r));
  }
}
function cr(e, r) {
  let t = f$1(e, r),
    n = r.i;
  if (n == null) return t;
  let a = on(e.base),
    s = m$1(e, n),
    i = e.state.scopeId,
    u = i == null ? "" : ce,
    l = a ? "(" + t + "," + a + s + ")" : t;
  if (u === "") return r.t === 10 && !a ? "(" + l + ")" : l;
  let g = i == null ? "()" : "(" + ce + '["' + y$1(i) + '"])';
  return "(" + sr([u], l) + ")" + g;
}
var Gr = class {
    constructor(r, t) {
      this._p = r;
      this.depth = t;
    }
    parse(r) {
      return E$1(this._p, this.depth, r);
    }
  },
  Kr = class {
    constructor(r, t) {
      this._p = r;
      this.depth = t;
    }
    parse(r) {
      return E$1(this._p, this.depth, r);
    }
    parseWithError(r) {
      return G(this._p, this.depth, r);
    }
    isAlive() {
      return this._p.state.alive;
    }
    pushPendingState() {
      Xr(this._p);
    }
    popPendingState() {
      be(this._p);
    }
    onParse(r) {
      ie(this._p, r);
    }
    onError(r) {
      Zr(this._p, r);
    }
  };
function Na(e) {
  return {
    alive: !0,
    pending: 0,
    initial: !0,
    buffer: [],
    onParse: e.onParse,
    onError: e.onError,
    onDone: e.onDone,
  };
}
function Hr(e) {
  return {
    type: 2,
    base: pe$1(2, e),
    state: Na(e),
  };
}
function ba(e, r, t) {
  let n = [];
  for (let a = 0, s = t.length; a < s; a++) a in t ? (n[a] = E$1(e, r, t[a])) : (n[a] = 0);
  return n;
}
function va(e, r, t, n) {
  return _e(t, n, ba(e, r, n));
}
function Jr(e, r, t) {
  let n = Object.entries(t),
    a = [],
    s = [];
  for (let i = 0, u = n.length; i < u; i++) (a.push(y$1(n[i][0])), s.push(E$1(e, r, n[i][1])));
  return (
    C in t && (a.push(I(e.base, C)), s.push(Ue(er(e.base), E$1(e, r, $e(t))))),
    v$1 in t &&
      (a.push(I(e.base, v$1)), s.push(je(rr(e.base), E$1(e, r, e.type === 1 ? te$1() : Xe(t))))),
    P$1 in t && (a.push(I(e.base, P$1)), s.push(X(t[P$1]))),
    R in t && (a.push(I(e.base, R)), s.push(t[R] ? J : Z)),
    {
      k: a,
      v: s,
    }
  );
}
function Wr(e, r, t, n, a) {
  return tr(t, n, a, Jr(e, r, n));
}
function Ca(e, r, t, n) {
  return ke(t, E$1(e, r, n.valueOf()));
}
function Aa(e, r, t, n) {
  return De(t, n, E$1(e, r, n.buffer));
}
function Ea(e, r, t, n) {
  return Fe(t, n, E$1(e, r, n.buffer));
}
function Ia(e, r, t, n) {
  return Be(t, n, E$1(e, r, n.buffer));
}
function sn(e, r, t, n) {
  let a = $$1(n, e.base.features);
  return Ve(t, n, a ? Jr(e, r, a) : o$1);
}
function Ra(e, r, t, n) {
  let a = $$1(n, e.base.features);
  return Me(t, n, a ? Jr(e, r, a) : o$1);
}
function Pa(e, r, t, n) {
  let a = [],
    s = [];
  for (let [i, u] of n.entries()) (a.push(E$1(e, r, i)), s.push(E$1(e, r, u)));
  return nr(e.base, t, a, s);
}
function xa(e, r, t, n) {
  let a = [];
  for (let s of n.keys()) a.push(E$1(e, r, s));
  return Le(t, a);
}
function Oa(e, r, t, n) {
  let a = Ye(t, k(e.base, 4), []);
  return (
    e.type === 1 ||
      (Xr(e),
      n.on({
        next: (s) => {
          if (e.state.alive) {
            let i = G(e, r, s);
            i && ie(e, qe(t, i));
          }
        },
        throw: (s) => {
          if (e.state.alive) {
            let i = G(e, r, s);
            i && ie(e, We(t, i));
          }
          be(e);
        },
        return: (s) => {
          if (e.state.alive) {
            let i = G(e, r, s);
            i && ie(e, Ge(t, i));
          }
          be(e);
        },
      })),
    a
  );
}
function Ta(e, r, t) {
  if (this.state.alive) {
    let n = G(this, r, t);
    (n && ie(this, c$1(23, e, o$1, o$1, o$1, o$1, o$1, [k(this.base, 2), n], o$1, o$1, o$1, o$1)),
      be(this));
  }
}
function wa(e, r, t) {
  if (this.state.alive) {
    let n = G(this, r, t);
    n && ie(this, c$1(24, e, o$1, o$1, o$1, o$1, o$1, [k(this.base, 3), n], o$1, o$1, o$1, o$1));
  }
  be(this);
}
function ha(e, r, t, n) {
  let a = hr(e.base, {});
  return (e.type === 2 && (Xr(e), n.then(Ta.bind(e, a, r), wa.bind(e, a, r))), ht(e.base, t, a));
}
function za(e, r, t, n, a) {
  for (let s = 0, i = a.length; s < i; s++) {
    let u = a[s];
    if (u.parse.sync && u.test(n)) return fe$1(t, u.tag, u.parse.sync(n, new Gr(e, r), { id: t }));
  }
  return o$1;
}
function _a(e, r, t, n, a) {
  for (let s = 0, i = a.length; s < i; s++) {
    let u = a[s];
    if (u.parse.stream && u.test(n))
      return fe$1(t, u.tag, u.parse.stream(n, new Kr(e, r), { id: t }));
  }
  return o$1;
}
function un(e, r, t, n) {
  let a = e.base.plugins;
  return a ? (e.type === 1 ? za(e, r, t, n, a) : _a(e, r, t, n, a)) : o$1;
}
function ka(e, r, t, n) {
  let a = [];
  for (let s = 0, i = n.v.length; s < i; s++) a[s] = E$1(e, r, n.v[s]);
  return Ke(t, a, n.t, n.d);
}
function Da(e, r, t, n, a) {
  switch (a) {
    case Object:
      return Wr(e, r, t, n, !1);
    case o$1:
      return Wr(e, r, t, n, !0);
    case Date:
      return he(t, n);
    case Error:
    case EvalError:
    case RangeError:
    case ReferenceError:
    case SyntaxError:
    case TypeError:
    case URIError:
      return sn(e, r, t, n);
    case Number:
    case Boolean:
    case String:
    case BigInt:
      return Ca(e, r, t, n);
    case ArrayBuffer:
      return or(e.base, t, n);
    case Int8Array:
    case Int16Array:
    case Int32Array:
    case Uint8Array:
    case Uint16Array:
    case Uint32Array:
    case Uint8ClampedArray:
    case Float32Array:
    case Float64Array:
      return Aa(e, r, t, n);
    case DataView:
      return Ia(e, r, t, n);
    case Map:
      return Pa(e, r, t, n);
    case Set:
      return xa(e, r, t, n);
    default:
      break;
  }
  if (a === Promise || n instanceof Promise) return ha(e, r, t, n);
  let s = e.base.features;
  if (s & 32 && a === RegExp) return ze(t, n);
  if (s & 16)
    switch (a) {
      case BigInt64Array:
      case BigUint64Array:
        return Ea(e, r, t, n);
      default:
        break;
    }
  if (
    s & 1 &&
    typeof AggregateError != "undefined" &&
    (a === AggregateError || n instanceof AggregateError)
  )
    return Ra(e, r, t, n);
  if (n instanceof Error) return sn(e, r, t, n);
  if (C in n || v$1 in n) return Wr(e, r, t, n, !!a);
  throw new x$1(n);
}
function Fa(e, r, t, n) {
  if (Array.isArray(n)) return va(e, r, t, n);
  if (M(n)) return Oa(e, r, t, n);
  if (Ze(n)) return ka(e, r, t, n);
  let a = n.constructor;
  if (a === Y$1) return E$1(e, r, n.replacement);
  return un(e, r, t, n) || Da(e, r, t, n, a);
}
function Ba(e, r, t) {
  let n = q$1(e.base, t);
  if (n.type !== 0) return n.value;
  let a = un(e, r, n.value, t);
  if (a) return a;
  throw new x$1(t);
}
function E$1(e, r, t) {
  if (r >= e.base.depthLimit) throw new ee(e.base.depthLimit);
  switch (typeof t) {
    case "boolean":
      return t ? J : Z;
    case "undefined":
      return Ae;
    case "string":
      return X(t);
    case "number":
      return Te(t);
    case "bigint":
      return we(t);
    case "object":
      if (t) {
        let n = q$1(e.base, t);
        return n.type === 0 ? Fa(e, r + 1, n.value, t) : n.value;
      }
      return Ee;
    case "symbol":
      return I(e.base, t);
    case "function":
      return Ba(e, r, t);
    default:
      throw new x$1(t);
  }
}
function ie(e, r) {
  e.state.initial ? e.state.buffer.push(r) : $r(e, r, !1);
}
function Zr(e, r) {
  if (e.state.onError) e.state.onError(r);
  else throw r instanceof z ? r : new z(r);
}
function ln(e) {
  e.state.onDone && e.state.onDone();
}
function $r(e, r, t) {
  try {
    e.state.onParse(r, t);
  } catch (n) {
    Zr(e, n);
  }
}
function Xr(e) {
  e.state.pending++;
}
function be(e) {
  --e.state.pending <= 0 && ln(e);
}
function G(e, r, t) {
  try {
    return E$1(e, r, t);
  } catch (n) {
    return (Zr(e, n), o$1);
  }
}
function Qr(e, r) {
  let t = G(e, 0, r);
  t && ($r(e, t, !0), (e.state.initial = !1), Va(e, e.state), e.state.pending <= 0 && fr(e));
}
function Va(e, r) {
  for (let t = 0, n = r.buffer.length; t < n; t++) $r(e, r.buffer[t], !1);
}
function fr(e) {
  e.state.alive && (ln(e), (e.state.alive = !1));
}
async function ou(e, r = {}) {
  return await oe(
    ne$1(2, {
      plugins: A(r.plugins),
      disabledFeatures: r.disabledFeatures,
      refs: r.refs,
    }),
    e,
  );
}
function cn(e, r) {
  let t = A(r.plugins),
    n = Hr({
      plugins: t,
      refs: r.refs,
      disabledFeatures: r.disabledFeatures,
      onParse(a, s) {
        let i = ur({
            plugins: t,
            features: n.base.features,
            scopeId: r.scopeId,
            markedRefs: n.base.marked,
          }),
          u;
        try {
          u = cr(i, a);
        } catch (l) {
          r.onError && r.onError(l);
          return;
        }
        r.onSerialize(u, s);
      },
      onError: r.onError,
      onDone: r.onDone,
    });
  return (Qr(n, e), fr.bind(null, n));
}
function au(e, r) {
  let n = Hr({
    plugins: A(r.plugins),
    refs: r.refs,
    disabledFeatures: r.disabledFeatures,
    depthLimit: r.depthLimit,
    onParse: r.onParse,
    onError: r.onError,
    onDone: r.onDone,
  });
  return (Qr(n, e), fr.bind(null, n));
}
function Iu(e, r = {}) {
  var i;
  let t = A(r.plugins),
    n = r.disabledFeatures || 0,
    a = (i = e.f) != null ? i : 63;
  return ar(
    Mt({
      plugins: t,
      markedRefs: e.m,
      features: a & ~n,
      disabledFeatures: n,
    }),
    e.t,
  );
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/serializer/transformer.js
/**
 * Create a strongly-typed serialization adapter for SSR hydration.
 * Use to register custom types with the router serializer.
 */
function createSerializationAdapter(opts) {
  return opts;
}
/** Create a Seroval plugin for server-side serialization only. */
/* @__NO_SIDE_EFFECTS__ */
function makeSsrSerovalPlugin(serializationAdapter, options) {
  return /* @__PURE__ */ ni({
    tag: "$TSR/t/" + serializationAdapter.key,
    test: serializationAdapter.test,
    parse: {
      stream(value, ctx, _data) {
        return { v: ctx.parse(serializationAdapter.toSerializable(value)) };
      },
    },
    serialize(node, ctx, _data) {
      options.didRun = true;
      return (
        GLOBAL_TSR + '.t.get("' + serializationAdapter.key + '")(' + ctx.serialize(node.v) + ")"
      );
    },
    deserialize: void 0,
  });
}
/** Create a Seroval plugin for client/server symmetric (de)serialization. */
/* @__NO_SIDE_EFFECTS__ */
function makeSerovalPlugin(serializationAdapter) {
  return /* @__PURE__ */ ni({
    tag: "$TSR/t/" + serializationAdapter.key,
    test: serializationAdapter.test,
    parse: {
      sync(value, ctx, _data) {
        return { v: ctx.parse(serializationAdapter.toSerializable(value)) };
      },
      async async(value, ctx, _data) {
        return { v: await ctx.parse(serializationAdapter.toSerializable(value)) };
      },
      stream(value, ctx, _data) {
        return { v: ctx.parse(serializationAdapter.toSerializable(value)) };
      },
    },
    serialize: void 0,
    deserialize(node, ctx, _data) {
      return serializationAdapter.fromSerializable(ctx.deserialize(node.v));
    },
  });
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/serializer/RawStream.js
/**
 * Marker class for ReadableStream<Uint8Array> that should be serialized
 * with base64 encoding (SSR) or binary framing (server functions).
 *
 * Wrap your binary streams with this to get efficient serialization:
 * ```ts
 * // For binary data (files, images, etc.)
 * return { data: new RawStream(file.stream()) }
 *
 * // For text-heavy data (RSC payloads, etc.)
 * return { data: new RawStream(rscStream, { hint: 'text' }) }
 * ```
 */
var RawStream = class {
  constructor(stream, options) {
    this.stream = stream;
    this.hint = options?.hint ?? "binary";
  }
};
var BufferCtor = globalThis.Buffer;
var hasNodeBuffer = !!BufferCtor && typeof BufferCtor.from === "function";
function uint8ArrayToBase64(bytes) {
  if (bytes.length === 0) return "";
  if (hasNodeBuffer) return BufferCtor.from(bytes).toString("base64");
  const CHUNK_SIZE = 32768;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    chunks.push(String.fromCharCode.apply(null, chunk));
  }
  return btoa(chunks.join(""));
}
function base64ToUint8Array(base64) {
  if (base64.length === 0) return new Uint8Array(0);
  if (hasNodeBuffer) {
    const buf = BufferCtor.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
var RAW_STREAM_FACTORY_BINARY = Object.create(null);
var RAW_STREAM_FACTORY_TEXT = Object.create(null);
var RAW_STREAM_FACTORY_CONSTRUCTOR_BINARY = (stream) =>
  new ReadableStream({
    start(controller) {
      stream.on({
        next(base64) {
          try {
            controller.enqueue(base64ToUint8Array(base64));
          } catch {}
        },
        throw(error) {
          controller.error(error);
        },
        return() {
          try {
            controller.close();
          } catch {}
        },
      });
    },
  });
var textEncoderForFactory = new TextEncoder();
var RAW_STREAM_FACTORY_CONSTRUCTOR_TEXT = (stream) => {
  return new ReadableStream({
    start(controller) {
      stream.on({
        next(value) {
          try {
            if (typeof value === "string") controller.enqueue(textEncoderForFactory.encode(value));
            else controller.enqueue(base64ToUint8Array(value.$b64));
          } catch {}
        },
        throw(error) {
          controller.error(error);
        },
        return() {
          try {
            controller.close();
          } catch {}
        },
      });
    },
  });
};
var FACTORY_BINARY = `(s=>new ReadableStream({start(c){s.on({next(b){try{const d=atob(b),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}catch(_){}},throw(e){c.error(e)},return(){try{c.close()}catch(_){}}})}}))`;
var FACTORY_TEXT = `(s=>{const e=new TextEncoder();return new ReadableStream({start(c){s.on({next(v){try{if(typeof v==='string'){c.enqueue(e.encode(v))}else{const d=atob(v.$b64),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}}catch(_){}},throw(x){c.error(x)},return(){try{c.close()}catch(_){}}})}})})`;
function toBinaryStream(readable) {
  const stream = te$1();
  const reader = readable.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          stream.return(void 0);
          break;
        }
        stream.next(uint8ArrayToBase64(value));
      }
    } catch (error) {
      stream.throw(error);
    } finally {
      reader.releaseLock();
    }
  })();
  return stream;
}
function toTextStream(readable) {
  const stream = te$1();
  const reader = readable.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          try {
            const remaining = decoder.decode();
            if (remaining.length > 0) stream.next(remaining);
          } catch {}
          stream.return(void 0);
          break;
        }
        try {
          const text = decoder.decode(value, { stream: true });
          if (text.length > 0) stream.next(text);
        } catch {
          stream.next({ $b64: uint8ArrayToBase64(value) });
        }
      }
    } catch (error) {
      stream.throw(error);
    } finally {
      reader.releaseLock();
    }
  })();
  return stream;
}
/**
 * SSR Plugin - uses base64 or UTF-8+base64 encoding for chunks, delegates to seroval's stream mechanism.
 * Used during SSR when serializing to JavaScript code for HTML injection.
 *
 * Supports two modes based on RawStream hint:
 * - 'binary': Always base64 encode (default)
 * - 'text': Try UTF-8 first, fallback to base64 for invalid UTF-8
 */
var RawStreamSSRPlugin = /* @__PURE__ */ ni({
  tag: "tss/RawStream",
  extends: [
    /* @__PURE__ */ ni({
      tag: "tss/RawStreamFactory",
      test(value) {
        return value === RAW_STREAM_FACTORY_BINARY;
      },
      parse: {
        sync(_value, _ctx, _data) {
          return {};
        },
        async async(_value, _ctx, _data) {
          return {};
        },
        stream(_value, _ctx, _data) {
          return {};
        },
      },
      serialize(_node, _ctx, _data) {
        return FACTORY_BINARY;
      },
      deserialize(_node, _ctx, _data) {
        return RAW_STREAM_FACTORY_BINARY;
      },
    }),
    /* @__PURE__ */ ni({
      tag: "tss/RawStreamFactoryText",
      test(value) {
        return value === RAW_STREAM_FACTORY_TEXT;
      },
      parse: {
        sync(_value, _ctx, _data) {
          return {};
        },
        async async(_value, _ctx, _data) {
          return {};
        },
        stream(_value, _ctx, _data) {
          return {};
        },
      },
      serialize(_node, _ctx, _data) {
        return FACTORY_TEXT;
      },
      deserialize(_node, _ctx, _data) {
        return RAW_STREAM_FACTORY_TEXT;
      },
    }),
  ],
  test(value) {
    return value instanceof RawStream;
  },
  parse: {
    sync(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      return {
        hint: ctx.parse(value.hint),
        factory: ctx.parse(factory),
        stream: ctx.parse(te$1()),
      };
    },
    async async(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      const encodedStream =
        value.hint === "text" ? toTextStream(value.stream) : toBinaryStream(value.stream);
      return {
        hint: await ctx.parse(value.hint),
        factory: await ctx.parse(factory),
        stream: await ctx.parse(encodedStream),
      };
    },
    stream(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      const encodedStream =
        value.hint === "text" ? toTextStream(value.stream) : toBinaryStream(value.stream);
      return {
        hint: ctx.parse(value.hint),
        factory: ctx.parse(factory),
        stream: ctx.parse(encodedStream),
      };
    },
  },
  serialize(node, ctx, _data) {
    return "(" + ctx.serialize(node.factory) + ")(" + ctx.serialize(node.stream) + ")";
  },
  deserialize(node, ctx, _data) {
    const stream = ctx.deserialize(node.stream);
    return ctx.deserialize(node.hint) === "text"
      ? RAW_STREAM_FACTORY_CONSTRUCTOR_TEXT(stream)
      : RAW_STREAM_FACTORY_CONSTRUCTOR_BINARY(stream);
  },
});
/**
 * Creates an RPC plugin instance that registers raw streams with a multiplexer.
 * Used for server function responses where we want binary framing.
 * Note: RPC always uses binary framing regardless of hint.
 *
 * @param onRawStream Callback invoked when a RawStream is encountered during serialization
 */
/* @__NO_SIDE_EFFECTS__ */
function createRawStreamRPCPlugin(onRawStream) {
  let nextStreamId = 1;
  return /* @__PURE__ */ ni({
    tag: "tss/RawStream",
    test(value) {
      return value instanceof RawStream;
    },
    parse: {
      async async(value, ctx, _data) {
        const streamId = nextStreamId++;
        onRawStream(streamId, value.stream);
        return { streamId: await ctx.parse(streamId) };
      },
      stream(value, ctx, _data) {
        const streamId = nextStreamId++;
        onRawStream(streamId, value.stream);
        return { streamId: ctx.parse(streamId) };
      },
    },
    serialize() {
      throw new Error(
        "RawStreamRPCPlugin.serialize should not be called. RPC uses JSON serialization, not JS code generation.",
      );
    },
    deserialize() {
      throw new Error(
        "RawStreamRPCPlugin.deserialize should not be called. Use createRawStreamDeserializePlugin on client.",
      );
    },
  });
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/serializer/ShallowErrorPlugin.js
/**
 * this plugin serializes only the `message` part of an Error
 * this helps with serializing e.g. a ZodError which has functions attached that cannot be serialized
 */
var ShallowErrorPlugin = /* @__PURE__ */ ni({
  tag: "$TSR/Error",
  test(value) {
    return value instanceof Error;
  },
  parse: {
    sync(value, ctx) {
      return { message: ctx.parse(value.message) };
    },
    async async(value, ctx) {
      return { message: await ctx.parse(value.message) };
    },
    stream(value, ctx) {
      return { message: ctx.parse(value.message) };
    },
  },
  serialize(node, ctx) {
    return "new Error(" + ctx.serialize(node.message) + ")";
  },
  deserialize(node, ctx) {
    return new Error(ctx.deserialize(node.message));
  },
});
//#endregion
//#region node_modules/seroval-plugins/dist/esm/production/web.mjs
var u = (e) => {
  let r = new AbortController(),
    a = r.abort.bind(r);
  return (e.then(a, a), r);
};
function E(e) {
  e(this.reason);
}
function D(e) {
  this.addEventListener("abort", E.bind(this, e), { once: !0 });
}
function c(e) {
  return new Promise(D.bind(e));
}
var i = {};
ni({
  tag: "seroval-plugins/web/AbortSignal",
  extends: [
    ni({
      tag: "seroval-plugins/web/AbortControllerFactoryPlugin",
      test(e) {
        return e === i;
      },
      parse: {
        sync() {
          return i;
        },
        async async() {
          return await Promise.resolve(i);
        },
        stream() {
          return i;
        },
      },
      serialize() {
        return u.toString();
      },
      deserialize() {
        return u;
      },
    }),
  ],
  test(e) {
    return typeof AbortSignal == "undefined" ? !1 : e instanceof AbortSignal;
  },
  parse: {
    sync(e, r) {
      return e.aborted ? { reason: r.parse(e.reason) } : {};
    },
    async async(e, r) {
      if (e.aborted) return { reason: await r.parse(e.reason) };
      let a = await c(e);
      return { reason: await r.parse(a) };
    },
    stream(e, r) {
      if (e.aborted) return { reason: r.parse(e.reason) };
      let a = c(e);
      return {
        factory: r.parse(i),
        controller: r.parse(a),
      };
    },
  },
  serialize(e, r) {
    return e.reason
      ? "AbortSignal.abort(" + r.serialize(e.reason) + ")"
      : e.controller && e.factory
        ? "(" + r.serialize(e.factory) + ")(" + r.serialize(e.controller) + ").signal"
        : "(new AbortController).signal";
  },
  deserialize(e, r) {
    return e.reason
      ? AbortSignal.abort(r.deserialize(e.reason))
      : e.controller
        ? u(r.deserialize(e.controller)).signal
        : new AbortController().signal;
  },
});
ni({
  tag: "seroval-plugins/web/Blob",
  test(e) {
    return typeof Blob == "undefined" ? !1 : e instanceof Blob;
  },
  parse: {
    async async(e, r) {
      return {
        type: await r.parse(e.type),
        buffer: await r.parse(await e.arrayBuffer()),
      };
    },
  },
  serialize(e, r) {
    return "new Blob([" + r.serialize(e.buffer) + "],{type:" + r.serialize(e.type) + "})";
  },
  deserialize(e, r) {
    return new Blob([r.deserialize(e.buffer)], { type: r.deserialize(e.type) });
  },
});
function d(e) {
  return {
    detail: e.detail,
    bubbles: e.bubbles,
    cancelable: e.cancelable,
    composed: e.composed,
  };
}
ni({
  tag: "seroval-plugins/web/CustomEvent",
  test(e) {
    return typeof CustomEvent == "undefined" ? !1 : e instanceof CustomEvent;
  },
  parse: {
    sync(e, r) {
      return {
        type: r.parse(e.type),
        options: r.parse(d(e)),
      };
    },
    async async(e, r) {
      return {
        type: await r.parse(e.type),
        options: await r.parse(d(e)),
      };
    },
    stream(e, r) {
      return {
        type: r.parse(e.type),
        options: r.parse(d(e)),
      };
    },
  },
  serialize(e, r) {
    return "new CustomEvent(" + r.serialize(e.type) + "," + r.serialize(e.options) + ")";
  },
  deserialize(e, r) {
    return new CustomEvent(r.deserialize(e.type), r.deserialize(e.options));
  },
});
ni({
  tag: "seroval-plugins/web/DOMException",
  test(e) {
    return typeof DOMException == "undefined" ? !1 : e instanceof DOMException;
  },
  parse: {
    sync(e, r) {
      return {
        name: r.parse(e.name),
        message: r.parse(e.message),
      };
    },
    async async(e, r) {
      return {
        name: await r.parse(e.name),
        message: await r.parse(e.message),
      };
    },
    stream(e, r) {
      return {
        name: r.parse(e.name),
        message: r.parse(e.message),
      };
    },
  },
  serialize(e, r) {
    return "new DOMException(" + r.serialize(e.message) + "," + r.serialize(e.name) + ")";
  },
  deserialize(e, r) {
    return new DOMException(r.deserialize(e.message), r.deserialize(e.name));
  },
});
function f(e) {
  return {
    bubbles: e.bubbles,
    cancelable: e.cancelable,
    composed: e.composed,
  };
}
ni({
  tag: "seroval-plugins/web/Event",
  test(e) {
    return typeof Event == "undefined" ? !1 : e instanceof Event;
  },
  parse: {
    sync(e, r) {
      return {
        type: r.parse(e.type),
        options: r.parse(f(e)),
      };
    },
    async async(e, r) {
      return {
        type: await r.parse(e.type),
        options: await r.parse(f(e)),
      };
    },
    stream(e, r) {
      return {
        type: r.parse(e.type),
        options: r.parse(f(e)),
      };
    },
  },
  serialize(e, r) {
    return "new Event(" + r.serialize(e.type) + "," + r.serialize(e.options) + ")";
  },
  deserialize(e, r) {
    return new Event(r.deserialize(e.type), r.deserialize(e.options));
  },
});
var m = ni({
  tag: "seroval-plugins/web/File",
  test(e) {
    return typeof File == "undefined" ? !1 : e instanceof File;
  },
  parse: {
    async async(e, r) {
      return {
        name: await r.parse(e.name),
        options: await r.parse({
          type: e.type,
          lastModified: e.lastModified,
        }),
        buffer: await r.parse(await e.arrayBuffer()),
      };
    },
  },
  serialize(e, r) {
    return (
      "new File([" +
      r.serialize(e.buffer) +
      "]," +
      r.serialize(e.name) +
      "," +
      r.serialize(e.options) +
      ")"
    );
  },
  deserialize(e, r) {
    return new File([r.deserialize(e.buffer)], r.deserialize(e.name), r.deserialize(e.options));
  },
});
function y(e) {
  let r = [];
  return (
    e.forEach((a, t) => {
      r.push([t, a]);
    }),
    r
  );
}
var o = {},
  v = (e, r = new FormData(), a = 0, t = e.length, s) => {
    for (; a < t; a++) ((s = e[a]), r.append(s[0], s[1]));
    return r;
  };
ni({
  tag: "seroval-plugins/web/FormData",
  extends: [
    m,
    ni({
      tag: "seroval-plugins/web/FormDataFactory",
      test(e) {
        return e === o;
      },
      parse: {
        sync() {
          return o;
        },
        async async() {
          return await Promise.resolve(o);
        },
        stream() {
          return o;
        },
      },
      serialize() {
        return v.toString();
      },
      deserialize() {
        return o;
      },
    }),
  ],
  test(e) {
    return typeof FormData == "undefined" ? !1 : e instanceof FormData;
  },
  parse: {
    sync(e, r) {
      return {
        factory: r.parse(o),
        entries: r.parse(y(e)),
      };
    },
    async async(e, r) {
      return {
        factory: await r.parse(o),
        entries: await r.parse(y(e)),
      };
    },
    stream(e, r) {
      return {
        factory: r.parse(o),
        entries: r.parse(y(e)),
      };
    },
  },
  serialize(e, r) {
    return "(" + r.serialize(e.factory) + ")(" + r.serialize(e.entries) + ")";
  },
  deserialize(e, r) {
    return v(r.deserialize(e.entries));
  },
});
function g(e) {
  let r = [];
  return (
    e.forEach((a, t) => {
      r.push([t, a]);
    }),
    r
  );
}
var l = ni({
  tag: "seroval-plugins/web/Headers",
  test(e) {
    return typeof Headers == "undefined" ? !1 : e instanceof Headers;
  },
  parse: {
    sync(e, r) {
      return { value: r.parse(g(e)) };
    },
    async async(e, r) {
      return { value: await r.parse(g(e)) };
    },
    stream(e, r) {
      return { value: r.parse(g(e)) };
    },
  },
  serialize(e, r) {
    return "new Headers(" + r.serialize(e.value) + ")";
  },
  deserialize(e, r) {
    return new Headers(r.deserialize(e.value));
  },
});
ni({
  tag: "seroval-plugins/web/ImageData",
  test(e) {
    return typeof ImageData == "undefined" ? !1 : e instanceof ImageData;
  },
  parse: {
    sync(e, r) {
      return {
        data: r.parse(e.data),
        width: r.parse(e.width),
        height: r.parse(e.height),
        options: r.parse({ colorSpace: e.colorSpace }),
      };
    },
    async async(e, r) {
      return {
        data: await r.parse(e.data),
        width: await r.parse(e.width),
        height: await r.parse(e.height),
        options: await r.parse({ colorSpace: e.colorSpace }),
      };
    },
    stream(e, r) {
      return {
        data: r.parse(e.data),
        width: r.parse(e.width),
        height: r.parse(e.height),
        options: r.parse({ colorSpace: e.colorSpace }),
      };
    },
  },
  serialize(e, r) {
    return (
      "new ImageData(" +
      r.serialize(e.data) +
      "," +
      r.serialize(e.width) +
      "," +
      r.serialize(e.height) +
      "," +
      r.serialize(e.options) +
      ")"
    );
  },
  deserialize(e, r) {
    return new ImageData(
      r.deserialize(e.data),
      r.deserialize(e.width),
      r.deserialize(e.height),
      r.deserialize(e.options),
    );
  },
});
var n = {},
  P = (e) =>
    new ReadableStream({
      start: (r) => {
        e.on({
          next: (a) => {
            try {
              r.enqueue(a);
            } catch (t) {}
          },
          throw: (a) => {
            r.error(a);
          },
          return: () => {
            try {
              r.close();
            } catch (a) {}
          },
        });
      },
    }),
  x = ni({
    tag: "seroval-plugins/web/ReadableStreamFactory",
    test(e) {
      return e === n;
    },
    parse: {
      sync() {
        return n;
      },
      async async() {
        return await Promise.resolve(n);
      },
      stream() {
        return n;
      },
    },
    serialize() {
      return P.toString();
    },
    deserialize() {
      return n;
    },
  });
function w(e) {
  let r = te$1(),
    a = e.getReader();
  async function t() {
    try {
      let s = await a.read();
      s.done ? r.return(s.value) : (r.next(s.value), await t());
    } catch (s) {
      r.throw(s);
    }
  }
  return (t().catch(() => {}), r);
}
var p = ni({
  tag: "seroval/plugins/web/ReadableStream",
  extends: [x],
  test(e) {
    return typeof ReadableStream == "undefined" ? !1 : e instanceof ReadableStream;
  },
  parse: {
    sync(e, r) {
      return {
        factory: r.parse(n),
        stream: r.parse(te$1()),
      };
    },
    async async(e, r) {
      return {
        factory: await r.parse(n),
        stream: await r.parse(w(e)),
      };
    },
    stream(e, r) {
      return {
        factory: r.parse(n),
        stream: r.parse(w(e)),
      };
    },
  },
  serialize(e, r) {
    return "(" + r.serialize(e.factory) + ")(" + r.serialize(e.stream) + ")";
  },
  deserialize(e, r) {
    return P(r.deserialize(e.stream));
  },
});
function N(e, r) {
  return {
    body: r,
    cache: e.cache,
    credentials: e.credentials,
    headers: e.headers,
    integrity: e.integrity,
    keepalive: e.keepalive,
    method: e.method,
    mode: e.mode,
    redirect: e.redirect,
    referrer: e.referrer,
    referrerPolicy: e.referrerPolicy,
  };
}
ni({
  tag: "seroval-plugins/web/Request",
  extends: [p, l],
  test(e) {
    return typeof Request == "undefined" ? !1 : e instanceof Request;
  },
  parse: {
    async async(e, r) {
      return {
        url: await r.parse(e.url),
        options: await r.parse(N(e, e.body && !e.bodyUsed ? await e.clone().arrayBuffer() : null)),
      };
    },
    stream(e, r) {
      return {
        url: r.parse(e.url),
        options: r.parse(N(e, e.body && !e.bodyUsed ? e.clone().body : null)),
      };
    },
  },
  serialize(e, r) {
    return "new Request(" + r.serialize(e.url) + "," + r.serialize(e.options) + ")";
  },
  deserialize(e, r) {
    return new Request(r.deserialize(e.url), r.deserialize(e.options));
  },
});
function h(e) {
  return {
    headers: e.headers,
    status: e.status,
    statusText: e.statusText,
  };
}
ni({
  tag: "seroval-plugins/web/Response",
  extends: [p, l],
  test(e) {
    return typeof Response == "undefined" ? !1 : e instanceof Response;
  },
  parse: {
    async async(e, r) {
      return {
        body: await r.parse(e.body && !e.bodyUsed ? await e.clone().arrayBuffer() : null),
        options: await r.parse(h(e)),
      };
    },
    stream(e, r) {
      return {
        body: r.parse(e.body && !e.bodyUsed ? e.clone().body : null),
        options: r.parse(h(e)),
      };
    },
  },
  serialize(e, r) {
    return "new Response(" + r.serialize(e.body) + "," + r.serialize(e.options) + ")";
  },
  deserialize(e, r) {
    return new Response(r.deserialize(e.body), r.deserialize(e.options));
  },
});
ni({
  tag: "seroval-plugins/web/URL",
  test(e) {
    return typeof URL == "undefined" ? !1 : e instanceof URL;
  },
  parse: {
    sync(e, r) {
      return { value: r.parse(e.href) };
    },
    async async(e, r) {
      return { value: await r.parse(e.href) };
    },
    stream(e, r) {
      return { value: r.parse(e.href) };
    },
  },
  serialize(e, r) {
    return "new URL(" + r.serialize(e.value) + ")";
  },
  deserialize(e, r) {
    return new URL(r.deserialize(e.value));
  },
});
ni({
  tag: "seroval-plugins/web/URLSearchParams",
  test(e) {
    return typeof URLSearchParams == "undefined" ? !1 : e instanceof URLSearchParams;
  },
  parse: {
    sync(e, r) {
      return { value: r.parse(e.toString()) };
    },
    async async(e, r) {
      return { value: await r.parse(e.toString()) };
    },
    stream(e, r) {
      return { value: r.parse(e.toString()) };
    },
  },
  serialize(e, r) {
    return "new URLSearchParams(" + r.serialize(e.value) + ")";
  },
  deserialize(e, r) {
    return new URLSearchParams(r.deserialize(e.value));
  },
});
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/serializer/seroval-plugins.js
var defaultSerovalPlugins = [ShallowErrorPlugin, RawStreamSSRPlugin, p];
require_react();
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/Matches.js
var import_jsx_runtime = require_jsx_runtime();
/**
 * Internal component that renders the router's active match tree with
 * suspense, error, and not-found boundaries. Rendered by `RouterProvider`.
 */
function Matches() {
  const router = useRouter();
  const PendingComponent =
    router.routesById["__root__"].options.pendingComponent ??
    router.options.defaultPendingComponent;
  const pendingElement = PendingComponent
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PendingComponent, {})
    : null;
  const inner = /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SafeFragment, {
    fallback: pendingElement,
    children: [false, /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchesInner, {})],
  });
  return router.options.InnerWrap
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(router.options.InnerWrap, { children: inner })
    : inner;
}
function MatchesInner() {
  const router = useRouter();
  const matchId = router.stores.firstId.get();
  const resetKey = router.stores.loadedAt.get();
  const matchComponent = matchId
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Match, { matchId })
    : null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(matchContext.Provider, {
    value: matchId,
    children: router.options.disableGlobalCatchBoundary
      ? matchComponent
      : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CatchBoundary, {
          getResetKey: () => resetKey,
          errorComponent: ErrorComponent,
          onCatch: void 0,
          children: matchComponent,
        }),
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/RouterProvider.js
/**
 * Low-level provider that places the router into React context and optionally
 * updates router options from props. Most apps should use `RouterProvider`.
 */
function RouterContextProvider({ router, children, ...rest }) {
  if (Object.keys(rest).length > 0)
    router.update({
      ...router.options,
      ...rest,
      context: {
        ...router.options.context,
        ...rest.context,
      },
    });
  const provider = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(routerContext.Provider, {
    value: router,
    children,
  });
  if (router.options.Wrap)
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(router.options.Wrap, { children: provider });
  return provider;
}
/**
 * Top-level component that renders the active route matches and provides the
 * router to the React tree via context.
 *
 * Accepts the same options as `createRouter` via props to update the router
 * instance after creation.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRouterFunction
 */
function RouterProvider({ router, ...rest }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RouterContextProvider, {
    router,
    ...rest,
    children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Matches, {}),
  });
}
//#endregion
//#region node_modules/@tanstack/react-start-server/dist/esm/StartServer.js
function StartServer(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RouterProvider, { router: props.router });
}
//#endregion
//#region node_modules/react-dom/cjs/react-dom-server.edge.production.js
/**
 * @license React
 * react-dom-server.edge.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var require_react_dom_server_edge_production = /* @__PURE__ */ __commonJSMin((exports) => {
  var React = require_react(),
    ReactDOM = require_react_dom(),
    REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"),
    REACT_PORTAL_TYPE = Symbol.for("react.portal"),
    REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"),
    REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"),
    REACT_PROFILER_TYPE = Symbol.for("react.profiler"),
    REACT_CONSUMER_TYPE = Symbol.for("react.consumer"),
    REACT_CONTEXT_TYPE = Symbol.for("react.context"),
    REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"),
    REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"),
    REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"),
    REACT_MEMO_TYPE = Symbol.for("react.memo"),
    REACT_LAZY_TYPE = Symbol.for("react.lazy"),
    REACT_SCOPE_TYPE = Symbol.for("react.scope"),
    REACT_ACTIVITY_TYPE = Symbol.for("react.activity"),
    REACT_LEGACY_HIDDEN_TYPE = Symbol.for("react.legacy_hidden"),
    REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel"),
    REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"),
    MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
  function getIteratorFn(maybeIterable) {
    if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
    maybeIterable =
      (MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL]) ||
      maybeIterable["@@iterator"];
    return "function" === typeof maybeIterable ? maybeIterable : null;
  }
  var isArrayImpl = Array.isArray;
  function murmurhash3_32_gc(key, seed) {
    var remainder = key.length & 3;
    var bytes = key.length - remainder;
    var h1 = seed;
    for (seed = 0; seed < bytes; ) {
      var k1 =
        (key.charCodeAt(seed) & 255) |
        ((key.charCodeAt(++seed) & 255) << 8) |
        ((key.charCodeAt(++seed) & 255) << 16) |
        ((key.charCodeAt(++seed) & 255) << 24);
      ++seed;
      k1 = (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
      h1 ^= k1;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = (5 * (h1 & 65535) + (((5 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
      h1 = (h1 & 65535) + 27492 + ((((h1 >>> 16) + 58964) & 65535) << 16);
    }
    k1 = 0;
    switch (remainder) {
      case 3:
        k1 ^= (key.charCodeAt(seed + 2) & 255) << 16;
      case 2:
        k1 ^= (key.charCodeAt(seed + 1) & 255) << 8;
      case 1:
        ((k1 ^= key.charCodeAt(seed) & 255),
          (k1 =
            (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) &
            4294967295),
          (k1 = (k1 << 15) | (k1 >>> 17)),
          (h1 ^=
            (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295));
    }
    h1 ^= key.length;
    h1 ^= h1 >>> 16;
    h1 = (2246822507 * (h1 & 65535) + (((2246822507 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
    h1 ^= h1 >>> 13;
    h1 = (3266489909 * (h1 & 65535) + (((3266489909 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
    return (h1 ^ (h1 >>> 16)) >>> 0;
  }
  function handleErrorInNextTick(error) {
    setTimeout(function () {
      throw error;
    });
  }
  var LocalPromise = Promise,
    scheduleMicrotask =
      "function" === typeof queueMicrotask
        ? queueMicrotask
        : function (callback) {
            LocalPromise.resolve(null).then(callback).catch(handleErrorInNextTick);
          },
    currentView = null,
    writtenBytes = 0;
  function writeChunk(destination, chunk) {
    if (0 !== chunk.byteLength)
      if (2048 < chunk.byteLength)
        (0 < writtenBytes &&
          (destination.enqueue(new Uint8Array(currentView.buffer, 0, writtenBytes)),
          (currentView = new Uint8Array(2048)),
          (writtenBytes = 0)),
          destination.enqueue(chunk));
      else {
        var allowableBytes = currentView.length - writtenBytes;
        allowableBytes < chunk.byteLength &&
          (0 === allowableBytes
            ? destination.enqueue(currentView)
            : (currentView.set(chunk.subarray(0, allowableBytes), writtenBytes),
              destination.enqueue(currentView),
              (chunk = chunk.subarray(allowableBytes))),
          (currentView = new Uint8Array(2048)),
          (writtenBytes = 0));
        currentView.set(chunk, writtenBytes);
        writtenBytes += chunk.byteLength;
      }
  }
  function writeChunkAndReturn(destination, chunk) {
    writeChunk(destination, chunk);
    return !0;
  }
  function completeWriting(destination) {
    currentView &&
      0 < writtenBytes &&
      (destination.enqueue(new Uint8Array(currentView.buffer, 0, writtenBytes)),
      (currentView = null),
      (writtenBytes = 0));
  }
  var textEncoder = new TextEncoder();
  function stringToChunk(content) {
    return textEncoder.encode(content);
  }
  function stringToPrecomputedChunk(content) {
    return textEncoder.encode(content);
  }
  function byteLengthOfChunk(chunk) {
    return chunk.byteLength;
  }
  function closeWithError(destination, error) {
    "function" === typeof destination.error ? destination.error(error) : destination.close();
  }
  var assign = Object.assign,
    hasOwnProperty = Object.prototype.hasOwnProperty,
    VALID_ATTRIBUTE_NAME_REGEX = RegExp(
      "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$",
    ),
    illegalAttributeNameCache = {},
    validatedAttributeNameCache = {};
  function isAttributeNameSafe(attributeName) {
    if (hasOwnProperty.call(validatedAttributeNameCache, attributeName)) return !0;
    if (hasOwnProperty.call(illegalAttributeNameCache, attributeName)) return !1;
    if (VALID_ATTRIBUTE_NAME_REGEX.test(attributeName))
      return (validatedAttributeNameCache[attributeName] = !0);
    illegalAttributeNameCache[attributeName] = !0;
    return !1;
  }
  var unitlessNumbers = new Set(
      "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
        " ",
      ),
    ),
    aliases = new Map([
      ["acceptCharset", "accept-charset"],
      ["htmlFor", "for"],
      ["httpEquiv", "http-equiv"],
      ["crossOrigin", "crossorigin"],
      ["accentHeight", "accent-height"],
      ["alignmentBaseline", "alignment-baseline"],
      ["arabicForm", "arabic-form"],
      ["baselineShift", "baseline-shift"],
      ["capHeight", "cap-height"],
      ["clipPath", "clip-path"],
      ["clipRule", "clip-rule"],
      ["colorInterpolation", "color-interpolation"],
      ["colorInterpolationFilters", "color-interpolation-filters"],
      ["colorProfile", "color-profile"],
      ["colorRendering", "color-rendering"],
      ["dominantBaseline", "dominant-baseline"],
      ["enableBackground", "enable-background"],
      ["fillOpacity", "fill-opacity"],
      ["fillRule", "fill-rule"],
      ["floodColor", "flood-color"],
      ["floodOpacity", "flood-opacity"],
      ["fontFamily", "font-family"],
      ["fontSize", "font-size"],
      ["fontSizeAdjust", "font-size-adjust"],
      ["fontStretch", "font-stretch"],
      ["fontStyle", "font-style"],
      ["fontVariant", "font-variant"],
      ["fontWeight", "font-weight"],
      ["glyphName", "glyph-name"],
      ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
      ["glyphOrientationVertical", "glyph-orientation-vertical"],
      ["horizAdvX", "horiz-adv-x"],
      ["horizOriginX", "horiz-origin-x"],
      ["imageRendering", "image-rendering"],
      ["letterSpacing", "letter-spacing"],
      ["lightingColor", "lighting-color"],
      ["markerEnd", "marker-end"],
      ["markerMid", "marker-mid"],
      ["markerStart", "marker-start"],
      ["overlinePosition", "overline-position"],
      ["overlineThickness", "overline-thickness"],
      ["paintOrder", "paint-order"],
      ["panose-1", "panose-1"],
      ["pointerEvents", "pointer-events"],
      ["renderingIntent", "rendering-intent"],
      ["shapeRendering", "shape-rendering"],
      ["stopColor", "stop-color"],
      ["stopOpacity", "stop-opacity"],
      ["strikethroughPosition", "strikethrough-position"],
      ["strikethroughThickness", "strikethrough-thickness"],
      ["strokeDasharray", "stroke-dasharray"],
      ["strokeDashoffset", "stroke-dashoffset"],
      ["strokeLinecap", "stroke-linecap"],
      ["strokeLinejoin", "stroke-linejoin"],
      ["strokeMiterlimit", "stroke-miterlimit"],
      ["strokeOpacity", "stroke-opacity"],
      ["strokeWidth", "stroke-width"],
      ["textAnchor", "text-anchor"],
      ["textDecoration", "text-decoration"],
      ["textRendering", "text-rendering"],
      ["transformOrigin", "transform-origin"],
      ["underlinePosition", "underline-position"],
      ["underlineThickness", "underline-thickness"],
      ["unicodeBidi", "unicode-bidi"],
      ["unicodeRange", "unicode-range"],
      ["unitsPerEm", "units-per-em"],
      ["vAlphabetic", "v-alphabetic"],
      ["vHanging", "v-hanging"],
      ["vIdeographic", "v-ideographic"],
      ["vMathematical", "v-mathematical"],
      ["vectorEffect", "vector-effect"],
      ["vertAdvY", "vert-adv-y"],
      ["vertOriginX", "vert-origin-x"],
      ["vertOriginY", "vert-origin-y"],
      ["wordSpacing", "word-spacing"],
      ["writingMode", "writing-mode"],
      ["xmlnsXlink", "xmlns:xlink"],
      ["xHeight", "x-height"],
    ]),
    matchHtmlRegExp = /["'&<>]/;
  function escapeTextForBrowser(text) {
    if ("boolean" === typeof text || "number" === typeof text || "bigint" === typeof text)
      return "" + text;
    text = "" + text;
    var match = matchHtmlRegExp.exec(text);
    if (match) {
      var html = "",
        index,
        lastIndex = 0;
      for (index = match.index; index < text.length; index++) {
        switch (text.charCodeAt(index)) {
          case 34:
            match = "&quot;";
            break;
          case 38:
            match = "&amp;";
            break;
          case 39:
            match = "&#x27;";
            break;
          case 60:
            match = "&lt;";
            break;
          case 62:
            match = "&gt;";
            break;
          default:
            continue;
        }
        lastIndex !== index && (html += text.slice(lastIndex, index));
        lastIndex = index + 1;
        html += match;
      }
      text = lastIndex !== index ? html + text.slice(lastIndex, index) : html;
    }
    return text;
  }
  var uppercasePattern = /([A-Z])/g,
    msPattern = /^ms-/,
    isJavaScriptProtocol =
      /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function sanitizeURL(url) {
    return isJavaScriptProtocol.test("" + url)
      ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
      : url;
  }
  var ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    ReactDOMSharedInternals = ReactDOM.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    sharedNotPendingObject = {
      pending: !1,
      data: null,
      method: null,
      action: null,
    },
    previousDispatcher = ReactDOMSharedInternals.d;
  ReactDOMSharedInternals.d = {
    f: previousDispatcher.f,
    r: previousDispatcher.r,
    D: prefetchDNS,
    C: preconnect,
    L: preload,
    m: preloadModule,
    X: preinitScript,
    S: preinitStyle,
    M: preinitModuleScript,
  };
  var PRELOAD_NO_CREDS = [],
    currentlyFlushingRenderState = null;
  stringToPrecomputedChunk('"></template>');
  var startInlineScript = stringToPrecomputedChunk("<script"),
    endInlineScript = stringToPrecomputedChunk("<\/script>"),
    startScriptSrc = stringToPrecomputedChunk('<script src="'),
    startModuleSrc = stringToPrecomputedChunk('<script type="module" src="'),
    scriptNonce = stringToPrecomputedChunk(' nonce="'),
    scriptIntegirty = stringToPrecomputedChunk(' integrity="'),
    scriptCrossOrigin = stringToPrecomputedChunk(' crossorigin="'),
    endAsyncScript = stringToPrecomputedChunk(' async=""><\/script>'),
    startInlineStyle = stringToPrecomputedChunk("<style"),
    scriptRegex = /(<\/|<)(s)(cript)/gi;
  function scriptReplacer(match, prefix, s, suffix) {
    return "" + prefix + ("s" === s ? "\\u0073" : "\\u0053") + suffix;
  }
  var importMapScriptStart = stringToPrecomputedChunk('<script type="importmap">'),
    importMapScriptEnd = stringToPrecomputedChunk("<\/script>");
  function createRenderState(
    resumableState,
    nonce,
    externalRuntimeConfig,
    importMap,
    onHeaders,
    maxHeadersLength,
  ) {
    externalRuntimeConfig = "string" === typeof nonce ? nonce : nonce && nonce.script;
    var inlineScriptWithNonce =
        void 0 === externalRuntimeConfig
          ? startInlineScript
          : stringToPrecomputedChunk(
              '<script nonce="' + escapeTextForBrowser(externalRuntimeConfig) + '"',
            ),
      nonceStyle = "string" === typeof nonce ? void 0 : nonce && nonce.style,
      inlineStyleWithNonce =
        void 0 === nonceStyle
          ? startInlineStyle
          : stringToPrecomputedChunk('<style nonce="' + escapeTextForBrowser(nonceStyle) + '"'),
      idPrefix = resumableState.idPrefix,
      bootstrapChunks = [],
      bootstrapScriptContent = resumableState.bootstrapScriptContent,
      bootstrapScripts = resumableState.bootstrapScripts,
      bootstrapModules = resumableState.bootstrapModules;
    void 0 !== bootstrapScriptContent &&
      (bootstrapChunks.push(inlineScriptWithNonce),
      pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
      bootstrapChunks.push(
        endOfStartTag,
        stringToChunk(("" + bootstrapScriptContent).replace(scriptRegex, scriptReplacer)),
        endInlineScript,
      ));
    bootstrapScriptContent = [];
    void 0 !== importMap &&
      (bootstrapScriptContent.push(importMapScriptStart),
      bootstrapScriptContent.push(
        stringToChunk(("" + JSON.stringify(importMap)).replace(scriptRegex, scriptReplacer)),
      ),
      bootstrapScriptContent.push(importMapScriptEnd));
    importMap = onHeaders
      ? {
          preconnects: "",
          fontPreloads: "",
          highImagePreloads: "",
          remainingCapacity: 2 + ("number" === typeof maxHeadersLength ? maxHeadersLength : 2e3),
        }
      : null;
    onHeaders = {
      placeholderPrefix: stringToPrecomputedChunk(idPrefix + "P:"),
      segmentPrefix: stringToPrecomputedChunk(idPrefix + "S:"),
      boundaryPrefix: stringToPrecomputedChunk(idPrefix + "B:"),
      startInlineScript: inlineScriptWithNonce,
      startInlineStyle: inlineStyleWithNonce,
      preamble: createPreambleState(),
      externalRuntimeScript: null,
      bootstrapChunks,
      importMapChunks: bootstrapScriptContent,
      onHeaders,
      headers: importMap,
      resets: {
        font: {},
        dns: {},
        connect: {
          default: {},
          anonymous: {},
          credentials: {},
        },
        image: {},
        style: {},
      },
      charsetChunks: [],
      viewportChunks: [],
      hoistableChunks: [],
      preconnects: /* @__PURE__ */ new Set(),
      fontPreloads: /* @__PURE__ */ new Set(),
      highImagePreloads: /* @__PURE__ */ new Set(),
      styles: /* @__PURE__ */ new Map(),
      bootstrapScripts: /* @__PURE__ */ new Set(),
      scripts: /* @__PURE__ */ new Set(),
      bulkPreloads: /* @__PURE__ */ new Set(),
      preloads: {
        images: /* @__PURE__ */ new Map(),
        stylesheets: /* @__PURE__ */ new Map(),
        scripts: /* @__PURE__ */ new Map(),
        moduleScripts: /* @__PURE__ */ new Map(),
      },
      nonce: {
        script: externalRuntimeConfig,
        style: nonceStyle,
      },
      hoistableState: null,
      stylesToHoist: !1,
    };
    if (void 0 !== bootstrapScripts)
      for (importMap = 0; importMap < bootstrapScripts.length; importMap++)
        ((idPrefix = bootstrapScripts[importMap]),
          (nonceStyle = inlineScriptWithNonce = void 0),
          (inlineStyleWithNonce = {
            rel: "preload",
            as: "script",
            fetchPriority: "low",
            nonce,
          }),
          "string" === typeof idPrefix
            ? (inlineStyleWithNonce.href = maxHeadersLength = idPrefix)
            : ((inlineStyleWithNonce.href = maxHeadersLength = idPrefix.src),
              (inlineStyleWithNonce.integrity = nonceStyle =
                "string" === typeof idPrefix.integrity ? idPrefix.integrity : void 0),
              (inlineStyleWithNonce.crossOrigin = inlineScriptWithNonce =
                "string" === typeof idPrefix || null == idPrefix.crossOrigin
                  ? void 0
                  : "use-credentials" === idPrefix.crossOrigin
                    ? "use-credentials"
                    : "")),
          (idPrefix = resumableState),
          (bootstrapScriptContent = maxHeadersLength),
          (idPrefix.scriptResources[bootstrapScriptContent] = null),
          (idPrefix.moduleScriptResources[bootstrapScriptContent] = null),
          (idPrefix = []),
          pushLinkImpl(idPrefix, inlineStyleWithNonce),
          onHeaders.bootstrapScripts.add(idPrefix),
          bootstrapChunks.push(
            startScriptSrc,
            stringToChunk(escapeTextForBrowser(maxHeadersLength)),
            attributeEnd,
          ),
          externalRuntimeConfig &&
            bootstrapChunks.push(
              scriptNonce,
              stringToChunk(escapeTextForBrowser(externalRuntimeConfig)),
              attributeEnd,
            ),
          "string" === typeof nonceStyle &&
            bootstrapChunks.push(
              scriptIntegirty,
              stringToChunk(escapeTextForBrowser(nonceStyle)),
              attributeEnd,
            ),
          "string" === typeof inlineScriptWithNonce &&
            bootstrapChunks.push(
              scriptCrossOrigin,
              stringToChunk(escapeTextForBrowser(inlineScriptWithNonce)),
              attributeEnd,
            ),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(endAsyncScript));
    if (void 0 !== bootstrapModules)
      for (nonce = 0; nonce < bootstrapModules.length; nonce++)
        ((nonceStyle = bootstrapModules[nonce]),
          (maxHeadersLength = importMap = void 0),
          (inlineScriptWithNonce = {
            rel: "modulepreload",
            fetchPriority: "low",
            nonce: externalRuntimeConfig,
          }),
          "string" === typeof nonceStyle
            ? (inlineScriptWithNonce.href = bootstrapScripts = nonceStyle)
            : ((inlineScriptWithNonce.href = bootstrapScripts = nonceStyle.src),
              (inlineScriptWithNonce.integrity = maxHeadersLength =
                "string" === typeof nonceStyle.integrity ? nonceStyle.integrity : void 0),
              (inlineScriptWithNonce.crossOrigin = importMap =
                "string" === typeof nonceStyle || null == nonceStyle.crossOrigin
                  ? void 0
                  : "use-credentials" === nonceStyle.crossOrigin
                    ? "use-credentials"
                    : "")),
          (nonceStyle = resumableState),
          (inlineStyleWithNonce = bootstrapScripts),
          (nonceStyle.scriptResources[inlineStyleWithNonce] = null),
          (nonceStyle.moduleScriptResources[inlineStyleWithNonce] = null),
          (nonceStyle = []),
          pushLinkImpl(nonceStyle, inlineScriptWithNonce),
          onHeaders.bootstrapScripts.add(nonceStyle),
          bootstrapChunks.push(
            startModuleSrc,
            stringToChunk(escapeTextForBrowser(bootstrapScripts)),
            attributeEnd,
          ),
          externalRuntimeConfig &&
            bootstrapChunks.push(
              scriptNonce,
              stringToChunk(escapeTextForBrowser(externalRuntimeConfig)),
              attributeEnd,
            ),
          "string" === typeof maxHeadersLength &&
            bootstrapChunks.push(
              scriptIntegirty,
              stringToChunk(escapeTextForBrowser(maxHeadersLength)),
              attributeEnd,
            ),
          "string" === typeof importMap &&
            bootstrapChunks.push(
              scriptCrossOrigin,
              stringToChunk(escapeTextForBrowser(importMap)),
              attributeEnd,
            ),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(endAsyncScript));
    return onHeaders;
  }
  function createResumableState(
    identifierPrefix,
    externalRuntimeConfig,
    bootstrapScriptContent,
    bootstrapScripts,
    bootstrapModules,
  ) {
    return {
      idPrefix: void 0 === identifierPrefix ? "" : identifierPrefix,
      nextFormID: 0,
      streamingFormat: 0,
      bootstrapScriptContent,
      bootstrapScripts,
      bootstrapModules,
      instructions: 0,
      hasBody: !1,
      hasHtml: !1,
      unknownResources: {},
      dnsResources: {},
      connectResources: {
        default: {},
        anonymous: {},
        credentials: {},
      },
      imageResources: {},
      styleResources: {},
      scriptResources: {},
      moduleUnknownResources: {},
      moduleScriptResources: {},
    };
  }
  function createPreambleState() {
    return {
      htmlChunks: null,
      headChunks: null,
      bodyChunks: null,
    };
  }
  function createFormatContext(insertionMode, selectedValue, tagScope, viewTransition) {
    return {
      insertionMode,
      selectedValue,
      tagScope,
      viewTransition,
    };
  }
  function createRootFormatContext(namespaceURI) {
    return createFormatContext(
      "http://www.w3.org/2000/svg" === namespaceURI
        ? 4
        : "http://www.w3.org/1998/Math/MathML" === namespaceURI
          ? 5
          : 0,
      null,
      0,
      null,
    );
  }
  function getChildFormatContext(parentContext, type, props) {
    var subtreeScope = parentContext.tagScope & -25;
    switch (type) {
      case "noscript":
        return createFormatContext(2, null, subtreeScope | 1, null);
      case "select":
        return createFormatContext(
          2,
          null != props.value ? props.value : props.defaultValue,
          subtreeScope,
          null,
        );
      case "svg":
        return createFormatContext(4, null, subtreeScope, null);
      case "picture":
        return createFormatContext(2, null, subtreeScope | 2, null);
      case "math":
        return createFormatContext(5, null, subtreeScope, null);
      case "foreignObject":
        return createFormatContext(2, null, subtreeScope, null);
      case "table":
        return createFormatContext(6, null, subtreeScope, null);
      case "thead":
      case "tbody":
      case "tfoot":
        return createFormatContext(7, null, subtreeScope, null);
      case "colgroup":
        return createFormatContext(9, null, subtreeScope, null);
      case "tr":
        return createFormatContext(8, null, subtreeScope, null);
      case "head":
        if (2 > parentContext.insertionMode)
          return createFormatContext(3, null, subtreeScope, null);
        break;
      case "html":
        if (0 === parentContext.insertionMode)
          return createFormatContext(1, null, subtreeScope, null);
    }
    return 6 <= parentContext.insertionMode || 2 > parentContext.insertionMode
      ? createFormatContext(2, null, subtreeScope, null)
      : parentContext.tagScope !== subtreeScope
        ? createFormatContext(
            parentContext.insertionMode,
            parentContext.selectedValue,
            subtreeScope,
            null,
          )
        : parentContext;
  }
  function getSuspenseViewTransition(parentViewTransition) {
    return null === parentViewTransition
      ? null
      : {
          update: parentViewTransition.update,
          enter: "none",
          exit: "none",
          share: parentViewTransition.update,
          name: parentViewTransition.autoName,
          autoName: parentViewTransition.autoName,
          nameIdx: 0,
        };
  }
  function getSuspenseFallbackFormatContext(resumableState, parentContext) {
    parentContext.tagScope & 32 && (resumableState.instructions |= 128);
    return createFormatContext(
      parentContext.insertionMode,
      parentContext.selectedValue,
      parentContext.tagScope | 12,
      getSuspenseViewTransition(parentContext.viewTransition),
    );
  }
  function getSuspenseContentFormatContext(resumableState, parentContext) {
    resumableState = getSuspenseViewTransition(parentContext.viewTransition);
    var subtreeScope = parentContext.tagScope | 16;
    null !== resumableState && "none" !== resumableState.share && (subtreeScope |= 64);
    return createFormatContext(
      parentContext.insertionMode,
      parentContext.selectedValue,
      subtreeScope,
      resumableState,
    );
  }
  var textSeparator = stringToPrecomputedChunk("<!-- -->");
  function pushTextInstance(target, text, renderState, textEmbedded) {
    if ("" === text) return textEmbedded;
    textEmbedded && target.push(textSeparator);
    target.push(stringToChunk(escapeTextForBrowser(text)));
    return !0;
  }
  var styleNameCache = /* @__PURE__ */ new Map(),
    styleAttributeStart = stringToPrecomputedChunk(' style="'),
    styleAssign = stringToPrecomputedChunk(":"),
    styleSeparator = stringToPrecomputedChunk(";");
  function pushStyleAttribute(target, style) {
    if ("object" !== typeof style)
      throw Error(
        "The `style` prop expects a mapping from style properties to values, not a string. For example, style={{marginRight: spacing + 'em'}} when using JSX.",
      );
    var isFirst = !0,
      styleName;
    for (styleName in style)
      if (hasOwnProperty.call(style, styleName)) {
        var styleValue = style[styleName];
        if (null != styleValue && "boolean" !== typeof styleValue && "" !== styleValue) {
          if (0 === styleName.indexOf("--")) {
            var nameChunk = stringToChunk(escapeTextForBrowser(styleName));
            styleValue = stringToChunk(escapeTextForBrowser(("" + styleValue).trim()));
          } else
            ((nameChunk = styleNameCache.get(styleName)),
              void 0 === nameChunk &&
                ((nameChunk = stringToPrecomputedChunk(
                  escapeTextForBrowser(
                    styleName
                      .replace(uppercasePattern, "-$1")
                      .toLowerCase()
                      .replace(msPattern, "-ms-"),
                  ),
                )),
                styleNameCache.set(styleName, nameChunk)),
              (styleValue =
                "number" === typeof styleValue
                  ? 0 === styleValue || unitlessNumbers.has(styleName)
                    ? stringToChunk("" + styleValue)
                    : stringToChunk(styleValue + "px")
                  : stringToChunk(escapeTextForBrowser(("" + styleValue).trim()))));
          isFirst
            ? ((isFirst = !1), target.push(styleAttributeStart, nameChunk, styleAssign, styleValue))
            : target.push(styleSeparator, nameChunk, styleAssign, styleValue);
        }
      }
    isFirst || target.push(attributeEnd);
  }
  var attributeSeparator = stringToPrecomputedChunk(" "),
    attributeAssign = stringToPrecomputedChunk('="'),
    attributeEnd = stringToPrecomputedChunk('"'),
    attributeEmptyString = stringToPrecomputedChunk('=""');
  function pushBooleanAttribute(target, name, value) {
    value &&
      "function" !== typeof value &&
      "symbol" !== typeof value &&
      target.push(attributeSeparator, stringToChunk(name), attributeEmptyString);
  }
  function pushStringAttribute(target, name, value) {
    "function" !== typeof value &&
      "symbol" !== typeof value &&
      "boolean" !== typeof value &&
      target.push(
        attributeSeparator,
        stringToChunk(name),
        attributeAssign,
        stringToChunk(escapeTextForBrowser(value)),
        attributeEnd,
      );
  }
  var actionJavaScriptURL = stringToPrecomputedChunk(
      escapeTextForBrowser("javascript:throw new Error('React form unexpectedly submitted.')"),
    ),
    startHiddenInputChunk = stringToPrecomputedChunk('<input type="hidden"');
  function pushAdditionalFormField(value, key) {
    this.push(startHiddenInputChunk);
    validateAdditionalFormField(value);
    pushStringAttribute(this, "name", key);
    pushStringAttribute(this, "value", value);
    this.push(endOfStartTagSelfClosing);
  }
  function validateAdditionalFormField(value) {
    if ("string" !== typeof value)
      throw Error(
        "File/Blob fields are not yet supported in progressive forms. Will fallback to client hydration.",
      );
  }
  function getCustomFormFields(resumableState, formAction) {
    if ("function" === typeof formAction.$$FORM_ACTION) {
      var id = resumableState.nextFormID++;
      resumableState = resumableState.idPrefix + id;
      try {
        var customFields = formAction.$$FORM_ACTION(resumableState);
        if (customFields) customFields.data?.forEach(validateAdditionalFormField);
        return customFields;
      } catch (x) {
        if ("object" === typeof x && null !== x && "function" === typeof x.then) throw x;
      }
    }
    return null;
  }
  function pushFormActionAttribute(
    target,
    resumableState,
    renderState,
    formAction,
    formEncType,
    formMethod,
    formTarget,
    name,
  ) {
    var formData = null;
    if ("function" === typeof formAction) {
      var customFields = getCustomFormFields(resumableState, formAction);
      null !== customFields
        ? ((name = customFields.name),
          (formAction = customFields.action || ""),
          (formEncType = customFields.encType),
          (formMethod = customFields.method),
          (formTarget = customFields.target),
          (formData = customFields.data))
        : (target.push(
            attributeSeparator,
            stringToChunk("formAction"),
            attributeAssign,
            actionJavaScriptURL,
            attributeEnd,
          ),
          (formTarget = formMethod = formEncType = formAction = name = null),
          injectFormReplayingRuntime(resumableState, renderState));
    }
    null != name && pushAttribute(target, "name", name);
    null != formAction && pushAttribute(target, "formAction", formAction);
    null != formEncType && pushAttribute(target, "formEncType", formEncType);
    null != formMethod && pushAttribute(target, "formMethod", formMethod);
    null != formTarget && pushAttribute(target, "formTarget", formTarget);
    return formData;
  }
  function pushAttribute(target, name, value) {
    switch (name) {
      case "className":
        pushStringAttribute(target, "class", value);
        break;
      case "tabIndex":
        pushStringAttribute(target, "tabindex", value);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        pushStringAttribute(target, name, value);
        break;
      case "style":
        pushStyleAttribute(target, value);
        break;
      case "src":
      case "href":
        if ("" === value) break;
      case "action":
      case "formAction":
        if (
          null == value ||
          "function" === typeof value ||
          "symbol" === typeof value ||
          "boolean" === typeof value
        )
          break;
        value = sanitizeURL("" + value);
        target.push(
          attributeSeparator,
          stringToChunk(name),
          attributeAssign,
          stringToChunk(escapeTextForBrowser(value)),
          attributeEnd,
        );
        break;
      case "defaultValue":
      case "defaultChecked":
      case "innerHTML":
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "ref":
        break;
      case "autoFocus":
      case "multiple":
      case "muted":
        pushBooleanAttribute(target, name.toLowerCase(), value);
        break;
      case "xlinkHref":
        if ("function" === typeof value || "symbol" === typeof value || "boolean" === typeof value)
          break;
        value = sanitizeURL("" + value);
        target.push(
          attributeSeparator,
          stringToChunk("xlink:href"),
          attributeAssign,
          stringToChunk(escapeTextForBrowser(value)),
          attributeEnd,
        );
        break;
      case "contentEditable":
      case "spellCheck":
      case "draggable":
      case "value":
      case "autoReverse":
      case "externalResourcesRequired":
      case "focusable":
      case "preserveAlpha":
        "function" !== typeof value &&
          "symbol" !== typeof value &&
          target.push(
            attributeSeparator,
            stringToChunk(name),
            attributeAssign,
            stringToChunk(escapeTextForBrowser(value)),
            attributeEnd,
          );
        break;
      case "inert":
      case "allowFullScreen":
      case "async":
      case "autoPlay":
      case "controls":
      case "default":
      case "defer":
      case "disabled":
      case "disablePictureInPicture":
      case "disableRemotePlayback":
      case "formNoValidate":
      case "hidden":
      case "loop":
      case "noModule":
      case "noValidate":
      case "open":
      case "playsInline":
      case "readOnly":
      case "required":
      case "reversed":
      case "scoped":
      case "seamless":
      case "itemScope":
        value &&
          "function" !== typeof value &&
          "symbol" !== typeof value &&
          target.push(attributeSeparator, stringToChunk(name), attributeEmptyString);
        break;
      case "capture":
      case "download":
        !0 === value
          ? target.push(attributeSeparator, stringToChunk(name), attributeEmptyString)
          : !1 !== value &&
            "function" !== typeof value &&
            "symbol" !== typeof value &&
            target.push(
              attributeSeparator,
              stringToChunk(name),
              attributeAssign,
              stringToChunk(escapeTextForBrowser(value)),
              attributeEnd,
            );
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        "function" !== typeof value &&
          "symbol" !== typeof value &&
          !isNaN(value) &&
          1 <= value &&
          target.push(
            attributeSeparator,
            stringToChunk(name),
            attributeAssign,
            stringToChunk(escapeTextForBrowser(value)),
            attributeEnd,
          );
        break;
      case "rowSpan":
      case "start":
        "function" === typeof value ||
          "symbol" === typeof value ||
          isNaN(value) ||
          target.push(
            attributeSeparator,
            stringToChunk(name),
            attributeAssign,
            stringToChunk(escapeTextForBrowser(value)),
            attributeEnd,
          );
        break;
      case "xlinkActuate":
        pushStringAttribute(target, "xlink:actuate", value);
        break;
      case "xlinkArcrole":
        pushStringAttribute(target, "xlink:arcrole", value);
        break;
      case "xlinkRole":
        pushStringAttribute(target, "xlink:role", value);
        break;
      case "xlinkShow":
        pushStringAttribute(target, "xlink:show", value);
        break;
      case "xlinkTitle":
        pushStringAttribute(target, "xlink:title", value);
        break;
      case "xlinkType":
        pushStringAttribute(target, "xlink:type", value);
        break;
      case "xmlBase":
        pushStringAttribute(target, "xml:base", value);
        break;
      case "xmlLang":
        pushStringAttribute(target, "xml:lang", value);
        break;
      case "xmlSpace":
        pushStringAttribute(target, "xml:space", value);
        break;
      default:
        if (
          !(2 < name.length) ||
          ("o" !== name[0] && "O" !== name[0]) ||
          ("n" !== name[1] && "N" !== name[1])
        ) {
          if (((name = aliases.get(name) || name), isAttributeNameSafe(name))) {
            switch (typeof value) {
              case "function":
              case "symbol":
                return;
              case "boolean":
                var prefix$8 = name.toLowerCase().slice(0, 5);
                if ("data-" !== prefix$8 && "aria-" !== prefix$8) return;
            }
            target.push(
              attributeSeparator,
              stringToChunk(name),
              attributeAssign,
              stringToChunk(escapeTextForBrowser(value)),
              attributeEnd,
            );
          }
        }
    }
  }
  var endOfStartTag = stringToPrecomputedChunk(">"),
    endOfStartTagSelfClosing = stringToPrecomputedChunk("/>");
  function pushInnerHTML(target, innerHTML, children) {
    if (null != innerHTML) {
      if (null != children)
        throw Error("Can only set one of `children` or `props.dangerouslySetInnerHTML`.");
      if ("object" !== typeof innerHTML || !("__html" in innerHTML))
        throw Error(
          "`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.",
        );
      innerHTML = innerHTML.__html;
      null !== innerHTML && void 0 !== innerHTML && target.push(stringToChunk("" + innerHTML));
    }
  }
  function flattenOptionChildren(children) {
    var content = "";
    React.Children.forEach(children, function (child) {
      null != child && (content += child);
    });
    return content;
  }
  var selectedMarkerAttribute = stringToPrecomputedChunk(' selected=""'),
    formReplayingRuntimeScript = stringToPrecomputedChunk(
      'addEventListener("submit",function(a){if(!a.defaultPrevented){var c=a.target,d=a.submitter,e=c.action,b=d;if(d){var f=d.getAttribute("formAction");null!=f&&(e=f,b=null)}"javascript:throw new Error(\'React form unexpectedly submitted.\')"===e&&(a.preventDefault(),b?(a=document.createElement("input"),a.name=b.name,a.value=b.value,b.parentNode.insertBefore(a,b),b=new FormData(c),a.parentNode.removeChild(a)):b=new FormData(c),a=c.ownerDocument||c,(a.$$reactFormReplay=a.$$reactFormReplay||[]).push(c,d,b))}});',
    );
  function injectFormReplayingRuntime(resumableState, renderState) {
    if (0 === (resumableState.instructions & 16)) {
      resumableState.instructions |= 16;
      var preamble = renderState.preamble,
        bootstrapChunks = renderState.bootstrapChunks;
      (preamble.htmlChunks || preamble.headChunks) && 0 === bootstrapChunks.length
        ? (bootstrapChunks.push(renderState.startInlineScript),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(endOfStartTag, formReplayingRuntimeScript, endInlineScript))
        : bootstrapChunks.unshift(
            renderState.startInlineScript,
            endOfStartTag,
            formReplayingRuntimeScript,
            endInlineScript,
          );
    }
  }
  var formStateMarkerIsMatching = stringToPrecomputedChunk("<!--F!-->"),
    formStateMarkerIsNotMatching = stringToPrecomputedChunk("<!--F-->");
  function pushLinkImpl(target, props) {
    target.push(startChunkForTag("link"));
    for (var propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
            case "dangerouslySetInnerHTML":
              throw Error(
                "link is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
              );
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTagSelfClosing);
    return null;
  }
  var styleRegex = /(<\/|<)(s)(tyle)/gi;
  function styleReplacer(match, prefix, s, suffix) {
    return "" + prefix + ("s" === s ? "\\73 " : "\\53 ") + suffix;
  }
  function pushSelfClosing(target, props, tag) {
    target.push(startChunkForTag(tag));
    for (var propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
            case "dangerouslySetInnerHTML":
              throw Error(
                tag +
                  " is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
              );
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTagSelfClosing);
    return null;
  }
  function pushTitleImpl(target, props) {
    target.push(startChunkForTag("title"));
    var children = null,
      innerHTML = null,
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              children = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    props = Array.isArray(children) ? (2 > children.length ? children[0] : null) : children;
    "function" !== typeof props &&
      "symbol" !== typeof props &&
      null !== props &&
      void 0 !== props &&
      target.push(stringToChunk(escapeTextForBrowser("" + props)));
    pushInnerHTML(target, innerHTML, children);
    target.push(endChunkForTag("title"));
    return null;
  }
  var headPreambleContributionChunk = stringToPrecomputedChunk("<!--head-->"),
    bodyPreambleContributionChunk = stringToPrecomputedChunk("<!--body-->"),
    htmlPreambleContributionChunk = stringToPrecomputedChunk("<!--html-->");
  function pushScriptImpl(target, props) {
    target.push(startChunkForTag("script"));
    var children = null,
      innerHTML = null,
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              children = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    pushInnerHTML(target, innerHTML, children);
    "string" === typeof children &&
      target.push(stringToChunk(("" + children).replace(scriptRegex, scriptReplacer)));
    target.push(endChunkForTag("script"));
    return null;
  }
  function pushStartSingletonElement(target, props, tag) {
    target.push(startChunkForTag(tag));
    var innerHTML = (tag = null),
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              tag = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    pushInnerHTML(target, innerHTML, tag);
    return tag;
  }
  function pushStartGenericElement(target, props, tag) {
    target.push(startChunkForTag(tag));
    var innerHTML = (tag = null),
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              tag = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    pushInnerHTML(target, innerHTML, tag);
    return "string" === typeof tag
      ? (target.push(stringToChunk(escapeTextForBrowser(tag))), null)
      : tag;
  }
  var leadingNewline = stringToPrecomputedChunk("\n"),
    VALID_TAG_REGEX = /^[a-zA-Z][a-zA-Z:_\.\-\d]*$/,
    validatedTagCache = /* @__PURE__ */ new Map();
  function startChunkForTag(tag) {
    var tagStartChunk = validatedTagCache.get(tag);
    if (void 0 === tagStartChunk) {
      if (!VALID_TAG_REGEX.test(tag)) throw Error("Invalid tag: " + tag);
      tagStartChunk = stringToPrecomputedChunk("<" + tag);
      validatedTagCache.set(tag, tagStartChunk);
    }
    return tagStartChunk;
  }
  var doctypeChunk = stringToPrecomputedChunk("<!DOCTYPE html>");
  function pushStartInstance(
    target$jscomp$0,
    type,
    props,
    resumableState,
    renderState,
    preambleState,
    hoistableState,
    formatContext,
    textEmbedded,
  ) {
    switch (type) {
      case "div":
      case "span":
      case "svg":
      case "path":
        break;
      case "a":
        target$jscomp$0.push(startChunkForTag("a"));
        var children = null,
          innerHTML = null,
          propKey;
        for (propKey in props)
          if (hasOwnProperty.call(props, propKey)) {
            var propValue = props[propKey];
            if (null != propValue)
              switch (propKey) {
                case "children":
                  children = propValue;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML = propValue;
                  break;
                case "href":
                  "" === propValue
                    ? pushStringAttribute(target$jscomp$0, "href", "")
                    : pushAttribute(target$jscomp$0, propKey, propValue);
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey, propValue);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML, children);
        if ("string" === typeof children) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children)));
          var JSCompiler_inline_result = null;
        } else JSCompiler_inline_result = children;
        return JSCompiler_inline_result;
      case "g":
      case "p":
      case "li":
        break;
      case "select":
        target$jscomp$0.push(startChunkForTag("select"));
        var children$jscomp$0 = null,
          innerHTML$jscomp$0 = null,
          propKey$jscomp$0;
        for (propKey$jscomp$0 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$0)) {
            var propValue$jscomp$0 = props[propKey$jscomp$0];
            if (null != propValue$jscomp$0)
              switch (propKey$jscomp$0) {
                case "children":
                  children$jscomp$0 = propValue$jscomp$0;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$0 = propValue$jscomp$0;
                  break;
                case "defaultValue":
                case "value":
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$0, propValue$jscomp$0);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$0, children$jscomp$0);
        return children$jscomp$0;
      case "option":
        var selectedValue = formatContext.selectedValue;
        target$jscomp$0.push(startChunkForTag("option"));
        var children$jscomp$1 = null,
          value = null,
          selected = null,
          innerHTML$jscomp$1 = null,
          propKey$jscomp$1;
        for (propKey$jscomp$1 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$1)) {
            var propValue$jscomp$1 = props[propKey$jscomp$1];
            if (null != propValue$jscomp$1)
              switch (propKey$jscomp$1) {
                case "children":
                  children$jscomp$1 = propValue$jscomp$1;
                  break;
                case "selected":
                  selected = propValue$jscomp$1;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$1 = propValue$jscomp$1;
                  break;
                case "value":
                  value = propValue$jscomp$1;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$1, propValue$jscomp$1);
              }
          }
        if (null != selectedValue) {
          var stringValue = null !== value ? "" + value : flattenOptionChildren(children$jscomp$1);
          if (isArrayImpl(selectedValue)) {
            for (var i = 0; i < selectedValue.length; i++)
              if ("" + selectedValue[i] === stringValue) {
                target$jscomp$0.push(selectedMarkerAttribute);
                break;
              }
          } else
            "" + selectedValue === stringValue && target$jscomp$0.push(selectedMarkerAttribute);
        } else selected && target$jscomp$0.push(selectedMarkerAttribute);
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$1, children$jscomp$1);
        return children$jscomp$1;
      case "textarea":
        target$jscomp$0.push(startChunkForTag("textarea"));
        var value$jscomp$0 = null,
          defaultValue = null,
          children$jscomp$2 = null,
          propKey$jscomp$2;
        for (propKey$jscomp$2 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$2)) {
            var propValue$jscomp$2 = props[propKey$jscomp$2];
            if (null != propValue$jscomp$2)
              switch (propKey$jscomp$2) {
                case "children":
                  children$jscomp$2 = propValue$jscomp$2;
                  break;
                case "value":
                  value$jscomp$0 = propValue$jscomp$2;
                  break;
                case "defaultValue":
                  defaultValue = propValue$jscomp$2;
                  break;
                case "dangerouslySetInnerHTML":
                  throw Error("`dangerouslySetInnerHTML` does not make sense on <textarea>.");
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$2, propValue$jscomp$2);
              }
          }
        null === value$jscomp$0 && null !== defaultValue && (value$jscomp$0 = defaultValue);
        target$jscomp$0.push(endOfStartTag);
        if (null != children$jscomp$2) {
          if (null != value$jscomp$0)
            throw Error("If you supply `defaultValue` on a <textarea>, do not pass children.");
          if (isArrayImpl(children$jscomp$2)) {
            if (1 < children$jscomp$2.length)
              throw Error("<textarea> can only have at most one child.");
            value$jscomp$0 = "" + children$jscomp$2[0];
          }
          value$jscomp$0 = "" + children$jscomp$2;
        }
        "string" === typeof value$jscomp$0 &&
          "\n" === value$jscomp$0[0] &&
          target$jscomp$0.push(leadingNewline);
        null !== value$jscomp$0 &&
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser("" + value$jscomp$0)));
        return null;
      case "input":
        target$jscomp$0.push(startChunkForTag("input"));
        var name = null,
          formAction = null,
          formEncType = null,
          formMethod = null,
          formTarget = null,
          value$jscomp$1 = null,
          defaultValue$jscomp$0 = null,
          checked = null,
          defaultChecked = null,
          propKey$jscomp$3;
        for (propKey$jscomp$3 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$3)) {
            var propValue$jscomp$3 = props[propKey$jscomp$3];
            if (null != propValue$jscomp$3)
              switch (propKey$jscomp$3) {
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(
                    "input is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
                  );
                case "name":
                  name = propValue$jscomp$3;
                  break;
                case "formAction":
                  formAction = propValue$jscomp$3;
                  break;
                case "formEncType":
                  formEncType = propValue$jscomp$3;
                  break;
                case "formMethod":
                  formMethod = propValue$jscomp$3;
                  break;
                case "formTarget":
                  formTarget = propValue$jscomp$3;
                  break;
                case "defaultChecked":
                  defaultChecked = propValue$jscomp$3;
                  break;
                case "defaultValue":
                  defaultValue$jscomp$0 = propValue$jscomp$3;
                  break;
                case "checked":
                  checked = propValue$jscomp$3;
                  break;
                case "value":
                  value$jscomp$1 = propValue$jscomp$3;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$3, propValue$jscomp$3);
              }
          }
        var formData = pushFormActionAttribute(
          target$jscomp$0,
          resumableState,
          renderState,
          formAction,
          formEncType,
          formMethod,
          formTarget,
          name,
        );
        null !== checked
          ? pushBooleanAttribute(target$jscomp$0, "checked", checked)
          : null !== defaultChecked &&
            pushBooleanAttribute(target$jscomp$0, "checked", defaultChecked);
        null !== value$jscomp$1
          ? pushAttribute(target$jscomp$0, "value", value$jscomp$1)
          : null !== defaultValue$jscomp$0 &&
            pushAttribute(target$jscomp$0, "value", defaultValue$jscomp$0);
        target$jscomp$0.push(endOfStartTagSelfClosing);
        formData?.forEach(pushAdditionalFormField, target$jscomp$0);
        return null;
      case "button":
        target$jscomp$0.push(startChunkForTag("button"));
        var children$jscomp$3 = null,
          innerHTML$jscomp$2 = null,
          name$jscomp$0 = null,
          formAction$jscomp$0 = null,
          formEncType$jscomp$0 = null,
          formMethod$jscomp$0 = null,
          formTarget$jscomp$0 = null,
          propKey$jscomp$4;
        for (propKey$jscomp$4 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$4)) {
            var propValue$jscomp$4 = props[propKey$jscomp$4];
            if (null != propValue$jscomp$4)
              switch (propKey$jscomp$4) {
                case "children":
                  children$jscomp$3 = propValue$jscomp$4;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$2 = propValue$jscomp$4;
                  break;
                case "name":
                  name$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formAction":
                  formAction$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formEncType":
                  formEncType$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formMethod":
                  formMethod$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formTarget":
                  formTarget$jscomp$0 = propValue$jscomp$4;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$4, propValue$jscomp$4);
              }
          }
        var formData$jscomp$0 = pushFormActionAttribute(
          target$jscomp$0,
          resumableState,
          renderState,
          formAction$jscomp$0,
          formEncType$jscomp$0,
          formMethod$jscomp$0,
          formTarget$jscomp$0,
          name$jscomp$0,
        );
        target$jscomp$0.push(endOfStartTag);
        formData$jscomp$0?.forEach(pushAdditionalFormField, target$jscomp$0);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$2, children$jscomp$3);
        if ("string" === typeof children$jscomp$3) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children$jscomp$3)));
          var JSCompiler_inline_result$jscomp$0 = null;
        } else JSCompiler_inline_result$jscomp$0 = children$jscomp$3;
        return JSCompiler_inline_result$jscomp$0;
      case "form":
        target$jscomp$0.push(startChunkForTag("form"));
        var children$jscomp$4 = null,
          innerHTML$jscomp$3 = null,
          formAction$jscomp$1 = null,
          formEncType$jscomp$1 = null,
          formMethod$jscomp$1 = null,
          formTarget$jscomp$1 = null,
          propKey$jscomp$5;
        for (propKey$jscomp$5 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$5)) {
            var propValue$jscomp$5 = props[propKey$jscomp$5];
            if (null != propValue$jscomp$5)
              switch (propKey$jscomp$5) {
                case "children":
                  children$jscomp$4 = propValue$jscomp$5;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$3 = propValue$jscomp$5;
                  break;
                case "action":
                  formAction$jscomp$1 = propValue$jscomp$5;
                  break;
                case "encType":
                  formEncType$jscomp$1 = propValue$jscomp$5;
                  break;
                case "method":
                  formMethod$jscomp$1 = propValue$jscomp$5;
                  break;
                case "target":
                  formTarget$jscomp$1 = propValue$jscomp$5;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$5, propValue$jscomp$5);
              }
          }
        var formData$jscomp$1 = null,
          formActionName = null;
        if ("function" === typeof formAction$jscomp$1) {
          var customFields = getCustomFormFields(resumableState, formAction$jscomp$1);
          null !== customFields
            ? ((formAction$jscomp$1 = customFields.action || ""),
              (formEncType$jscomp$1 = customFields.encType),
              (formMethod$jscomp$1 = customFields.method),
              (formTarget$jscomp$1 = customFields.target),
              (formData$jscomp$1 = customFields.data),
              (formActionName = customFields.name))
            : (target$jscomp$0.push(
                attributeSeparator,
                stringToChunk("action"),
                attributeAssign,
                actionJavaScriptURL,
                attributeEnd,
              ),
              (formTarget$jscomp$1 =
                formMethod$jscomp$1 =
                formEncType$jscomp$1 =
                formAction$jscomp$1 =
                  null),
              injectFormReplayingRuntime(resumableState, renderState));
        }
        null != formAction$jscomp$1 &&
          pushAttribute(target$jscomp$0, "action", formAction$jscomp$1);
        null != formEncType$jscomp$1 &&
          pushAttribute(target$jscomp$0, "encType", formEncType$jscomp$1);
        null != formMethod$jscomp$1 &&
          pushAttribute(target$jscomp$0, "method", formMethod$jscomp$1);
        null != formTarget$jscomp$1 &&
          pushAttribute(target$jscomp$0, "target", formTarget$jscomp$1);
        target$jscomp$0.push(endOfStartTag);
        null !== formActionName &&
          (target$jscomp$0.push(startHiddenInputChunk),
          pushStringAttribute(target$jscomp$0, "name", formActionName),
          target$jscomp$0.push(endOfStartTagSelfClosing),
          formData$jscomp$1?.forEach(pushAdditionalFormField, target$jscomp$0));
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$3, children$jscomp$4);
        if ("string" === typeof children$jscomp$4) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children$jscomp$4)));
          var JSCompiler_inline_result$jscomp$1 = null;
        } else JSCompiler_inline_result$jscomp$1 = children$jscomp$4;
        return JSCompiler_inline_result$jscomp$1;
      case "menuitem":
        target$jscomp$0.push(startChunkForTag("menuitem"));
        for (var propKey$jscomp$6 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$6)) {
            var propValue$jscomp$6 = props[propKey$jscomp$6];
            if (null != propValue$jscomp$6)
              switch (propKey$jscomp$6) {
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error("menuitems cannot have `children` nor `dangerouslySetInnerHTML`.");
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$6, propValue$jscomp$6);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        return null;
      case "object":
        target$jscomp$0.push(startChunkForTag("object"));
        var children$jscomp$5 = null,
          innerHTML$jscomp$4 = null,
          propKey$jscomp$7;
        for (propKey$jscomp$7 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$7)) {
            var propValue$jscomp$7 = props[propKey$jscomp$7];
            if (null != propValue$jscomp$7)
              switch (propKey$jscomp$7) {
                case "children":
                  children$jscomp$5 = propValue$jscomp$7;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$4 = propValue$jscomp$7;
                  break;
                case "data":
                  var sanitizedValue = sanitizeURL("" + propValue$jscomp$7);
                  if ("" === sanitizedValue) break;
                  target$jscomp$0.push(
                    attributeSeparator,
                    stringToChunk("data"),
                    attributeAssign,
                    stringToChunk(escapeTextForBrowser(sanitizedValue)),
                    attributeEnd,
                  );
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$7, propValue$jscomp$7);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$4, children$jscomp$5);
        if ("string" === typeof children$jscomp$5) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children$jscomp$5)));
          var JSCompiler_inline_result$jscomp$2 = null;
        } else JSCompiler_inline_result$jscomp$2 = children$jscomp$5;
        return JSCompiler_inline_result$jscomp$2;
      case "title":
        var noscriptTagInScope = formatContext.tagScope & 1,
          isFallback = formatContext.tagScope & 4;
        if (4 === formatContext.insertionMode || noscriptTagInScope || null != props.itemProp)
          var JSCompiler_inline_result$jscomp$3 = pushTitleImpl(target$jscomp$0, props);
        else
          isFallback
            ? (JSCompiler_inline_result$jscomp$3 = null)
            : (pushTitleImpl(renderState.hoistableChunks, props),
              (JSCompiler_inline_result$jscomp$3 = void 0));
        return JSCompiler_inline_result$jscomp$3;
      case "link":
        var noscriptTagInScope$jscomp$0 = formatContext.tagScope & 1,
          isFallback$jscomp$0 = formatContext.tagScope & 4,
          rel = props.rel,
          href = props.href,
          precedence = props.precedence;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$0 ||
          null != props.itemProp ||
          "string" !== typeof rel ||
          "string" !== typeof href ||
          "" === href
        ) {
          pushLinkImpl(target$jscomp$0, props);
          var JSCompiler_inline_result$jscomp$4 = null;
        } else if ("stylesheet" === props.rel)
          if (
            "string" !== typeof precedence ||
            null != props.disabled ||
            props.onLoad ||
            props.onError
          )
            JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props);
          else {
            var styleQueue = renderState.styles.get(precedence),
              resourceState = resumableState.styleResources.hasOwnProperty(href)
                ? resumableState.styleResources[href]
                : void 0;
            if (null !== resourceState) {
              resumableState.styleResources[href] = null;
              styleQueue ||
                ((styleQueue = {
                  precedence: stringToChunk(escapeTextForBrowser(precedence)),
                  rules: [],
                  hrefs: [],
                  sheets: /* @__PURE__ */ new Map(),
                }),
                renderState.styles.set(precedence, styleQueue));
              var resource = {
                state: 0,
                props: assign({}, props, {
                  "data-precedence": props.precedence,
                  precedence: null,
                }),
              };
              if (resourceState) {
                2 === resourceState.length &&
                  adoptPreloadCredentials(resource.props, resourceState);
                var preloadResource = renderState.preloads.stylesheets.get(href);
                preloadResource && 0 < preloadResource.length
                  ? (preloadResource.length = 0)
                  : (resource.state = 1);
              }
              styleQueue.sheets.set(href, resource);
              hoistableState && hoistableState.stylesheets.add(resource);
            } else if (styleQueue) {
              var resource$9 = styleQueue.sheets.get(href);
              resource$9 && hoistableState && hoistableState.stylesheets.add(resource$9);
            }
            textEmbedded && target$jscomp$0.push(textSeparator);
            JSCompiler_inline_result$jscomp$4 = null;
          }
        else
          props.onLoad || props.onError
            ? (JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props))
            : (textEmbedded && target$jscomp$0.push(textSeparator),
              (JSCompiler_inline_result$jscomp$4 = isFallback$jscomp$0
                ? null
                : pushLinkImpl(renderState.hoistableChunks, props)));
        return JSCompiler_inline_result$jscomp$4;
      case "script":
        var noscriptTagInScope$jscomp$1 = formatContext.tagScope & 1,
          asyncProp = props.async;
        if (
          "string" !== typeof props.src ||
          !props.src ||
          !asyncProp ||
          "function" === typeof asyncProp ||
          "symbol" === typeof asyncProp ||
          props.onLoad ||
          props.onError ||
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$1 ||
          null != props.itemProp
        )
          var JSCompiler_inline_result$jscomp$5 = pushScriptImpl(target$jscomp$0, props);
        else {
          var key = props.src;
          if ("module" === props.type) {
            var resources = resumableState.moduleScriptResources;
            var preloads = renderState.preloads.moduleScripts;
          } else
            ((resources = resumableState.scriptResources),
              (preloads = renderState.preloads.scripts));
          var resourceState$jscomp$0 = resources.hasOwnProperty(key) ? resources[key] : void 0;
          if (null !== resourceState$jscomp$0) {
            resources[key] = null;
            var scriptProps = props;
            if (resourceState$jscomp$0) {
              2 === resourceState$jscomp$0.length &&
                ((scriptProps = assign({}, props)),
                adoptPreloadCredentials(scriptProps, resourceState$jscomp$0));
              var preloadResource$jscomp$0 = preloads.get(key);
              preloadResource$jscomp$0 && (preloadResource$jscomp$0.length = 0);
            }
            var resource$jscomp$0 = [];
            renderState.scripts.add(resource$jscomp$0);
            pushScriptImpl(resource$jscomp$0, scriptProps);
          }
          textEmbedded && target$jscomp$0.push(textSeparator);
          JSCompiler_inline_result$jscomp$5 = null;
        }
        return JSCompiler_inline_result$jscomp$5;
      case "style":
        var noscriptTagInScope$jscomp$2 = formatContext.tagScope & 1,
          precedence$jscomp$0 = props.precedence,
          href$jscomp$0 = props.href,
          nonce = props.nonce;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$2 ||
          null != props.itemProp ||
          "string" !== typeof precedence$jscomp$0 ||
          "string" !== typeof href$jscomp$0 ||
          "" === href$jscomp$0
        ) {
          target$jscomp$0.push(startChunkForTag("style"));
          var children$jscomp$6 = null,
            innerHTML$jscomp$5 = null,
            propKey$jscomp$8;
          for (propKey$jscomp$8 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$8)) {
              var propValue$jscomp$8 = props[propKey$jscomp$8];
              if (null != propValue$jscomp$8)
                switch (propKey$jscomp$8) {
                  case "children":
                    children$jscomp$6 = propValue$jscomp$8;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$5 = propValue$jscomp$8;
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$8, propValue$jscomp$8);
                }
            }
          target$jscomp$0.push(endOfStartTag);
          var child = Array.isArray(children$jscomp$6)
            ? 2 > children$jscomp$6.length
              ? children$jscomp$6[0]
              : null
            : children$jscomp$6;
          "function" !== typeof child &&
            "symbol" !== typeof child &&
            null !== child &&
            void 0 !== child &&
            target$jscomp$0.push(stringToChunk(("" + child).replace(styleRegex, styleReplacer)));
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$5, children$jscomp$6);
          target$jscomp$0.push(endChunkForTag("style"));
          var JSCompiler_inline_result$jscomp$6 = null;
        } else {
          var styleQueue$jscomp$0 = renderState.styles.get(precedence$jscomp$0);
          if (
            null !==
            (resumableState.styleResources.hasOwnProperty(href$jscomp$0)
              ? resumableState.styleResources[href$jscomp$0]
              : void 0)
          ) {
            resumableState.styleResources[href$jscomp$0] = null;
            styleQueue$jscomp$0 ||
              ((styleQueue$jscomp$0 = {
                precedence: stringToChunk(escapeTextForBrowser(precedence$jscomp$0)),
                rules: [],
                hrefs: [],
                sheets: /* @__PURE__ */ new Map(),
              }),
              renderState.styles.set(precedence$jscomp$0, styleQueue$jscomp$0));
            var nonceStyle = renderState.nonce.style;
            if (!nonceStyle || nonceStyle === nonce) {
              styleQueue$jscomp$0.hrefs.push(stringToChunk(escapeTextForBrowser(href$jscomp$0)));
              var target = styleQueue$jscomp$0.rules,
                children$jscomp$7 = null,
                innerHTML$jscomp$6 = null,
                propKey$jscomp$9;
              for (propKey$jscomp$9 in props)
                if (hasOwnProperty.call(props, propKey$jscomp$9)) {
                  var propValue$jscomp$9 = props[propKey$jscomp$9];
                  if (null != propValue$jscomp$9)
                    switch (propKey$jscomp$9) {
                      case "children":
                        children$jscomp$7 = propValue$jscomp$9;
                        break;
                      case "dangerouslySetInnerHTML":
                        innerHTML$jscomp$6 = propValue$jscomp$9;
                    }
                }
              var child$jscomp$0 = Array.isArray(children$jscomp$7)
                ? 2 > children$jscomp$7.length
                  ? children$jscomp$7[0]
                  : null
                : children$jscomp$7;
              "function" !== typeof child$jscomp$0 &&
                "symbol" !== typeof child$jscomp$0 &&
                null !== child$jscomp$0 &&
                void 0 !== child$jscomp$0 &&
                target.push(
                  stringToChunk(("" + child$jscomp$0).replace(styleRegex, styleReplacer)),
                );
              pushInnerHTML(target, innerHTML$jscomp$6, children$jscomp$7);
            }
          }
          styleQueue$jscomp$0 && hoistableState && hoistableState.styles.add(styleQueue$jscomp$0);
          textEmbedded && target$jscomp$0.push(textSeparator);
          JSCompiler_inline_result$jscomp$6 = void 0;
        }
        return JSCompiler_inline_result$jscomp$6;
      case "meta":
        var noscriptTagInScope$jscomp$3 = formatContext.tagScope & 1,
          isFallback$jscomp$1 = formatContext.tagScope & 4;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$3 ||
          null != props.itemProp
        )
          var JSCompiler_inline_result$jscomp$7 = pushSelfClosing(target$jscomp$0, props, "meta");
        else
          (textEmbedded && target$jscomp$0.push(textSeparator),
            (JSCompiler_inline_result$jscomp$7 = isFallback$jscomp$1
              ? null
              : "string" === typeof props.charSet
                ? pushSelfClosing(renderState.charsetChunks, props, "meta")
                : "viewport" === props.name
                  ? pushSelfClosing(renderState.viewportChunks, props, "meta")
                  : pushSelfClosing(renderState.hoistableChunks, props, "meta")));
        return JSCompiler_inline_result$jscomp$7;
      case "listing":
      case "pre":
        target$jscomp$0.push(startChunkForTag(type));
        var children$jscomp$8 = null,
          innerHTML$jscomp$7 = null,
          propKey$jscomp$10;
        for (propKey$jscomp$10 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$10)) {
            var propValue$jscomp$10 = props[propKey$jscomp$10];
            if (null != propValue$jscomp$10)
              switch (propKey$jscomp$10) {
                case "children":
                  children$jscomp$8 = propValue$jscomp$10;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$7 = propValue$jscomp$10;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$10, propValue$jscomp$10);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        if (null != innerHTML$jscomp$7) {
          if (null != children$jscomp$8)
            throw Error("Can only set one of `children` or `props.dangerouslySetInnerHTML`.");
          if ("object" !== typeof innerHTML$jscomp$7 || !("__html" in innerHTML$jscomp$7))
            throw Error(
              "`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.",
            );
          var html = innerHTML$jscomp$7.__html;
          null !== html &&
            void 0 !== html &&
            ("string" === typeof html && 0 < html.length && "\n" === html[0]
              ? target$jscomp$0.push(leadingNewline, stringToChunk(html))
              : target$jscomp$0.push(stringToChunk("" + html)));
        }
        "string" === typeof children$jscomp$8 &&
          "\n" === children$jscomp$8[0] &&
          target$jscomp$0.push(leadingNewline);
        return children$jscomp$8;
      case "img":
        var pictureOrNoScriptTagInScope = formatContext.tagScope & 3,
          src = props.src,
          srcSet = props.srcSet;
        if (
          !(
            "lazy" === props.loading ||
            (!src && !srcSet) ||
            ("string" !== typeof src && null != src) ||
            ("string" !== typeof srcSet && null != srcSet) ||
            "low" === props.fetchPriority ||
            pictureOrNoScriptTagInScope
          ) &&
          ("string" !== typeof src ||
            ":" !== src[4] ||
            ("d" !== src[0] && "D" !== src[0]) ||
            ("a" !== src[1] && "A" !== src[1]) ||
            ("t" !== src[2] && "T" !== src[2]) ||
            ("a" !== src[3] && "A" !== src[3])) &&
          ("string" !== typeof srcSet ||
            ":" !== srcSet[4] ||
            ("d" !== srcSet[0] && "D" !== srcSet[0]) ||
            ("a" !== srcSet[1] && "A" !== srcSet[1]) ||
            ("t" !== srcSet[2] && "T" !== srcSet[2]) ||
            ("a" !== srcSet[3] && "A" !== srcSet[3]))
        ) {
          null !== hoistableState &&
            formatContext.tagScope & 64 &&
            (hoistableState.suspenseyImages = !0);
          var sizes = "string" === typeof props.sizes ? props.sizes : void 0,
            key$jscomp$0 = srcSet ? srcSet + "\n" + (sizes || "") : src,
            promotablePreloads = renderState.preloads.images,
            resource$jscomp$1 = promotablePreloads.get(key$jscomp$0);
          if (resource$jscomp$1) {
            if ("high" === props.fetchPriority || 10 > renderState.highImagePreloads.size)
              (promotablePreloads.delete(key$jscomp$0),
                renderState.highImagePreloads.add(resource$jscomp$1));
          } else if (!resumableState.imageResources.hasOwnProperty(key$jscomp$0)) {
            resumableState.imageResources[key$jscomp$0] = PRELOAD_NO_CREDS;
            var input = props.crossOrigin;
            var JSCompiler_inline_result$jscomp$8 =
              "string" === typeof input ? ("use-credentials" === input ? input : "") : void 0;
            var headers = renderState.headers,
              header;
            headers &&
            0 < headers.remainingCapacity &&
            "string" !== typeof props.srcSet &&
            ("high" === props.fetchPriority || 500 > headers.highImagePreloads.length) &&
            ((header = getPreloadAsHeader(src, "image", {
              imageSrcSet: props.srcSet,
              imageSizes: props.sizes,
              crossOrigin: JSCompiler_inline_result$jscomp$8,
              integrity: props.integrity,
              nonce: props.nonce,
              type: props.type,
              fetchPriority: props.fetchPriority,
              referrerPolicy: props.refererPolicy,
            })),
            0 <= (headers.remainingCapacity -= header.length + 2))
              ? ((renderState.resets.image[key$jscomp$0] = PRELOAD_NO_CREDS),
                headers.highImagePreloads && (headers.highImagePreloads += ", "),
                (headers.highImagePreloads += header))
              : ((resource$jscomp$1 = []),
                pushLinkImpl(resource$jscomp$1, {
                  rel: "preload",
                  as: "image",
                  href: srcSet ? void 0 : src,
                  imageSrcSet: srcSet,
                  imageSizes: sizes,
                  crossOrigin: JSCompiler_inline_result$jscomp$8,
                  integrity: props.integrity,
                  type: props.type,
                  fetchPriority: props.fetchPriority,
                  referrerPolicy: props.referrerPolicy,
                }),
                "high" === props.fetchPriority || 10 > renderState.highImagePreloads.size
                  ? renderState.highImagePreloads.add(resource$jscomp$1)
                  : (renderState.bulkPreloads.add(resource$jscomp$1),
                    promotablePreloads.set(key$jscomp$0, resource$jscomp$1)));
          }
        }
        return pushSelfClosing(target$jscomp$0, props, "img");
      case "base":
      case "area":
      case "br":
      case "col":
      case "embed":
      case "hr":
      case "keygen":
      case "param":
      case "source":
      case "track":
      case "wbr":
        return pushSelfClosing(target$jscomp$0, props, type);
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        break;
      case "head":
        if (2 > formatContext.insertionMode) {
          var preamble = preambleState || renderState.preamble;
          if (preamble.headChunks) throw Error("The `<head>` tag may only be rendered once.");
          null !== preambleState && target$jscomp$0.push(headPreambleContributionChunk);
          preamble.headChunks = [];
          var JSCompiler_inline_result$jscomp$9 = pushStartSingletonElement(
            preamble.headChunks,
            props,
            "head",
          );
        } else
          JSCompiler_inline_result$jscomp$9 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "head",
          );
        return JSCompiler_inline_result$jscomp$9;
      case "body":
        if (2 > formatContext.insertionMode) {
          var preamble$jscomp$0 = preambleState || renderState.preamble;
          if (preamble$jscomp$0.bodyChunks)
            throw Error("The `<body>` tag may only be rendered once.");
          null !== preambleState && target$jscomp$0.push(bodyPreambleContributionChunk);
          preamble$jscomp$0.bodyChunks = [];
          var JSCompiler_inline_result$jscomp$10 = pushStartSingletonElement(
            preamble$jscomp$0.bodyChunks,
            props,
            "body",
          );
        } else
          JSCompiler_inline_result$jscomp$10 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "body",
          );
        return JSCompiler_inline_result$jscomp$10;
      case "html":
        if (0 === formatContext.insertionMode) {
          var preamble$jscomp$1 = preambleState || renderState.preamble;
          if (preamble$jscomp$1.htmlChunks)
            throw Error("The `<html>` tag may only be rendered once.");
          null !== preambleState && target$jscomp$0.push(htmlPreambleContributionChunk);
          preamble$jscomp$1.htmlChunks = [doctypeChunk];
          var JSCompiler_inline_result$jscomp$11 = pushStartSingletonElement(
            preamble$jscomp$1.htmlChunks,
            props,
            "html",
          );
        } else
          JSCompiler_inline_result$jscomp$11 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "html",
          );
        return JSCompiler_inline_result$jscomp$11;
      default:
        if (-1 !== type.indexOf("-")) {
          target$jscomp$0.push(startChunkForTag(type));
          var children$jscomp$9 = null,
            innerHTML$jscomp$8 = null,
            propKey$jscomp$11;
          for (propKey$jscomp$11 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$11)) {
              var propValue$jscomp$11 = props[propKey$jscomp$11];
              if (null != propValue$jscomp$11) {
                var attributeName = propKey$jscomp$11;
                switch (propKey$jscomp$11) {
                  case "children":
                    children$jscomp$9 = propValue$jscomp$11;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$8 = propValue$jscomp$11;
                    break;
                  case "style":
                    pushStyleAttribute(target$jscomp$0, propValue$jscomp$11);
                    break;
                  case "suppressContentEditableWarning":
                  case "suppressHydrationWarning":
                  case "ref":
                    break;
                  case "className":
                    attributeName = "class";
                  default:
                    if (
                      isAttributeNameSafe(propKey$jscomp$11) &&
                      "function" !== typeof propValue$jscomp$11 &&
                      "symbol" !== typeof propValue$jscomp$11 &&
                      !1 !== propValue$jscomp$11
                    ) {
                      if (!0 === propValue$jscomp$11) propValue$jscomp$11 = "";
                      else if ("object" === typeof propValue$jscomp$11) continue;
                      target$jscomp$0.push(
                        attributeSeparator,
                        stringToChunk(attributeName),
                        attributeAssign,
                        stringToChunk(escapeTextForBrowser(propValue$jscomp$11)),
                        attributeEnd,
                      );
                    }
                }
              }
            }
          target$jscomp$0.push(endOfStartTag);
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$8, children$jscomp$9);
          return children$jscomp$9;
        }
    }
    return pushStartGenericElement(target$jscomp$0, props, type);
  }
  var endTagCache = /* @__PURE__ */ new Map();
  function endChunkForTag(tag) {
    var chunk = endTagCache.get(tag);
    void 0 === chunk &&
      ((chunk = stringToPrecomputedChunk("</" + tag + ">")), endTagCache.set(tag, chunk));
    return chunk;
  }
  function hoistPreambleState(renderState, preambleState) {
    renderState = renderState.preamble;
    null === renderState.htmlChunks &&
      preambleState.htmlChunks &&
      (renderState.htmlChunks = preambleState.htmlChunks);
    null === renderState.headChunks &&
      preambleState.headChunks &&
      (renderState.headChunks = preambleState.headChunks);
    null === renderState.bodyChunks &&
      preambleState.bodyChunks &&
      (renderState.bodyChunks = preambleState.bodyChunks);
  }
  function writeBootstrap(destination, renderState) {
    renderState = renderState.bootstrapChunks;
    for (var i = 0; i < renderState.length - 1; i++) writeChunk(destination, renderState[i]);
    return i < renderState.length
      ? ((i = renderState[i]), (renderState.length = 0), writeChunkAndReturn(destination, i))
      : !0;
  }
  var shellTimeRuntimeScript = stringToPrecomputedChunk(
      "requestAnimationFrame(function(){$RT=performance.now()});",
    ),
    placeholder1 = stringToPrecomputedChunk('<template id="'),
    placeholder2 = stringToPrecomputedChunk('"></template>'),
    startActivityBoundary = stringToPrecomputedChunk("<!--&-->"),
    endActivityBoundary = stringToPrecomputedChunk("<!--/&-->"),
    startCompletedSuspenseBoundary = stringToPrecomputedChunk("<!--$-->"),
    startPendingSuspenseBoundary1 = stringToPrecomputedChunk('<!--$?--><template id="'),
    startPendingSuspenseBoundary2 = stringToPrecomputedChunk('"></template>'),
    startClientRenderedSuspenseBoundary = stringToPrecomputedChunk("<!--$!-->"),
    endSuspenseBoundary = stringToPrecomputedChunk("<!--/$-->"),
    clientRenderedSuspenseBoundaryError1 = stringToPrecomputedChunk("<template"),
    clientRenderedSuspenseBoundaryErrorAttrInterstitial = stringToPrecomputedChunk('"'),
    clientRenderedSuspenseBoundaryError1A = stringToPrecomputedChunk(' data-dgst="');
  stringToPrecomputedChunk(' data-msg="');
  stringToPrecomputedChunk(' data-stck="');
  stringToPrecomputedChunk(' data-cstck="');
  var clientRenderedSuspenseBoundaryError2 = stringToPrecomputedChunk("></template>");
  function writeStartPendingSuspenseBoundary(destination, renderState, id) {
    writeChunk(destination, startPendingSuspenseBoundary1);
    if (null === id)
      throw Error("An ID must have been assigned before we can complete the boundary.");
    writeChunk(destination, renderState.boundaryPrefix);
    writeChunk(destination, stringToChunk(id.toString(16)));
    return writeChunkAndReturn(destination, startPendingSuspenseBoundary2);
  }
  var startSegmentHTML = stringToPrecomputedChunk('<div hidden id="'),
    startSegmentHTML2 = stringToPrecomputedChunk('">'),
    endSegmentHTML = stringToPrecomputedChunk("</div>"),
    startSegmentSVG = stringToPrecomputedChunk('<svg aria-hidden="true" style="display:none" id="'),
    startSegmentSVG2 = stringToPrecomputedChunk('">'),
    endSegmentSVG = stringToPrecomputedChunk("</svg>"),
    startSegmentMathML = stringToPrecomputedChunk(
      '<math aria-hidden="true" style="display:none" id="',
    ),
    startSegmentMathML2 = stringToPrecomputedChunk('">'),
    endSegmentMathML = stringToPrecomputedChunk("</math>"),
    startSegmentTable = stringToPrecomputedChunk('<table hidden id="'),
    startSegmentTable2 = stringToPrecomputedChunk('">'),
    endSegmentTable = stringToPrecomputedChunk("</table>"),
    startSegmentTableBody = stringToPrecomputedChunk('<table hidden><tbody id="'),
    startSegmentTableBody2 = stringToPrecomputedChunk('">'),
    endSegmentTableBody = stringToPrecomputedChunk("</tbody></table>"),
    startSegmentTableRow = stringToPrecomputedChunk('<table hidden><tr id="'),
    startSegmentTableRow2 = stringToPrecomputedChunk('">'),
    endSegmentTableRow = stringToPrecomputedChunk("</tr></table>"),
    startSegmentColGroup = stringToPrecomputedChunk('<table hidden><colgroup id="'),
    startSegmentColGroup2 = stringToPrecomputedChunk('">'),
    endSegmentColGroup = stringToPrecomputedChunk("</colgroup></table>");
  function writeStartSegment(destination, renderState, formatContext, id) {
    switch (formatContext.insertionMode) {
      case 0:
      case 1:
      case 3:
      case 2:
        return (
          writeChunk(destination, startSegmentHTML),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentHTML2)
        );
      case 4:
        return (
          writeChunk(destination, startSegmentSVG),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentSVG2)
        );
      case 5:
        return (
          writeChunk(destination, startSegmentMathML),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentMathML2)
        );
      case 6:
        return (
          writeChunk(destination, startSegmentTable),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentTable2)
        );
      case 7:
        return (
          writeChunk(destination, startSegmentTableBody),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentTableBody2)
        );
      case 8:
        return (
          writeChunk(destination, startSegmentTableRow),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentTableRow2)
        );
      case 9:
        return (
          writeChunk(destination, startSegmentColGroup),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentColGroup2)
        );
      default:
        throw Error("Unknown insertion mode. This is a bug in React.");
    }
  }
  function writeEndSegment(destination, formatContext) {
    switch (formatContext.insertionMode) {
      case 0:
      case 1:
      case 3:
      case 2:
        return writeChunkAndReturn(destination, endSegmentHTML);
      case 4:
        return writeChunkAndReturn(destination, endSegmentSVG);
      case 5:
        return writeChunkAndReturn(destination, endSegmentMathML);
      case 6:
        return writeChunkAndReturn(destination, endSegmentTable);
      case 7:
        return writeChunkAndReturn(destination, endSegmentTableBody);
      case 8:
        return writeChunkAndReturn(destination, endSegmentTableRow);
      case 9:
        return writeChunkAndReturn(destination, endSegmentColGroup);
      default:
        throw Error("Unknown insertion mode. This is a bug in React.");
    }
  }
  var completeSegmentScript1Full = stringToPrecomputedChunk(
      '$RS=function(a,b){a=document.getElementById(a);b=document.getElementById(b);for(a.parentNode.removeChild(a);a.firstChild;)b.parentNode.insertBefore(a.firstChild,b);b.parentNode.removeChild(b)};$RS("',
    ),
    completeSegmentScript1Partial = stringToPrecomputedChunk('$RS("'),
    completeSegmentScript2 = stringToPrecomputedChunk('","'),
    completeSegmentScriptEnd = stringToPrecomputedChunk('")<\/script>');
  stringToPrecomputedChunk('<template data-rsi="" data-sid="');
  stringToPrecomputedChunk('" data-pid="');
  var completeBoundaryScriptFunctionOnly = stringToPrecomputedChunk(
    '$RB=[];$RV=function(a){$RT=performance.now();for(var b=0;b<a.length;b+=2){var c=a[b],e=a[b+1];null!==e.parentNode&&e.parentNode.removeChild(e);var f=c.parentNode;if(f){var g=c.previousSibling,h=0;do{if(c&&8===c.nodeType){var d=c.data;if("/$"===d||"/&"===d)if(0===h)break;else h--;else"$"!==d&&"$?"!==d&&"$~"!==d&&"$!"!==d&&"&"!==d||h++}d=c.nextSibling;f.removeChild(c);c=d}while(c);for(;e.firstChild;)f.insertBefore(e.firstChild,c);g.data="$";g._reactRetry&&requestAnimationFrame(g._reactRetry)}}a.length=0};\n$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))?(a.previousSibling.data="$~",$RB.push(a,b),2===$RB.length&&("number"!==typeof $RT?requestAnimationFrame($RV.bind(null,$RB)):(a=performance.now(),setTimeout($RV.bind(null,$RB),2300>a&&2E3<a?2300-a:$RT+300-a)))):b.parentNode.removeChild(b)};',
  );
  stringToChunk(
    '$RV=function(A,g){function k(a,b){var e=a.getAttribute(b);e&&(b=a.style,l.push(a,b.viewTransitionName,b.viewTransitionClass),"auto"!==e&&(b.viewTransitionClass=e),(a=a.getAttribute("vt-name"))||(a="_T_"+K++ +"_"),b.viewTransitionName=a,B=!0)}var B=!1,K=0,l=[];try{var f=document.__reactViewTransition;if(f){f.finished.finally($RV.bind(null,g));return}var m=new Map;for(f=1;f<g.length;f+=2)for(var h=g[f].querySelectorAll("[vt-share]"),d=0;d<h.length;d++){var c=h[d];m.set(c.getAttribute("vt-name"),c)}var u=[];for(h=0;h<g.length;h+=2){var C=g[h],x=C.parentNode;if(x){var v=x.getBoundingClientRect();if(v.left||v.top||v.width||v.height){c=C;for(f=0;c;){if(8===c.nodeType){var r=c.data;if("/$"===r)if(0===f)break;else f--;else"$"!==r&&"$?"!==r&&"$~"!==r&&"$!"!==r||f++}else if(1===c.nodeType){d=c;var D=d.getAttribute("vt-name"),y=m.get(D);k(d,y?"vt-share":"vt-exit");y&&(k(y,"vt-share"),m.set(D,null));var E=d.querySelectorAll("[vt-share]");for(d=0;d<E.length;d++){var F=E[d],G=F.getAttribute("vt-name"),\nH=m.get(G);H&&(k(F,"vt-share"),k(H,"vt-share"),m.set(G,null))}}c=c.nextSibling}for(var I=g[h+1],t=I.firstElementChild;t;)null!==m.get(t.getAttribute("vt-name"))&&k(t,"vt-enter"),t=t.nextElementSibling;c=x;do for(var n=c.firstElementChild;n;){var J=n.getAttribute("vt-update");J&&"none"!==J&&!l.includes(n)&&k(n,"vt-update");n=n.nextElementSibling}while((c=c.parentNode)&&1===c.nodeType&&"none"!==c.getAttribute("vt-update"));u.push.apply(u,I.querySelectorAll(\'img[src]:not([loading="lazy"])\'))}}}if(B){var z=\ndocument.__reactViewTransition=document.startViewTransition({update:function(){A(g);for(var a=[document.documentElement.clientHeight,document.fonts.ready],b={},e=0;e<u.length;b={g:b.g},e++)if(b.g=u[e],!b.g.complete){var p=b.g.getBoundingClientRect();0<p.bottom&&0<p.right&&p.top<window.innerHeight&&p.left<window.innerWidth&&(p=new Promise(function(w){return function(q){w.g.addEventListener("load",q);w.g.addEventListener("error",q)}}(b)),a.push(p))}return Promise.race([Promise.all(a),new Promise(function(w){var q=\nperformance.now();setTimeout(w,2300>q&&2E3<q?2300-q:500)})])},types:[]});z.ready.finally(function(){for(var a=l.length-3;0<=a;a-=3){var b=l[a],e=b.style;e.viewTransitionName=l[a+1];e.viewTransitionClass=l[a+1];""===b.getAttribute("style")&&b.removeAttribute("style")}});z.finished.finally(function(){document.__reactViewTransition===z&&(document.__reactViewTransition=null)});$RB=[];return}}catch(a){}A(g)}.bind(null,$RV);',
  );
  var completeBoundaryScript1Partial = stringToPrecomputedChunk('$RC("'),
    completeBoundaryWithStylesScript1FullPartial = stringToPrecomputedChunk(
      '$RM=new Map;$RR=function(n,w,p){function u(q){this._p=null;q()}for(var r=new Map,t=document,h,b,e=t.querySelectorAll("link[data-precedence],style[data-precedence]"),v=[],k=0;b=e[k++];)"not all"===b.getAttribute("media")?v.push(b):("LINK"===b.tagName&&$RM.set(b.getAttribute("href"),b),r.set(b.dataset.precedence,h=b));e=0;b=[];var l,a;for(k=!0;;){if(k){var f=p[e++];if(!f){k=!1;e=0;continue}var c=!1,m=0;var d=f[m++];if(a=$RM.get(d)){var g=a._p;c=!0}else{a=t.createElement("link");a.href=d;a.rel=\n"stylesheet";for(a.dataset.precedence=l=f[m++];g=f[m++];)a.setAttribute(g,f[m++]);g=a._p=new Promise(function(q,x){a.onload=u.bind(a,q);a.onerror=u.bind(a,x)});$RM.set(d,a)}d=a.getAttribute("media");!g||d&&!matchMedia(d).matches||b.push(g);if(c)continue}else{a=v[e++];if(!a)break;l=a.getAttribute("data-precedence");a.removeAttribute("media")}c=r.get(l)||h;c===h&&(h=a);r.set(l,a);c?c.parentNode.insertBefore(a,c.nextSibling):(c=t.head,c.insertBefore(a,c.firstChild))}if(p=document.getElementById(n))p.previousSibling.data=\n"$~";Promise.all(b).then($RC.bind(null,n,w),$RX.bind(null,n,"CSS failed to load"))};$RR("',
    ),
    completeBoundaryWithStylesScript1Partial = stringToPrecomputedChunk('$RR("'),
    completeBoundaryScript2 = stringToPrecomputedChunk('","'),
    completeBoundaryScript3a = stringToPrecomputedChunk('",'),
    completeBoundaryScript3b = stringToPrecomputedChunk('"'),
    completeBoundaryScriptEnd = stringToPrecomputedChunk(")<\/script>");
  stringToPrecomputedChunk('<template data-rci="" data-bid="');
  stringToPrecomputedChunk('<template data-rri="" data-bid="');
  stringToPrecomputedChunk('" data-sid="');
  stringToPrecomputedChunk('" data-sty="');
  var clientRenderScriptFunctionOnly = stringToPrecomputedChunk(
      '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};',
    ),
    clientRenderScript1Full = stringToPrecomputedChunk(
      '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};;$RX("',
    ),
    clientRenderScript1Partial = stringToPrecomputedChunk('$RX("'),
    clientRenderScript1A = stringToPrecomputedChunk('"'),
    clientRenderErrorScriptArgInterstitial = stringToPrecomputedChunk(","),
    clientRenderScriptEnd = stringToPrecomputedChunk(")<\/script>");
  stringToPrecomputedChunk('<template data-rxi="" data-bid="');
  stringToPrecomputedChunk('" data-dgst="');
  stringToPrecomputedChunk('" data-msg="');
  stringToPrecomputedChunk('" data-stck="');
  stringToPrecomputedChunk('" data-cstck="');
  var regexForJSStringsInInstructionScripts = /[<\u2028\u2029]/g;
  function escapeJSStringsForInstructionScripts(input) {
    return JSON.stringify(input).replace(regexForJSStringsInInstructionScripts, function (match) {
      switch (match) {
        case "<":
          return "\\u003c";
        case "\u2028":
          return "\\u2028";
        case "\u2029":
          return "\\u2029";
        default:
          throw Error(
            "escapeJSStringsForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    });
  }
  var regexForJSStringsInScripts = /[&><\u2028\u2029]/g;
  function escapeJSObjectForInstructionScripts(input) {
    return JSON.stringify(input).replace(regexForJSStringsInScripts, function (match) {
      switch (match) {
        case "&":
          return "\\u0026";
        case ">":
          return "\\u003e";
        case "<":
          return "\\u003c";
        case "\u2028":
          return "\\u2028";
        case "\u2029":
          return "\\u2029";
        default:
          throw Error(
            "escapeJSObjectForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    });
  }
  var lateStyleTagResourceOpen1 = stringToPrecomputedChunk(' media="not all" data-precedence="'),
    lateStyleTagResourceOpen2 = stringToPrecomputedChunk('" data-href="'),
    lateStyleTagResourceOpen3 = stringToPrecomputedChunk('">'),
    lateStyleTagTemplateClose = stringToPrecomputedChunk("</style>"),
    currentlyRenderingBoundaryHasStylesToHoist = !1,
    destinationHasCapacity = !0;
  function flushStyleTagsLateForBoundary(styleQueue) {
    var rules = styleQueue.rules,
      hrefs = styleQueue.hrefs,
      i = 0;
    if (hrefs.length) {
      writeChunk(this, currentlyFlushingRenderState.startInlineStyle);
      writeChunk(this, lateStyleTagResourceOpen1);
      writeChunk(this, styleQueue.precedence);
      for (writeChunk(this, lateStyleTagResourceOpen2); i < hrefs.length - 1; i++)
        (writeChunk(this, hrefs[i]), writeChunk(this, spaceSeparator));
      writeChunk(this, hrefs[i]);
      writeChunk(this, lateStyleTagResourceOpen3);
      for (i = 0; i < rules.length; i++) writeChunk(this, rules[i]);
      destinationHasCapacity = writeChunkAndReturn(this, lateStyleTagTemplateClose);
      currentlyRenderingBoundaryHasStylesToHoist = !0;
      rules.length = 0;
      hrefs.length = 0;
    }
  }
  function hasStylesToHoist(stylesheet) {
    return 2 !== stylesheet.state ? (currentlyRenderingBoundaryHasStylesToHoist = !0) : !1;
  }
  function writeHoistablesForBoundary(destination, hoistableState, renderState) {
    currentlyRenderingBoundaryHasStylesToHoist = !1;
    destinationHasCapacity = !0;
    currentlyFlushingRenderState = renderState;
    hoistableState.styles.forEach(flushStyleTagsLateForBoundary, destination);
    currentlyFlushingRenderState = null;
    hoistableState.stylesheets.forEach(hasStylesToHoist);
    currentlyRenderingBoundaryHasStylesToHoist && (renderState.stylesToHoist = !0);
    return destinationHasCapacity;
  }
  function flushResource(resource) {
    for (var i = 0; i < resource.length; i++) writeChunk(this, resource[i]);
    resource.length = 0;
  }
  var stylesheetFlushingQueue = [];
  function flushStyleInPreamble(stylesheet) {
    pushLinkImpl(stylesheetFlushingQueue, stylesheet.props);
    for (var i = 0; i < stylesheetFlushingQueue.length; i++)
      writeChunk(this, stylesheetFlushingQueue[i]);
    stylesheetFlushingQueue.length = 0;
    stylesheet.state = 2;
  }
  var styleTagResourceOpen1 = stringToPrecomputedChunk(' data-precedence="'),
    styleTagResourceOpen2 = stringToPrecomputedChunk('" data-href="'),
    spaceSeparator = stringToPrecomputedChunk(" "),
    styleTagResourceOpen3 = stringToPrecomputedChunk('">'),
    styleTagResourceClose = stringToPrecomputedChunk("</style>");
  function flushStylesInPreamble(styleQueue) {
    var hasStylesheets = 0 < styleQueue.sheets.size;
    styleQueue.sheets.forEach(flushStyleInPreamble, this);
    styleQueue.sheets.clear();
    var rules = styleQueue.rules,
      hrefs = styleQueue.hrefs;
    if (!hasStylesheets || hrefs.length) {
      writeChunk(this, currentlyFlushingRenderState.startInlineStyle);
      writeChunk(this, styleTagResourceOpen1);
      writeChunk(this, styleQueue.precedence);
      styleQueue = 0;
      if (hrefs.length) {
        for (writeChunk(this, styleTagResourceOpen2); styleQueue < hrefs.length - 1; styleQueue++)
          (writeChunk(this, hrefs[styleQueue]), writeChunk(this, spaceSeparator));
        writeChunk(this, hrefs[styleQueue]);
      }
      writeChunk(this, styleTagResourceOpen3);
      for (styleQueue = 0; styleQueue < rules.length; styleQueue++)
        writeChunk(this, rules[styleQueue]);
      writeChunk(this, styleTagResourceClose);
      rules.length = 0;
      hrefs.length = 0;
    }
  }
  function preloadLateStyle(stylesheet) {
    if (0 === stylesheet.state) {
      stylesheet.state = 1;
      var props = stylesheet.props;
      pushLinkImpl(stylesheetFlushingQueue, {
        rel: "preload",
        as: "style",
        href: stylesheet.props.href,
        crossOrigin: props.crossOrigin,
        fetchPriority: props.fetchPriority,
        integrity: props.integrity,
        media: props.media,
        hrefLang: props.hrefLang,
        referrerPolicy: props.referrerPolicy,
      });
      for (stylesheet = 0; stylesheet < stylesheetFlushingQueue.length; stylesheet++)
        writeChunk(this, stylesheetFlushingQueue[stylesheet]);
      stylesheetFlushingQueue.length = 0;
    }
  }
  function preloadLateStyles(styleQueue) {
    styleQueue.sheets.forEach(preloadLateStyle, this);
    styleQueue.sheets.clear();
  }
  stringToPrecomputedChunk('<link rel="expect" href="#');
  stringToPrecomputedChunk('" blocking="render"/>');
  var completedShellIdAttributeStart = stringToPrecomputedChunk(' id="');
  function pushCompletedShellIdAttribute(target, resumableState) {
    0 === (resumableState.instructions & 32) &&
      ((resumableState.instructions |= 32),
      target.push(
        completedShellIdAttributeStart,
        stringToChunk(escapeTextForBrowser("_" + resumableState.idPrefix + "R_")),
        attributeEnd,
      ));
  }
  var arrayFirstOpenBracket = stringToPrecomputedChunk("["),
    arraySubsequentOpenBracket = stringToPrecomputedChunk(",["),
    arrayInterstitial = stringToPrecomputedChunk(","),
    arrayCloseBracket = stringToPrecomputedChunk("]");
  function writeStyleResourceDependenciesInJS(destination, hoistableState) {
    writeChunk(destination, arrayFirstOpenBracket);
    var nextArrayOpenBrackChunk = arrayFirstOpenBracket;
    hoistableState.stylesheets.forEach(function (resource) {
      if (2 !== resource.state)
        if (3 === resource.state)
          (writeChunk(destination, nextArrayOpenBrackChunk),
            writeChunk(
              destination,
              stringToChunk(escapeJSObjectForInstructionScripts("" + resource.props.href)),
            ),
            writeChunk(destination, arrayCloseBracket),
            (nextArrayOpenBrackChunk = arraySubsequentOpenBracket));
        else {
          writeChunk(destination, nextArrayOpenBrackChunk);
          var precedence = resource.props["data-precedence"],
            props = resource.props;
          writeChunk(
            destination,
            stringToChunk(
              escapeJSObjectForInstructionScripts(sanitizeURL("" + resource.props.href)),
            ),
          );
          precedence = "" + precedence;
          writeChunk(destination, arrayInterstitial);
          writeChunk(destination, stringToChunk(escapeJSObjectForInstructionScripts(precedence)));
          for (var propKey in props)
            if (
              hasOwnProperty.call(props, propKey) &&
              ((precedence = props[propKey]), null != precedence)
            )
              switch (propKey) {
                case "href":
                case "rel":
                case "precedence":
                case "data-precedence":
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(
                    "link is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
                  );
                default:
                  writeStyleResourceAttributeInJS(destination, propKey, precedence);
              }
          writeChunk(destination, arrayCloseBracket);
          nextArrayOpenBrackChunk = arraySubsequentOpenBracket;
          resource.state = 3;
        }
    });
    writeChunk(destination, arrayCloseBracket);
  }
  function writeStyleResourceAttributeInJS(destination, name, value) {
    var attributeName = name.toLowerCase();
    switch (typeof value) {
      case "function":
      case "symbol":
        return;
    }
    switch (name) {
      case "innerHTML":
      case "dangerouslySetInnerHTML":
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "style":
      case "ref":
        return;
      case "className":
        attributeName = "class";
        name = "" + value;
        break;
      case "hidden":
        if (!1 === value) return;
        name = "";
        break;
      case "src":
      case "href":
        value = sanitizeURL(value);
        name = "" + value;
        break;
      default:
        if (
          (2 < name.length &&
            ("o" === name[0] || "O" === name[0]) &&
            ("n" === name[1] || "N" === name[1])) ||
          !isAttributeNameSafe(name)
        )
          return;
        name = "" + value;
    }
    writeChunk(destination, arrayInterstitial);
    writeChunk(destination, stringToChunk(escapeJSObjectForInstructionScripts(attributeName)));
    writeChunk(destination, arrayInterstitial);
    writeChunk(destination, stringToChunk(escapeJSObjectForInstructionScripts(name)));
  }
  function createHoistableState() {
    return {
      styles: /* @__PURE__ */ new Set(),
      stylesheets: /* @__PURE__ */ new Set(),
      suspenseyImages: !1,
    };
  }
  function prefetchDNS(href) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if ("string" === typeof href && href) {
        if (!resumableState.dnsResources.hasOwnProperty(href)) {
          resumableState.dnsResources[href] = null;
          resumableState = renderState.headers;
          var header, JSCompiler_temp;
          if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity))
            JSCompiler_temp =
              ((header =
                "<" +
                ("" + href).replace(
                  regexForHrefInLinkHeaderURLContext,
                  escapeHrefForLinkHeaderURLContextReplacer,
                ) +
                ">; rel=dns-prefetch"),
              0 <= (resumableState.remainingCapacity -= header.length + 2));
          JSCompiler_temp
            ? ((renderState.resets.dns[href] = null),
              resumableState.preconnects && (resumableState.preconnects += ", "),
              (resumableState.preconnects += header))
            : ((header = []),
              pushLinkImpl(header, {
                href,
                rel: "dns-prefetch",
              }),
              renderState.preconnects.add(header));
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.D(href);
  }
  function preconnect(href, crossOrigin) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if ("string" === typeof href && href) {
        var bucket =
          "use-credentials" === crossOrigin
            ? "credentials"
            : "string" === typeof crossOrigin
              ? "anonymous"
              : "default";
        if (!resumableState.connectResources[bucket].hasOwnProperty(href)) {
          resumableState.connectResources[bucket][href] = null;
          resumableState = renderState.headers;
          var header, JSCompiler_temp;
          if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity)) {
            JSCompiler_temp =
              "<" +
              ("" + href).replace(
                regexForHrefInLinkHeaderURLContext,
                escapeHrefForLinkHeaderURLContextReplacer,
              ) +
              ">; rel=preconnect";
            if ("string" === typeof crossOrigin) {
              var escapedCrossOrigin = ("" + crossOrigin).replace(
                regexForLinkHeaderQuotedParamValueContext,
                escapeStringForLinkHeaderQuotedParamValueContextReplacer,
              );
              JSCompiler_temp += '; crossorigin="' + escapedCrossOrigin + '"';
            }
            JSCompiler_temp =
              ((header = JSCompiler_temp),
              0 <= (resumableState.remainingCapacity -= header.length + 2));
          }
          JSCompiler_temp
            ? ((renderState.resets.connect[bucket][href] = null),
              resumableState.preconnects && (resumableState.preconnects += ", "),
              (resumableState.preconnects += header))
            : ((bucket = []),
              pushLinkImpl(bucket, {
                rel: "preconnect",
                href,
                crossOrigin,
              }),
              renderState.preconnects.add(bucket));
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.C(href, crossOrigin);
  }
  function preload(href, as, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (as && href) {
        switch (as) {
          case "image":
            if (options) {
              var imageSrcSet = options.imageSrcSet;
              var imageSizes = options.imageSizes;
              var fetchPriority = options.fetchPriority;
            }
            var key = imageSrcSet ? imageSrcSet + "\n" + (imageSizes || "") : href;
            if (resumableState.imageResources.hasOwnProperty(key)) return;
            resumableState.imageResources[key] = PRELOAD_NO_CREDS;
            resumableState = renderState.headers;
            var header;
            resumableState &&
            0 < resumableState.remainingCapacity &&
            "string" !== typeof imageSrcSet &&
            "high" === fetchPriority &&
            ((header = getPreloadAsHeader(href, as, options)),
            0 <= (resumableState.remainingCapacity -= header.length + 2))
              ? ((renderState.resets.image[key] = PRELOAD_NO_CREDS),
                resumableState.highImagePreloads && (resumableState.highImagePreloads += ", "),
                (resumableState.highImagePreloads += header))
              : ((resumableState = []),
                pushLinkImpl(
                  resumableState,
                  assign(
                    {
                      rel: "preload",
                      href: imageSrcSet ? void 0 : href,
                      as,
                    },
                    options,
                  ),
                ),
                "high" === fetchPriority
                  ? renderState.highImagePreloads.add(resumableState)
                  : (renderState.bulkPreloads.add(resumableState),
                    renderState.preloads.images.set(key, resumableState)));
            break;
          case "style":
            if (resumableState.styleResources.hasOwnProperty(href)) return;
            imageSrcSet = [];
            pushLinkImpl(
              imageSrcSet,
              assign(
                {
                  rel: "preload",
                  href,
                  as,
                },
                options,
              ),
            );
            resumableState.styleResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            renderState.preloads.stylesheets.set(href, imageSrcSet);
            renderState.bulkPreloads.add(imageSrcSet);
            break;
          case "script":
            if (resumableState.scriptResources.hasOwnProperty(href)) return;
            imageSrcSet = [];
            renderState.preloads.scripts.set(href, imageSrcSet);
            renderState.bulkPreloads.add(imageSrcSet);
            pushLinkImpl(
              imageSrcSet,
              assign(
                {
                  rel: "preload",
                  href,
                  as,
                },
                options,
              ),
            );
            resumableState.scriptResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            break;
          default:
            if (resumableState.unknownResources.hasOwnProperty(as)) {
              if (
                ((imageSrcSet = resumableState.unknownResources[as]),
                imageSrcSet.hasOwnProperty(href))
              )
                return;
            } else ((imageSrcSet = {}), (resumableState.unknownResources[as] = imageSrcSet));
            imageSrcSet[href] = PRELOAD_NO_CREDS;
            if (
              (resumableState = renderState.headers) &&
              0 < resumableState.remainingCapacity &&
              "font" === as &&
              ((key = getPreloadAsHeader(href, as, options)),
              0 <= (resumableState.remainingCapacity -= key.length + 2))
            )
              ((renderState.resets.font[href] = PRELOAD_NO_CREDS),
                resumableState.fontPreloads && (resumableState.fontPreloads += ", "),
                (resumableState.fontPreloads += key));
            else
              switch (
                ((resumableState = []),
                (href = assign(
                  {
                    rel: "preload",
                    href,
                    as,
                  },
                  options,
                )),
                pushLinkImpl(resumableState, href),
                as)
              ) {
                case "font":
                  renderState.fontPreloads.add(resumableState);
                  break;
                default:
                  renderState.bulkPreloads.add(resumableState);
              }
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.L(href, as, options);
  }
  function preloadModule(href, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (href) {
        var as = options && "string" === typeof options.as ? options.as : "script";
        switch (as) {
          case "script":
            if (resumableState.moduleScriptResources.hasOwnProperty(href)) return;
            as = [];
            resumableState.moduleScriptResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            renderState.preloads.moduleScripts.set(href, as);
            break;
          default:
            if (resumableState.moduleUnknownResources.hasOwnProperty(as)) {
              var resources = resumableState.unknownResources[as];
              if (resources.hasOwnProperty(href)) return;
            } else ((resources = {}), (resumableState.moduleUnknownResources[as] = resources));
            as = [];
            resources[href] = PRELOAD_NO_CREDS;
        }
        pushLinkImpl(
          as,
          assign(
            {
              rel: "modulepreload",
              href,
            },
            options,
          ),
        );
        renderState.bulkPreloads.add(as);
        enqueueFlush(request);
      }
    } else previousDispatcher.m(href, options);
  }
  function preinitStyle(href, precedence, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (href) {
        precedence = precedence || "default";
        var styleQueue = renderState.styles.get(precedence),
          resourceState = resumableState.styleResources.hasOwnProperty(href)
            ? resumableState.styleResources[href]
            : void 0;
        null !== resourceState &&
          ((resumableState.styleResources[href] = null),
          styleQueue ||
            ((styleQueue = {
              precedence: stringToChunk(escapeTextForBrowser(precedence)),
              rules: [],
              hrefs: [],
              sheets: /* @__PURE__ */ new Map(),
            }),
            renderState.styles.set(precedence, styleQueue)),
          (precedence = {
            state: 0,
            props: assign(
              {
                rel: "stylesheet",
                href,
                "data-precedence": precedence,
              },
              options,
            ),
          }),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(precedence.props, resourceState),
            (renderState = renderState.preloads.stylesheets.get(href)) && 0 < renderState.length
              ? (renderState.length = 0)
              : (precedence.state = 1)),
          styleQueue.sheets.set(href, precedence),
          enqueueFlush(request));
      }
    } else previousDispatcher.S(href, precedence, options);
  }
  function preinitScript(src, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (src) {
        var resourceState = resumableState.scriptResources.hasOwnProperty(src)
          ? resumableState.scriptResources[src]
          : void 0;
        null !== resourceState &&
          ((resumableState.scriptResources[src] = null),
          (options = assign(
            {
              src,
              async: !0,
            },
            options,
          )),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
            (src = renderState.preloads.scripts.get(src))) &&
            (src.length = 0),
          (src = []),
          renderState.scripts.add(src),
          pushScriptImpl(src, options),
          enqueueFlush(request));
      }
    } else previousDispatcher.X(src, options);
  }
  function preinitModuleScript(src, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (src) {
        var resourceState = resumableState.moduleScriptResources.hasOwnProperty(src)
          ? resumableState.moduleScriptResources[src]
          : void 0;
        null !== resourceState &&
          ((resumableState.moduleScriptResources[src] = null),
          (options = assign(
            {
              src,
              type: "module",
              async: !0,
            },
            options,
          )),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
            (src = renderState.preloads.moduleScripts.get(src))) &&
            (src.length = 0),
          (src = []),
          renderState.scripts.add(src),
          pushScriptImpl(src, options),
          enqueueFlush(request));
      }
    } else previousDispatcher.M(src, options);
  }
  function adoptPreloadCredentials(target, preloadState) {
    target.crossOrigin ??= preloadState[0];
    target.integrity ??= preloadState[1];
  }
  function getPreloadAsHeader(href, as, params) {
    href = ("" + href).replace(
      regexForHrefInLinkHeaderURLContext,
      escapeHrefForLinkHeaderURLContextReplacer,
    );
    as = ("" + as).replace(
      regexForLinkHeaderQuotedParamValueContext,
      escapeStringForLinkHeaderQuotedParamValueContextReplacer,
    );
    as = "<" + href + '>; rel=preload; as="' + as + '"';
    for (var paramName in params)
      hasOwnProperty.call(params, paramName) &&
        ((href = params[paramName]),
        "string" === typeof href &&
          (as +=
            "; " +
            paramName.toLowerCase() +
            '="' +
            ("" + href).replace(
              regexForLinkHeaderQuotedParamValueContext,
              escapeStringForLinkHeaderQuotedParamValueContextReplacer,
            ) +
            '"'));
    return as;
  }
  var regexForHrefInLinkHeaderURLContext = /[<>\r\n]/g;
  function escapeHrefForLinkHeaderURLContextReplacer(match) {
    switch (match) {
      case "<":
        return "%3C";
      case ">":
        return "%3E";
      case "\n":
        return "%0A";
      case "\r":
        return "%0D";
      default:
        throw Error(
          "escapeLinkHrefForHeaderContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
        );
    }
  }
  var regexForLinkHeaderQuotedParamValueContext = /["';,\r\n]/g;
  function escapeStringForLinkHeaderQuotedParamValueContextReplacer(match) {
    switch (match) {
      case '"':
        return "%22";
      case "'":
        return "%27";
      case ";":
        return "%3B";
      case ",":
        return "%2C";
      case "\n":
        return "%0A";
      case "\r":
        return "%0D";
      default:
        throw Error(
          "escapeStringForLinkHeaderQuotedParamValueContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
        );
    }
  }
  function hoistStyleQueueDependency(styleQueue) {
    this.styles.add(styleQueue);
  }
  function hoistStylesheetDependency(stylesheet) {
    this.stylesheets.add(stylesheet);
  }
  function hoistHoistables(parentState, childState) {
    childState.styles.forEach(hoistStyleQueueDependency, parentState);
    childState.stylesheets.forEach(hoistStylesheetDependency, parentState);
    childState.suspenseyImages && (parentState.suspenseyImages = !0);
  }
  function hasSuspenseyContent(hoistableState) {
    return 0 < hoistableState.stylesheets.size || hoistableState.suspenseyImages;
  }
  var bind = Function.prototype.bind,
    supportsRequestStorage = "function" === typeof AsyncLocalStorage,
    requestStorage = supportsRequestStorage ? new AsyncLocalStorage() : null,
    REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");
  function getComponentNameFromType(type) {
    if (null == type) return null;
    if ("function" === typeof type)
      return type.$$typeof === REACT_CLIENT_REFERENCE
        ? null
        : type.displayName || type.name || null;
    if ("string" === typeof type) return type;
    switch (type) {
      case REACT_FRAGMENT_TYPE:
        return "Fragment";
      case REACT_PROFILER_TYPE:
        return "Profiler";
      case REACT_STRICT_MODE_TYPE:
        return "StrictMode";
      case REACT_SUSPENSE_TYPE:
        return "Suspense";
      case REACT_SUSPENSE_LIST_TYPE:
        return "SuspenseList";
      case REACT_ACTIVITY_TYPE:
        return "Activity";
    }
    if ("object" === typeof type)
      switch (type.$$typeof) {
        case REACT_PORTAL_TYPE:
          return "Portal";
        case REACT_CONTEXT_TYPE:
          return type.displayName || "Context";
        case REACT_CONSUMER_TYPE:
          return (type._context.displayName || "Context") + ".Consumer";
        case REACT_FORWARD_REF_TYPE:
          var innerType = type.render;
          type = type.displayName;
          type ||
            ((type = innerType.displayName || innerType.name || ""),
            (type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef"));
          return type;
        case REACT_MEMO_TYPE:
          return (
            (innerType = type.displayName || null),
            null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo"
          );
        case REACT_LAZY_TYPE:
          innerType = type._payload;
          type = type._init;
          try {
            return getComponentNameFromType(type(innerType));
          } catch (x) {}
      }
    return null;
  }
  var emptyContextObject = {},
    currentActiveSnapshot = null;
  function popToNearestCommonAncestor(prev, next) {
    if (prev !== next) {
      prev.context._currentValue = prev.parentValue;
      prev = prev.parent;
      var parentNext = next.parent;
      if (null === prev) {
        if (null !== parentNext)
          throw Error("The stacks must reach the root at the same time. This is a bug in React.");
      } else {
        if (null === parentNext)
          throw Error("The stacks must reach the root at the same time. This is a bug in React.");
        popToNearestCommonAncestor(prev, parentNext);
      }
      next.context._currentValue = next.value;
    }
  }
  function popAllPrevious(prev) {
    prev.context._currentValue = prev.parentValue;
    prev = prev.parent;
    null !== prev && popAllPrevious(prev);
  }
  function pushAllNext(next) {
    var parentNext = next.parent;
    null !== parentNext && pushAllNext(parentNext);
    next.context._currentValue = next.value;
  }
  function popPreviousToCommonLevel(prev, next) {
    prev.context._currentValue = prev.parentValue;
    prev = prev.parent;
    if (null === prev)
      throw Error(
        "The depth must equal at least at zero before reaching the root. This is a bug in React.",
      );
    prev.depth === next.depth
      ? popToNearestCommonAncestor(prev, next)
      : popPreviousToCommonLevel(prev, next);
  }
  function popNextToCommonLevel(prev, next) {
    var parentNext = next.parent;
    if (null === parentNext)
      throw Error(
        "The depth must equal at least at zero before reaching the root. This is a bug in React.",
      );
    prev.depth === parentNext.depth
      ? popToNearestCommonAncestor(prev, parentNext)
      : popNextToCommonLevel(prev, parentNext);
    next.context._currentValue = next.value;
  }
  function switchContext(newSnapshot) {
    var prev = currentActiveSnapshot;
    prev !== newSnapshot &&
      (null === prev
        ? pushAllNext(newSnapshot)
        : null === newSnapshot
          ? popAllPrevious(prev)
          : prev.depth === newSnapshot.depth
            ? popToNearestCommonAncestor(prev, newSnapshot)
            : prev.depth > newSnapshot.depth
              ? popPreviousToCommonLevel(prev, newSnapshot)
              : popNextToCommonLevel(prev, newSnapshot),
      (currentActiveSnapshot = newSnapshot));
  }
  var classComponentUpdater = {
      enqueueSetState: function (inst, payload) {
        inst = inst._reactInternals;
        null !== inst.queue && inst.queue.push(payload);
      },
      enqueueReplaceState: function (inst, payload) {
        inst = inst._reactInternals;
        inst.replace = !0;
        inst.queue = [payload];
      },
      enqueueForceUpdate: function () {},
    },
    emptyTreeContext = {
      id: 1,
      overflow: "",
    };
  function pushTreeContext(baseContext, totalChildren, index) {
    var baseIdWithLeadingBit = baseContext.id;
    baseContext = baseContext.overflow;
    var baseLength = 32 - clz32(baseIdWithLeadingBit) - 1;
    baseIdWithLeadingBit &= ~(1 << baseLength);
    index += 1;
    var length = 32 - clz32(totalChildren) + baseLength;
    if (30 < length) {
      var numberOfOverflowBits = baseLength - (baseLength % 5);
      length = (baseIdWithLeadingBit & ((1 << numberOfOverflowBits) - 1)).toString(32);
      baseIdWithLeadingBit >>= numberOfOverflowBits;
      baseLength -= numberOfOverflowBits;
      return {
        id:
          (1 << (32 - clz32(totalChildren) + baseLength)) |
          (index << baseLength) |
          baseIdWithLeadingBit,
        overflow: length + baseContext,
      };
    }
    return {
      id: (1 << length) | (index << baseLength) | baseIdWithLeadingBit,
      overflow: baseContext,
    };
  }
  var clz32 = Math.clz32 ? Math.clz32 : clz32Fallback,
    log = Math.log,
    LN2 = Math.LN2;
  function clz32Fallback(x) {
    x >>>= 0;
    return 0 === x ? 32 : (31 - ((log(x) / LN2) | 0)) | 0;
  }
  function noop() {}
  var SuspenseException = Error(
    "Suspense Exception: This is not a real error! It's an implementation detail of `use` to interrupt the current render. You must either rethrow it immediately, or move the `use` call outside of the `try/catch` block. Capturing without rethrowing will lead to unexpected behavior.\n\nTo handle async errors, wrap your component in an error boundary, or call the promise's `.catch` method and pass the result to `use`.",
  );
  function trackUsedThenable(thenableState, thenable, index) {
    index = thenableState[index];
    void 0 === index
      ? thenableState.push(thenable)
      : index !== thenable && (thenable.then(noop, noop), (thenable = index));
    switch (thenable.status) {
      case "fulfilled":
        return thenable.value;
      case "rejected":
        throw thenable.reason;
      default:
        "string" === typeof thenable.status
          ? thenable.then(noop, noop)
          : ((thenableState = thenable),
            (thenableState.status = "pending"),
            thenableState.then(
              function (fulfilledValue) {
                if ("pending" === thenable.status) {
                  var fulfilledThenable = thenable;
                  fulfilledThenable.status = "fulfilled";
                  fulfilledThenable.value = fulfilledValue;
                }
              },
              function (error) {
                if ("pending" === thenable.status) {
                  var rejectedThenable = thenable;
                  rejectedThenable.status = "rejected";
                  rejectedThenable.reason = error;
                }
              },
            ));
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
        }
        suspendedThenable = thenable;
        throw SuspenseException;
    }
  }
  var suspendedThenable = null;
  function getSuspendedThenable() {
    if (null === suspendedThenable)
      throw Error("Expected a suspended thenable. This is a bug in React. Please file an issue.");
    var thenable = suspendedThenable;
    suspendedThenable = null;
    return thenable;
  }
  function is(x, y) {
    return (x === y && (0 !== x || 1 / x === 1 / y)) || (x !== x && y !== y);
  }
  var objectIs = "function" === typeof Object.is ? Object.is : is,
    currentlyRenderingComponent = null,
    currentlyRenderingTask = null,
    currentlyRenderingRequest = null,
    currentlyRenderingKeyPath = null,
    firstWorkInProgressHook = null,
    workInProgressHook = null,
    isReRender = !1,
    didScheduleRenderPhaseUpdate = !1,
    localIdCounter = 0,
    actionStateCounter = 0,
    actionStateMatchingIndex = -1,
    thenableIndexCounter = 0,
    thenableState = null,
    renderPhaseUpdates = null,
    numberOfReRenders = 0;
  function resolveCurrentlyRenderingComponent() {
    if (null === currentlyRenderingComponent)
      throw Error(
        "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem.",
      );
    return currentlyRenderingComponent;
  }
  function createHook() {
    if (0 < numberOfReRenders) throw Error("Rendered more hooks than during the previous render");
    return {
      memoizedState: null,
      queue: null,
      next: null,
    };
  }
  function createWorkInProgressHook() {
    null === workInProgressHook
      ? null === firstWorkInProgressHook
        ? ((isReRender = !1), (firstWorkInProgressHook = workInProgressHook = createHook()))
        : ((isReRender = !0), (workInProgressHook = firstWorkInProgressHook))
      : null === workInProgressHook.next
        ? ((isReRender = !1), (workInProgressHook = workInProgressHook.next = createHook()))
        : ((isReRender = !0), (workInProgressHook = workInProgressHook.next));
    return workInProgressHook;
  }
  function getThenableStateAfterSuspending() {
    var state = thenableState;
    thenableState = null;
    return state;
  }
  function resetHooksState() {
    currentlyRenderingKeyPath =
      currentlyRenderingRequest =
      currentlyRenderingTask =
      currentlyRenderingComponent =
        null;
    didScheduleRenderPhaseUpdate = !1;
    firstWorkInProgressHook = null;
    numberOfReRenders = 0;
    workInProgressHook = renderPhaseUpdates = null;
  }
  function basicStateReducer(state, action) {
    return "function" === typeof action ? action(state) : action;
  }
  function useReducer(reducer, initialArg, init) {
    currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
    workInProgressHook = createWorkInProgressHook();
    if (isReRender) {
      var queue = workInProgressHook.queue;
      initialArg = queue.dispatch;
      if (
        null !== renderPhaseUpdates &&
        ((init = renderPhaseUpdates.get(queue)), void 0 !== init)
      ) {
        renderPhaseUpdates.delete(queue);
        queue = workInProgressHook.memoizedState;
        do ((queue = reducer(queue, init.action)), (init = init.next));
        while (null !== init);
        workInProgressHook.memoizedState = queue;
        return [queue, initialArg];
      }
      return [workInProgressHook.memoizedState, initialArg];
    }
    reducer =
      reducer === basicStateReducer
        ? "function" === typeof initialArg
          ? initialArg()
          : initialArg
        : void 0 !== init
          ? init(initialArg)
          : initialArg;
    workInProgressHook.memoizedState = reducer;
    reducer = workInProgressHook.queue = {
      last: null,
      dispatch: null,
    };
    reducer = reducer.dispatch = dispatchAction.bind(null, currentlyRenderingComponent, reducer);
    return [workInProgressHook.memoizedState, reducer];
  }
  function useMemo(nextCreate, deps) {
    currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
    workInProgressHook = createWorkInProgressHook();
    deps = void 0 === deps ? null : deps;
    if (null !== workInProgressHook) {
      var prevState = workInProgressHook.memoizedState;
      if (null !== prevState && null !== deps) {
        var prevDeps = prevState[1];
        a: if (null === prevDeps) prevDeps = !1;
        else {
          for (var i = 0; i < prevDeps.length && i < deps.length; i++)
            if (!objectIs(deps[i], prevDeps[i])) {
              prevDeps = !1;
              break a;
            }
          prevDeps = !0;
        }
        if (prevDeps) return prevState[0];
      }
    }
    nextCreate = nextCreate();
    workInProgressHook.memoizedState = [nextCreate, deps];
    return nextCreate;
  }
  function dispatchAction(componentIdentity, queue, action) {
    if (25 <= numberOfReRenders)
      throw Error(
        "Too many re-renders. React limits the number of renders to prevent an infinite loop.",
      );
    if (componentIdentity === currentlyRenderingComponent)
      if (
        ((didScheduleRenderPhaseUpdate = !0),
        (componentIdentity = {
          action,
          next: null,
        }),
        null === renderPhaseUpdates && (renderPhaseUpdates = /* @__PURE__ */ new Map()),
        (action = renderPhaseUpdates.get(queue)),
        void 0 === action)
      )
        renderPhaseUpdates.set(queue, componentIdentity);
      else {
        for (queue = action; null !== queue.next; ) queue = queue.next;
        queue.next = componentIdentity;
      }
  }
  function throwOnUseEffectEventCall() {
    throw Error("A function wrapped in useEffectEvent can't be called during rendering.");
  }
  function unsupportedStartTransition() {
    throw Error("startTransition cannot be called during server rendering.");
  }
  function unsupportedSetOptimisticState() {
    throw Error("Cannot update optimistic state while rendering.");
  }
  function useActionState(action, initialState, permalink) {
    resolveCurrentlyRenderingComponent();
    var actionStateHookIndex = actionStateCounter++,
      request = currentlyRenderingRequest;
    if ("function" === typeof action.$$FORM_ACTION) {
      var nextPostbackStateKey = null,
        componentKeyPath = currentlyRenderingKeyPath;
      request = request.formState;
      var isSignatureEqual = action.$$IS_SIGNATURE_EQUAL;
      if (null !== request && "function" === typeof isSignatureEqual) {
        var postbackKey = request[1];
        isSignatureEqual.call(action, request[2], request[3]) &&
          ((nextPostbackStateKey =
            void 0 !== permalink
              ? "p" + permalink
              : "k" +
                murmurhash3_32_gc(
                  JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                  0,
                )),
          postbackKey === nextPostbackStateKey &&
            ((actionStateMatchingIndex = actionStateHookIndex), (initialState = request[0])));
      }
      var boundAction = action.bind(null, initialState);
      action = function (payload) {
        boundAction(payload);
      };
      "function" === typeof boundAction.$$FORM_ACTION &&
        (action.$$FORM_ACTION = function (prefix) {
          prefix = boundAction.$$FORM_ACTION(prefix);
          void 0 !== permalink && ((permalink += ""), (prefix.action = permalink));
          var formData = prefix.data;
          formData &&
            (null === nextPostbackStateKey &&
              (nextPostbackStateKey =
                void 0 !== permalink
                  ? "p" + permalink
                  : "k" +
                    murmurhash3_32_gc(
                      JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                      0,
                    )),
            formData.append("$ACTION_KEY", nextPostbackStateKey));
          return prefix;
        });
      return [initialState, action, !1];
    }
    var boundAction$22 = action.bind(null, initialState);
    return [
      initialState,
      function (payload) {
        boundAction$22(payload);
      },
      !1,
    ];
  }
  function unwrapThenable(thenable) {
    var index = thenableIndexCounter;
    thenableIndexCounter += 1;
    null === thenableState && (thenableState = []);
    return trackUsedThenable(thenableState, thenable, index);
  }
  function unsupportedRefresh() {
    throw Error("Cache cannot be refreshed during server rendering.");
  }
  var HooksDispatcher = {
      readContext: function (context) {
        return context._currentValue;
      },
      use: function (usable) {
        if (null !== usable && "object" === typeof usable) {
          if ("function" === typeof usable.then) return unwrapThenable(usable);
          if (usable.$$typeof === REACT_CONTEXT_TYPE) return usable._currentValue;
        }
        throw Error("An unsupported type was passed to use(): " + String(usable));
      },
      useContext: function (context) {
        resolveCurrentlyRenderingComponent();
        return context._currentValue;
      },
      useMemo,
      useReducer,
      useRef: function (initialValue) {
        currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
        workInProgressHook = createWorkInProgressHook();
        var previousRef = workInProgressHook.memoizedState;
        return null === previousRef
          ? ((initialValue = { current: initialValue }),
            (workInProgressHook.memoizedState = initialValue))
          : previousRef;
      },
      useState: function (initialState) {
        return useReducer(basicStateReducer, initialState);
      },
      useInsertionEffect: noop,
      useLayoutEffect: noop,
      useCallback: function (callback, deps) {
        return useMemo(function () {
          return callback;
        }, deps);
      },
      useImperativeHandle: noop,
      useEffect: noop,
      useDebugValue: noop,
      useDeferredValue: function (value, initialValue) {
        resolveCurrentlyRenderingComponent();
        return void 0 !== initialValue ? initialValue : value;
      },
      useTransition: function () {
        resolveCurrentlyRenderingComponent();
        return [!1, unsupportedStartTransition];
      },
      useId: function () {
        var JSCompiler_inline_result = currentlyRenderingTask.treeContext;
        var overflow = JSCompiler_inline_result.overflow;
        JSCompiler_inline_result = JSCompiler_inline_result.id;
        JSCompiler_inline_result =
          (JSCompiler_inline_result & ~(1 << (32 - clz32(JSCompiler_inline_result) - 1))).toString(
            32,
          ) + overflow;
        var resumableState = currentResumableState;
        if (null === resumableState)
          throw Error(
            "Invalid hook call. Hooks can only be called inside of the body of a function component.",
          );
        overflow = localIdCounter++;
        JSCompiler_inline_result = "_" + resumableState.idPrefix + "R_" + JSCompiler_inline_result;
        0 < overflow && (JSCompiler_inline_result += "H" + overflow.toString(32));
        return JSCompiler_inline_result + "_";
      },
      useSyncExternalStore: function (subscribe, getSnapshot, getServerSnapshot) {
        if (void 0 === getServerSnapshot)
          throw Error(
            "Missing getServerSnapshot, which is required for server-rendered content. Will revert to client rendering.",
          );
        return getServerSnapshot();
      },
      useOptimistic: function (passthrough) {
        resolveCurrentlyRenderingComponent();
        return [passthrough, unsupportedSetOptimisticState];
      },
      useActionState,
      useFormState: useActionState,
      useHostTransitionStatus: function () {
        resolveCurrentlyRenderingComponent();
        return sharedNotPendingObject;
      },
      useMemoCache: function (size) {
        for (var data = Array(size), i = 0; i < size; i++) data[i] = REACT_MEMO_CACHE_SENTINEL;
        return data;
      },
      useCacheRefresh: function () {
        return unsupportedRefresh;
      },
      useEffectEvent: function () {
        return throwOnUseEffectEventCall;
      },
    },
    currentResumableState = null,
    DefaultAsyncDispatcher = {
      getCacheForType: function () {
        throw Error("Not implemented.");
      },
      cacheSignal: function () {
        throw Error("Not implemented.");
      },
    };
  function prepareStackTrace(error, structuredStackTrace) {
    error = (error.name || "Error") + ": " + (error.message || "");
    for (var i = 0; i < structuredStackTrace.length; i++)
      error += "\n    at " + structuredStackTrace[i].toString();
    return error;
  }
  var prefix, suffix;
  function describeBuiltInComponentFrame(name) {
    if (void 0 === prefix)
      try {
        throw Error();
      } catch (x) {
        var match = x.stack.trim().match(/\n( *(at )?)/);
        prefix = (match && match[1]) || "";
        suffix =
          -1 < x.stack.indexOf("\n    at")
            ? " (<anonymous>)"
            : -1 < x.stack.indexOf("@")
              ? "@unknown:0:0"
              : "";
      }
    return "\n" + prefix + name + suffix;
  }
  var reentry = !1;
  function describeNativeComponentFrame(fn, construct) {
    if (!fn || reentry) return "";
    reentry = !0;
    var previousPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = prepareStackTrace;
    try {
      var RunInRootFrame = {
        DetermineComponentFrameRoot: function () {
          try {
            if (construct) {
              var Fake = function () {
                throw Error();
              };
              Object.defineProperty(Fake.prototype, "props", {
                set: function () {
                  throw Error();
                },
              });
              if ("object" === typeof Reflect && Reflect.construct) {
                try {
                  Reflect.construct(Fake, []);
                } catch (x) {
                  var control = x;
                }
                Reflect.construct(fn, [], Fake);
              } else {
                try {
                  Fake.call();
                } catch (x$24) {
                  control = x$24;
                }
                fn.call(Fake.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (x$25) {
                control = x$25;
              }
              (Fake = fn()) && "function" === typeof Fake.catch && Fake.catch(function () {});
            }
          } catch (sample) {
            if (sample && control && "string" === typeof sample.stack)
              return [sample.stack, control.stack];
          }
          return [null, null];
        },
      };
      RunInRootFrame.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var namePropDescriptor = Object.getOwnPropertyDescriptor(
        RunInRootFrame.DetermineComponentFrameRoot,
        "name",
      );
      namePropDescriptor &&
        namePropDescriptor.configurable &&
        Object.defineProperty(RunInRootFrame.DetermineComponentFrameRoot, "name", {
          value: "DetermineComponentFrameRoot",
        });
      var _RunInRootFrame$Deter = RunInRootFrame.DetermineComponentFrameRoot(),
        sampleStack = _RunInRootFrame$Deter[0],
        controlStack = _RunInRootFrame$Deter[1];
      if (sampleStack && controlStack) {
        var sampleLines = sampleStack.split("\n"),
          controlLines = controlStack.split("\n");
        for (
          namePropDescriptor = RunInRootFrame = 0;
          RunInRootFrame < sampleLines.length &&
          !sampleLines[RunInRootFrame].includes("DetermineComponentFrameRoot");
        )
          RunInRootFrame++;
        for (
          ;
          namePropDescriptor < controlLines.length &&
          !controlLines[namePropDescriptor].includes("DetermineComponentFrameRoot");
        )
          namePropDescriptor++;
        if (RunInRootFrame === sampleLines.length || namePropDescriptor === controlLines.length)
          for (
            RunInRootFrame = sampleLines.length - 1, namePropDescriptor = controlLines.length - 1;
            1 <= RunInRootFrame &&
            0 <= namePropDescriptor &&
            sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor];
          )
            namePropDescriptor--;
        for (
          ;
          1 <= RunInRootFrame && 0 <= namePropDescriptor;
          RunInRootFrame--, namePropDescriptor--
        )
          if (sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor]) {
            if (1 !== RunInRootFrame || 1 !== namePropDescriptor)
              do
                if (
                  (RunInRootFrame--,
                  namePropDescriptor--,
                  0 > namePropDescriptor ||
                    sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor])
                ) {
                  var frame = "\n" + sampleLines[RunInRootFrame].replace(" at new ", " at ");
                  fn.displayName &&
                    frame.includes("<anonymous>") &&
                    (frame = frame.replace("<anonymous>", fn.displayName));
                  return frame;
                }
              while (1 <= RunInRootFrame && 0 <= namePropDescriptor);
            break;
          }
      }
    } finally {
      ((reentry = !1), (Error.prepareStackTrace = previousPrepareStackTrace));
    }
    return (previousPrepareStackTrace = fn ? fn.displayName || fn.name : "")
      ? describeBuiltInComponentFrame(previousPrepareStackTrace)
      : "";
  }
  function describeComponentStackByType(type) {
    if ("string" === typeof type) return describeBuiltInComponentFrame(type);
    if ("function" === typeof type)
      return type.prototype && type.prototype.isReactComponent
        ? describeNativeComponentFrame(type, !0)
        : describeNativeComponentFrame(type, !1);
    if ("object" === typeof type && null !== type) {
      switch (type.$$typeof) {
        case REACT_FORWARD_REF_TYPE:
          return describeNativeComponentFrame(type.render, !1);
        case REACT_MEMO_TYPE:
          return describeNativeComponentFrame(type.type, !1);
        case REACT_LAZY_TYPE:
          var lazyComponent = type,
            payload = lazyComponent._payload;
          lazyComponent = lazyComponent._init;
          try {
            type = lazyComponent(payload);
          } catch (x) {
            return describeBuiltInComponentFrame("Lazy");
          }
          return describeComponentStackByType(type);
      }
      if ("string" === typeof type.name) {
        a: {
          payload = type.name;
          lazyComponent = type.env;
          var location = type.debugLocation;
          if (
            null != location &&
            ((type = Error.prepareStackTrace),
            (Error.prepareStackTrace = prepareStackTrace),
            (location = location.stack),
            (Error.prepareStackTrace = type),
            location.startsWith("Error: react-stack-top-frame\n") &&
              (location = location.slice(29)),
            (type = location.indexOf("\n")),
            -1 !== type && (location = location.slice(type + 1)),
            (type = location.indexOf("react_stack_bottom_frame")),
            -1 !== type && (type = location.lastIndexOf("\n", type)),
            (type = -1 !== type ? (location = location.slice(0, type)) : ""),
            (location = type.lastIndexOf("\n")),
            (type = -1 === location ? type : type.slice(location + 1)),
            -1 !== type.indexOf(payload))
          ) {
            payload = "\n" + type;
            break a;
          }
          payload = describeBuiltInComponentFrame(
            payload + (lazyComponent ? " [" + lazyComponent + "]" : ""),
          );
        }
        return payload;
      }
    }
    switch (type) {
      case REACT_SUSPENSE_LIST_TYPE:
        return describeBuiltInComponentFrame("SuspenseList");
      case REACT_SUSPENSE_TYPE:
        return describeBuiltInComponentFrame("Suspense");
    }
    return "";
  }
  function isEligibleForOutlining(request, boundary) {
    return (
      (500 < boundary.byteSize || hasSuspenseyContent(boundary.contentState)) &&
      null === boundary.contentPreamble
    );
  }
  function defaultErrorHandler(error) {
    if ("object" === typeof error && null !== error && "string" === typeof error.environmentName) {
      var JSCompiler_inline_result = error.environmentName;
      error = [error].slice(0);
      "string" === typeof error[0]
        ? error.splice(
            0,
            1,
            "\x1B[0m\x1B[7m%c%s\x1B[0m%c " + error[0],
            "background: #e6e6e6;background: light-dark(rgba(0,0,0,0.1), rgba(255,255,255,0.25));color: #000000;color: light-dark(#000000, #ffffff);border-radius: 2px",
            " " + JSCompiler_inline_result + " ",
            "",
          )
        : error.splice(
            0,
            0,
            "\x1B[0m\x1B[7m%c%s\x1B[0m%c",
            "background: #e6e6e6;background: light-dark(rgba(0,0,0,0.1), rgba(255,255,255,0.25));color: #000000;color: light-dark(#000000, #ffffff);border-radius: 2px",
            " " + JSCompiler_inline_result + " ",
            "",
          );
      error.unshift(console);
      JSCompiler_inline_result = bind.apply(console.error, error);
      JSCompiler_inline_result();
    } else console.error(error);
    return null;
  }
  function RequestInstance(
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    formState,
  ) {
    var abortSet = /* @__PURE__ */ new Set();
    this.destination = null;
    this.flushScheduled = !1;
    this.resumableState = resumableState;
    this.renderState = renderState;
    this.rootFormatContext = rootFormatContext;
    this.progressiveChunkSize = void 0 === progressiveChunkSize ? 12800 : progressiveChunkSize;
    this.status = 10;
    this.fatalError = null;
    this.pendingRootTasks = this.allPendingTasks = this.nextSegmentId = 0;
    this.completedPreambleSegments = this.completedRootSegment = null;
    this.byteSize = 0;
    this.abortableTasks = abortSet;
    this.pingedTasks = [];
    this.clientRenderedBoundaries = [];
    this.completedBoundaries = [];
    this.partialBoundaries = [];
    this.trackedPostpones = null;
    this.onError = void 0 === onError ? defaultErrorHandler : onError;
    this.onPostpone = void 0 === onPostpone ? noop : onPostpone;
    this.onAllReady = void 0 === onAllReady ? noop : onAllReady;
    this.onShellReady = void 0 === onShellReady ? noop : onShellReady;
    this.onShellError = void 0 === onShellError ? noop : onShellError;
    this.onFatalError = void 0 === onFatalError ? noop : onFatalError;
    this.formState = void 0 === formState ? null : formState;
  }
  function createRequest(
    children,
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    formState,
  ) {
    resumableState = new RequestInstance(
      resumableState,
      renderState,
      rootFormatContext,
      progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      formState,
    );
    renderState = createPendingSegment(resumableState, 0, null, rootFormatContext, !1, !1);
    renderState.parentFlushed = !0;
    children = createRenderTask(
      resumableState,
      null,
      children,
      -1,
      null,
      renderState,
      null,
      null,
      resumableState.abortableTasks,
      null,
      rootFormatContext,
      null,
      emptyTreeContext,
      null,
      null,
    );
    pushComponentStack(children);
    resumableState.pingedTasks.push(children);
    return resumableState;
  }
  function createPrerenderRequest(
    children,
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
  ) {
    children = createRequest(
      children,
      resumableState,
      renderState,
      rootFormatContext,
      progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      void 0,
    );
    children.trackedPostpones = {
      workingMap: /* @__PURE__ */ new Map(),
      rootNodes: [],
      rootSlots: null,
    };
    return children;
  }
  function resumeRequest(
    children,
    postponedState,
    renderState,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
  ) {
    renderState = new RequestInstance(
      postponedState.resumableState,
      renderState,
      postponedState.rootFormatContext,
      postponedState.progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      null,
    );
    renderState.nextSegmentId = postponedState.nextSegmentId;
    if ("number" === typeof postponedState.replaySlots)
      return (
        (onError = createPendingSegment(
          renderState,
          0,
          null,
          postponedState.rootFormatContext,
          !1,
          !1,
        )),
        (onError.parentFlushed = !0),
        (children = createRenderTask(
          renderState,
          null,
          children,
          -1,
          null,
          onError,
          null,
          null,
          renderState.abortableTasks,
          null,
          postponedState.rootFormatContext,
          null,
          emptyTreeContext,
          null,
          null,
        )),
        pushComponentStack(children),
        renderState.pingedTasks.push(children),
        renderState
      );
    children = createReplayTask(
      renderState,
      null,
      {
        nodes: postponedState.replayNodes,
        slots: postponedState.replaySlots,
        pendingTasks: 0,
      },
      children,
      -1,
      null,
      null,
      renderState.abortableTasks,
      null,
      postponedState.rootFormatContext,
      null,
      emptyTreeContext,
      null,
      null,
    );
    pushComponentStack(children);
    renderState.pingedTasks.push(children);
    return renderState;
  }
  function resumeAndPrerenderRequest(
    children,
    postponedState,
    renderState,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
  ) {
    children = resumeRequest(
      children,
      postponedState,
      renderState,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
    );
    children.trackedPostpones = {
      workingMap: /* @__PURE__ */ new Map(),
      rootNodes: [],
      rootSlots: null,
    };
    return children;
  }
  var currentRequest = null;
  function resolveRequest() {
    if (currentRequest) return currentRequest;
    if (supportsRequestStorage) {
      var store = requestStorage.getStore();
      if (store) return store;
    }
    return null;
  }
  function pingTask(request, task) {
    request.pingedTasks.push(task);
    1 === request.pingedTasks.length &&
      ((request.flushScheduled = null !== request.destination),
      null !== request.trackedPostpones || 10 === request.status
        ? scheduleMicrotask(function () {
            return performWork(request);
          })
        : setTimeout(function () {
            return performWork(request);
          }, 0));
  }
  function createSuspenseBoundary(
    request,
    row,
    fallbackAbortableTasks,
    contentPreamble,
    fallbackPreamble,
  ) {
    fallbackAbortableTasks = {
      status: 0,
      rootSegmentID: -1,
      parentFlushed: !1,
      pendingTasks: 0,
      row,
      completedSegments: [],
      byteSize: 0,
      fallbackAbortableTasks,
      errorDigest: null,
      contentState: createHoistableState(),
      fallbackState: createHoistableState(),
      contentPreamble,
      fallbackPreamble,
      trackedContentKeyPath: null,
      trackedFallbackNode: null,
    };
    null !== row &&
      (row.pendingTasks++,
      (contentPreamble = row.boundaries),
      null !== contentPreamble &&
        (request.allPendingTasks++,
        fallbackAbortableTasks.pendingTasks++,
        contentPreamble.push(fallbackAbortableTasks)),
      (request = row.inheritedHoistables),
      null !== request && hoistHoistables(fallbackAbortableTasks.contentState, request));
    return fallbackAbortableTasks;
  }
  function createRenderTask(
    request,
    thenableState,
    node,
    childIndex,
    blockedBoundary,
    blockedSegment,
    blockedPreamble,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    row,
    componentStack,
  ) {
    request.allPendingTasks++;
    null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
    null !== row && row.pendingTasks++;
    var task = {
      replay: null,
      node,
      childIndex,
      ping: function () {
        return pingTask(request, task);
      },
      blockedBoundary,
      blockedSegment,
      blockedPreamble,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
      thenableState,
    };
    abortSet.add(task);
    return task;
  }
  function createReplayTask(
    request,
    thenableState,
    replay,
    node,
    childIndex,
    blockedBoundary,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    row,
    componentStack,
  ) {
    request.allPendingTasks++;
    null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
    null !== row && row.pendingTasks++;
    replay.pendingTasks++;
    var task = {
      replay,
      node,
      childIndex,
      ping: function () {
        return pingTask(request, task);
      },
      blockedBoundary,
      blockedSegment: null,
      blockedPreamble: null,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
      thenableState,
    };
    abortSet.add(task);
    return task;
  }
  function createPendingSegment(
    request,
    index,
    boundary,
    parentFormatContext,
    lastPushedText,
    textEmbedded,
  ) {
    return {
      status: 0,
      parentFlushed: !1,
      id: -1,
      index,
      chunks: [],
      children: [],
      preambleChildren: [],
      parentFormatContext,
      boundary,
      lastPushedText,
      textEmbedded,
    };
  }
  function pushComponentStack(task) {
    var node = task.node;
    if ("object" === typeof node && null !== node)
      switch (node.$$typeof) {
        case REACT_ELEMENT_TYPE:
          task.componentStack = {
            parent: task.componentStack,
            type: node.type,
          };
      }
  }
  function replaceSuspenseComponentStackWithSuspenseFallbackStack(componentStack) {
    return null === componentStack
      ? null
      : {
          parent: componentStack.parent,
          type: "Suspense Fallback",
        };
  }
  function getThrownInfo(node$jscomp$0) {
    var errorInfo = {};
    node$jscomp$0 &&
      Object.defineProperty(errorInfo, "componentStack", {
        configurable: !0,
        enumerable: !0,
        get: function () {
          try {
            var info = "",
              node = node$jscomp$0;
            do ((info += describeComponentStackByType(node.type)), (node = node.parent));
            while (node);
            var JSCompiler_inline_result = info;
          } catch (x) {
            JSCompiler_inline_result = "\nError generating stack: " + x.message + "\n" + x.stack;
          }
          Object.defineProperty(errorInfo, "componentStack", { value: JSCompiler_inline_result });
          return JSCompiler_inline_result;
        },
      });
    return errorInfo;
  }
  function logRecoverableError(request, error, errorInfo) {
    request = request.onError;
    error = request(error, errorInfo);
    if (null == error || "string" === typeof error) return error;
  }
  function fatalError(request, error) {
    var onShellError = request.onShellError,
      onFatalError = request.onFatalError;
    onShellError(error);
    onFatalError(error);
    null !== request.destination
      ? ((request.status = 14), closeWithError(request.destination, error))
      : ((request.status = 13), (request.fatalError = error));
  }
  function finishSuspenseListRow(request, row) {
    unblockSuspenseListRow(request, row.next, row.hoistables);
  }
  function unblockSuspenseListRow(request, unblockedRow, inheritedHoistables) {
    for (; null !== unblockedRow; ) {
      null !== inheritedHoistables &&
        (hoistHoistables(unblockedRow.hoistables, inheritedHoistables),
        (unblockedRow.inheritedHoistables = inheritedHoistables));
      var unblockedBoundaries = unblockedRow.boundaries;
      if (null !== unblockedBoundaries) {
        unblockedRow.boundaries = null;
        for (var i = 0; i < unblockedBoundaries.length; i++) {
          var unblockedBoundary = unblockedBoundaries[i];
          null !== inheritedHoistables &&
            hoistHoistables(unblockedBoundary.contentState, inheritedHoistables);
          finishedTask(request, unblockedBoundary, null, null);
        }
      }
      unblockedRow.pendingTasks--;
      if (0 < unblockedRow.pendingTasks) break;
      inheritedHoistables = unblockedRow.hoistables;
      unblockedRow = unblockedRow.next;
    }
  }
  function tryToResolveTogetherRow(request, togetherRow) {
    var boundaries = togetherRow.boundaries;
    if (null !== boundaries && togetherRow.pendingTasks === boundaries.length) {
      for (var allCompleteAndInlinable = !0, i = 0; i < boundaries.length; i++) {
        var rowBoundary = boundaries[i];
        if (
          1 !== rowBoundary.pendingTasks ||
          rowBoundary.parentFlushed ||
          isEligibleForOutlining(request, rowBoundary)
        ) {
          allCompleteAndInlinable = !1;
          break;
        }
      }
      allCompleteAndInlinable &&
        unblockSuspenseListRow(request, togetherRow, togetherRow.hoistables);
    }
  }
  function createSuspenseListRow(previousRow) {
    var newRow = {
      pendingTasks: 1,
      boundaries: null,
      hoistables: createHoistableState(),
      inheritedHoistables: null,
      together: !1,
      next: null,
    };
    null !== previousRow &&
      0 < previousRow.pendingTasks &&
      (newRow.pendingTasks++, (newRow.boundaries = []), (previousRow.next = newRow));
    return newRow;
  }
  function renderSuspenseListRows(request, task, keyPath, rows, revealOrder) {
    var prevKeyPath = task.keyPath,
      prevTreeContext = task.treeContext,
      prevRow = task.row;
    task.keyPath = keyPath;
    keyPath = rows.length;
    var previousSuspenseListRow = null;
    if (null !== task.replay) {
      var resumeSlots = task.replay.slots;
      if (null !== resumeSlots && "object" === typeof resumeSlots)
        for (var n = 0; n < keyPath; n++) {
          var i =
              "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
                ? n
                : keyPath - 1 - n,
            node = rows[i];
          task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
          task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
          var resumeSegmentID = resumeSlots[i];
          "number" === typeof resumeSegmentID
            ? (resumeNode(request, task, resumeSegmentID, node, i), delete resumeSlots[i])
            : renderNode(request, task, node, i);
          0 === --previousSuspenseListRow.pendingTasks &&
            finishSuspenseListRow(request, previousSuspenseListRow);
        }
      else
        for (resumeSlots = 0; resumeSlots < keyPath; resumeSlots++)
          ((n =
            "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
              ? resumeSlots
              : keyPath - 1 - resumeSlots),
            (i = rows[n]),
            (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
            (task.treeContext = pushTreeContext(prevTreeContext, keyPath, n)),
            renderNode(request, task, i, n),
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow));
    } else if ("backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder)
      for (revealOrder = 0; revealOrder < keyPath; revealOrder++)
        ((resumeSlots = rows[revealOrder]),
          (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
          (task.treeContext = pushTreeContext(prevTreeContext, keyPath, revealOrder)),
          renderNode(request, task, resumeSlots, revealOrder),
          0 === --previousSuspenseListRow.pendingTasks &&
            finishSuspenseListRow(request, previousSuspenseListRow));
    else {
      revealOrder = task.blockedSegment;
      resumeSlots = revealOrder.children.length;
      n = revealOrder.chunks.length;
      for (i = keyPath - 1; 0 <= i; i--) {
        node = rows[i];
        task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
        task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
        resumeSegmentID = createPendingSegment(
          request,
          n,
          null,
          task.formatContext,
          0 === i ? revealOrder.lastPushedText : !0,
          !0,
        );
        revealOrder.children.splice(resumeSlots, 0, resumeSegmentID);
        task.blockedSegment = resumeSegmentID;
        try {
          (renderNode(request, task, node, i),
            resumeSegmentID.lastPushedText &&
              resumeSegmentID.textEmbedded &&
              resumeSegmentID.chunks.push(textSeparator),
            (resumeSegmentID.status = 1),
            finishedSegment(request, task.blockedBoundary, resumeSegmentID),
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow));
        } catch (thrownValue) {
          throw ((resumeSegmentID.status = 12 === request.status ? 3 : 4), thrownValue);
        }
      }
      task.blockedSegment = revealOrder;
      revealOrder.lastPushedText = !1;
    }
    null !== prevRow &&
      null !== previousSuspenseListRow &&
      0 < previousSuspenseListRow.pendingTasks &&
      (prevRow.pendingTasks++, (previousSuspenseListRow.next = prevRow));
    task.treeContext = prevTreeContext;
    task.row = prevRow;
    task.keyPath = prevKeyPath;
  }
  function renderWithHooks(request, task, keyPath, Component, props, secondArg) {
    var prevThenableState = task.thenableState;
    task.thenableState = null;
    currentlyRenderingComponent = {};
    currentlyRenderingTask = task;
    currentlyRenderingRequest = request;
    currentlyRenderingKeyPath = keyPath;
    actionStateCounter = localIdCounter = 0;
    actionStateMatchingIndex = -1;
    thenableIndexCounter = 0;
    thenableState = prevThenableState;
    for (request = Component(props, secondArg); didScheduleRenderPhaseUpdate; )
      ((didScheduleRenderPhaseUpdate = !1),
        (actionStateCounter = localIdCounter = 0),
        (actionStateMatchingIndex = -1),
        (thenableIndexCounter = 0),
        (numberOfReRenders += 1),
        (workInProgressHook = null),
        (request = Component(props, secondArg)));
    resetHooksState();
    return request;
  }
  function finishFunctionComponent(
    request,
    task,
    keyPath,
    children,
    hasId,
    actionStateCount,
    actionStateMatchingIndex,
  ) {
    var didEmitActionStateMarkers = !1;
    if (0 !== actionStateCount && null !== request.formState) {
      var segment = task.blockedSegment;
      if (null !== segment) {
        didEmitActionStateMarkers = !0;
        segment = segment.chunks;
        for (var i = 0; i < actionStateCount; i++)
          i === actionStateMatchingIndex
            ? segment.push(formStateMarkerIsMatching)
            : segment.push(formStateMarkerIsNotMatching);
      }
    }
    actionStateCount = task.keyPath;
    task.keyPath = keyPath;
    hasId
      ? ((keyPath = task.treeContext),
        (task.treeContext = pushTreeContext(keyPath, 1, 0)),
        renderNode(request, task, children, -1),
        (task.treeContext = keyPath))
      : didEmitActionStateMarkers
        ? renderNode(request, task, children, -1)
        : renderNodeDestructive(request, task, children, -1);
    task.keyPath = actionStateCount;
  }
  function renderElement(request, task, keyPath, type, props, ref) {
    if ("function" === typeof type)
      if (type.prototype && type.prototype.isReactComponent) {
        var newProps = props;
        if ("ref" in props) {
          newProps = {};
          for (var propName in props) "ref" !== propName && (newProps[propName] = props[propName]);
        }
        var defaultProps = type.defaultProps;
        if (defaultProps) {
          newProps === props && (newProps = assign({}, newProps, props));
          for (var propName$44 in defaultProps)
            void 0 === newProps[propName$44] && (newProps[propName$44] = defaultProps[propName$44]);
        }
        props = newProps;
        newProps = emptyContextObject;
        defaultProps = type.contextType;
        "object" === typeof defaultProps &&
          null !== defaultProps &&
          (newProps = defaultProps._currentValue);
        newProps = new type(props, newProps);
        var initialState = void 0 !== newProps.state ? newProps.state : null;
        newProps.updater = classComponentUpdater;
        newProps.props = props;
        newProps.state = initialState;
        defaultProps = {
          queue: [],
          replace: !1,
        };
        newProps._reactInternals = defaultProps;
        ref = type.contextType;
        newProps.context =
          "object" === typeof ref && null !== ref ? ref._currentValue : emptyContextObject;
        ref = type.getDerivedStateFromProps;
        "function" === typeof ref &&
          ((ref = ref(props, initialState)),
          (initialState =
            null === ref || void 0 === ref ? initialState : assign({}, initialState, ref)),
          (newProps.state = initialState));
        if (
          "function" !== typeof type.getDerivedStateFromProps &&
          "function" !== typeof newProps.getSnapshotBeforeUpdate &&
          ("function" === typeof newProps.UNSAFE_componentWillMount ||
            "function" === typeof newProps.componentWillMount)
        )
          if (
            ((type = newProps.state),
            "function" === typeof newProps.componentWillMount && newProps.componentWillMount(),
            "function" === typeof newProps.UNSAFE_componentWillMount &&
              newProps.UNSAFE_componentWillMount(),
            type !== newProps.state &&
              classComponentUpdater.enqueueReplaceState(newProps, newProps.state, null),
            null !== defaultProps.queue && 0 < defaultProps.queue.length)
          )
            if (
              ((type = defaultProps.queue),
              (ref = defaultProps.replace),
              (defaultProps.queue = null),
              (defaultProps.replace = !1),
              ref && 1 === type.length)
            )
              newProps.state = type[0];
            else {
              defaultProps = ref ? type[0] : newProps.state;
              initialState = !0;
              for (ref = ref ? 1 : 0; ref < type.length; ref++)
                ((propName$44 = type[ref]),
                  (propName$44 =
                    "function" === typeof propName$44
                      ? propName$44.call(newProps, defaultProps, props, void 0)
                      : propName$44),
                  null != propName$44 &&
                    (initialState
                      ? ((initialState = !1),
                        (defaultProps = assign({}, defaultProps, propName$44)))
                      : assign(defaultProps, propName$44)));
              newProps.state = defaultProps;
            }
          else defaultProps.queue = null;
        type = newProps.render();
        if (12 === request.status) throw null;
        props = task.keyPath;
        task.keyPath = keyPath;
        renderNodeDestructive(request, task, type, -1);
        task.keyPath = props;
      } else {
        type = renderWithHooks(request, task, keyPath, type, props, void 0);
        if (12 === request.status) throw null;
        finishFunctionComponent(
          request,
          task,
          keyPath,
          type,
          0 !== localIdCounter,
          actionStateCounter,
          actionStateMatchingIndex,
        );
      }
    else if ("string" === typeof type)
      if (((newProps = task.blockedSegment), null === newProps))
        ((newProps = props.children),
          (defaultProps = task.formatContext),
          (initialState = task.keyPath),
          (task.formatContext = getChildFormatContext(defaultProps, type, props)),
          (task.keyPath = keyPath),
          renderNode(request, task, newProps, -1),
          (task.formatContext = defaultProps),
          (task.keyPath = initialState));
      else {
        initialState = pushStartInstance(
          newProps.chunks,
          type,
          props,
          request.resumableState,
          request.renderState,
          task.blockedPreamble,
          task.hoistableState,
          task.formatContext,
          newProps.lastPushedText,
        );
        newProps.lastPushedText = !1;
        defaultProps = task.formatContext;
        ref = task.keyPath;
        task.keyPath = keyPath;
        if (
          3 ===
          (task.formatContext = getChildFormatContext(defaultProps, type, props)).insertionMode
        ) {
          keyPath = createPendingSegment(request, 0, null, task.formatContext, !1, !1);
          newProps.preambleChildren.push(keyPath);
          task.blockedSegment = keyPath;
          try {
            ((keyPath.status = 6),
              renderNode(request, task, initialState, -1),
              keyPath.lastPushedText && keyPath.textEmbedded && keyPath.chunks.push(textSeparator),
              (keyPath.status = 1),
              finishedSegment(request, task.blockedBoundary, keyPath));
          } finally {
            task.blockedSegment = newProps;
          }
        } else renderNode(request, task, initialState, -1);
        task.formatContext = defaultProps;
        task.keyPath = ref;
        a: {
          task = newProps.chunks;
          request = request.resumableState;
          switch (type) {
            case "title":
            case "style":
            case "script":
            case "area":
            case "base":
            case "br":
            case "col":
            case "embed":
            case "hr":
            case "img":
            case "input":
            case "keygen":
            case "link":
            case "meta":
            case "param":
            case "source":
            case "track":
            case "wbr":
              break a;
            case "body":
              if (1 >= defaultProps.insertionMode) {
                request.hasBody = !0;
                break a;
              }
              break;
            case "html":
              if (0 === defaultProps.insertionMode) {
                request.hasHtml = !0;
                break a;
              }
              break;
            case "head":
              if (1 >= defaultProps.insertionMode) break a;
          }
          task.push(endChunkForTag(type));
        }
        newProps.lastPushedText = !1;
      }
    else {
      switch (type) {
        case REACT_LEGACY_HIDDEN_TYPE:
        case REACT_STRICT_MODE_TYPE:
        case REACT_PROFILER_TYPE:
        case REACT_FRAGMENT_TYPE:
          type = task.keyPath;
          task.keyPath = keyPath;
          renderNodeDestructive(request, task, props.children, -1);
          task.keyPath = type;
          return;
        case REACT_ACTIVITY_TYPE:
          type = task.blockedSegment;
          null === type
            ? "hidden" !== props.mode &&
              ((type = task.keyPath),
              (task.keyPath = keyPath),
              renderNode(request, task, props.children, -1),
              (task.keyPath = type))
            : "hidden" !== props.mode &&
              (type.chunks.push(startActivityBoundary),
              (type.lastPushedText = !1),
              (newProps = task.keyPath),
              (task.keyPath = keyPath),
              renderNode(request, task, props.children, -1),
              (task.keyPath = newProps),
              type.chunks.push(endActivityBoundary),
              (type.lastPushedText = !1));
          return;
        case REACT_SUSPENSE_LIST_TYPE:
          a: {
            type = props.children;
            props = props.revealOrder;
            if (
              "forwards" === props ||
              "backwards" === props ||
              "unstable_legacy-backwards" === props
            ) {
              if (isArrayImpl(type)) {
                renderSuspenseListRows(request, task, keyPath, type, props);
                break a;
              }
              if ((newProps = getIteratorFn(type))) {
                if ((newProps = newProps.call(type))) {
                  defaultProps = newProps.next();
                  if (!defaultProps.done) {
                    do defaultProps = newProps.next();
                    while (!defaultProps.done);
                    renderSuspenseListRows(request, task, keyPath, type, props);
                  }
                  break a;
                }
              }
            }
            "together" === props
              ? ((props = task.keyPath),
                (newProps = task.row),
                (defaultProps = task.row = createSuspenseListRow(null)),
                (defaultProps.boundaries = []),
                (defaultProps.together = !0),
                (task.keyPath = keyPath),
                renderNodeDestructive(request, task, type, -1),
                0 === --defaultProps.pendingTasks && finishSuspenseListRow(request, defaultProps),
                (task.keyPath = props),
                (task.row = newProps),
                null !== newProps &&
                  0 < defaultProps.pendingTasks &&
                  (newProps.pendingTasks++, (defaultProps.next = newProps)))
              : ((props = task.keyPath),
                (task.keyPath = keyPath),
                renderNodeDestructive(request, task, type, -1),
                (task.keyPath = props));
          }
          return;
        case REACT_VIEW_TRANSITION_TYPE:
        case REACT_SCOPE_TYPE:
          throw Error("ReactDOMServer does not yet support scope components.");
        case REACT_SUSPENSE_TYPE:
          a: if (null !== task.replay) {
            type = task.keyPath;
            newProps = task.formatContext;
            defaultProps = task.row;
            task.keyPath = keyPath;
            task.formatContext = getSuspenseContentFormatContext(request.resumableState, newProps);
            task.row = null;
            keyPath = props.children;
            try {
              renderNode(request, task, keyPath, -1);
            } finally {
              ((task.keyPath = type), (task.formatContext = newProps), (task.row = defaultProps));
            }
          } else {
            type = task.keyPath;
            ref = task.formatContext;
            var prevRow = task.row;
            propName$44 = task.blockedBoundary;
            propName = task.blockedPreamble;
            var parentHoistableState = task.hoistableState,
              parentSegment = task.blockedSegment,
              fallback = props.fallback;
            props = props.children;
            var fallbackAbortSet = /* @__PURE__ */ new Set();
            var newBoundary =
              2 > task.formatContext.insertionMode
                ? createSuspenseBoundary(
                    request,
                    task.row,
                    fallbackAbortSet,
                    createPreambleState(),
                    createPreambleState(),
                  )
                : createSuspenseBoundary(request, task.row, fallbackAbortSet, null, null);
            null !== request.trackedPostpones && (newBoundary.trackedContentKeyPath = keyPath);
            var boundarySegment = createPendingSegment(
              request,
              parentSegment.chunks.length,
              newBoundary,
              task.formatContext,
              !1,
              !1,
            );
            parentSegment.children.push(boundarySegment);
            parentSegment.lastPushedText = !1;
            var contentRootSegment = createPendingSegment(
              request,
              0,
              null,
              task.formatContext,
              !1,
              !1,
            );
            contentRootSegment.parentFlushed = !0;
            if (null !== request.trackedPostpones) {
              newProps = task.componentStack;
              defaultProps = [keyPath[0], "Suspense Fallback", keyPath[2]];
              initialState = [defaultProps[1], defaultProps[2], [], null];
              request.trackedPostpones.workingMap.set(defaultProps, initialState);
              newBoundary.trackedFallbackNode = initialState;
              task.blockedSegment = boundarySegment;
              task.blockedPreamble = newBoundary.fallbackPreamble;
              task.keyPath = defaultProps;
              task.formatContext = getSuspenseFallbackFormatContext(request.resumableState, ref);
              task.componentStack =
                replaceSuspenseComponentStackWithSuspenseFallbackStack(newProps);
              boundarySegment.status = 6;
              try {
                (renderNode(request, task, fallback, -1),
                  boundarySegment.lastPushedText &&
                    boundarySegment.textEmbedded &&
                    boundarySegment.chunks.push(textSeparator),
                  (boundarySegment.status = 1),
                  finishedSegment(request, propName$44, boundarySegment));
              } catch (thrownValue) {
                throw ((boundarySegment.status = 12 === request.status ? 3 : 4), thrownValue);
              } finally {
                ((task.blockedSegment = parentSegment),
                  (task.blockedPreamble = propName),
                  (task.keyPath = type),
                  (task.formatContext = ref));
              }
              task = createRenderTask(
                request,
                null,
                props,
                -1,
                newBoundary,
                contentRootSegment,
                newBoundary.contentPreamble,
                newBoundary.contentState,
                task.abortSet,
                keyPath,
                getSuspenseContentFormatContext(request.resumableState, task.formatContext),
                task.context,
                task.treeContext,
                null,
                newProps,
              );
              pushComponentStack(task);
              request.pingedTasks.push(task);
            } else {
              task.blockedBoundary = newBoundary;
              task.blockedPreamble = newBoundary.contentPreamble;
              task.hoistableState = newBoundary.contentState;
              task.blockedSegment = contentRootSegment;
              task.keyPath = keyPath;
              task.formatContext = getSuspenseContentFormatContext(request.resumableState, ref);
              task.row = null;
              contentRootSegment.status = 6;
              try {
                if (
                  (renderNode(request, task, props, -1),
                  contentRootSegment.lastPushedText &&
                    contentRootSegment.textEmbedded &&
                    contentRootSegment.chunks.push(textSeparator),
                  (contentRootSegment.status = 1),
                  finishedSegment(request, newBoundary, contentRootSegment),
                  queueCompletedSegment(newBoundary, contentRootSegment),
                  0 === newBoundary.pendingTasks && 0 === newBoundary.status)
                ) {
                  if (((newBoundary.status = 1), !isEligibleForOutlining(request, newBoundary))) {
                    null !== prevRow &&
                      0 === --prevRow.pendingTasks &&
                      finishSuspenseListRow(request, prevRow);
                    0 === request.pendingRootTasks &&
                      task.blockedPreamble &&
                      preparePreamble(request);
                    break a;
                  }
                } else
                  null !== prevRow && prevRow.together && tryToResolveTogetherRow(request, prevRow);
              } catch (thrownValue$31) {
                ((newBoundary.status = 4),
                  12 === request.status
                    ? ((contentRootSegment.status = 3), (newProps = request.fatalError))
                    : ((contentRootSegment.status = 4), (newProps = thrownValue$31)),
                  (defaultProps = getThrownInfo(task.componentStack)),
                  (initialState = logRecoverableError(request, newProps, defaultProps)),
                  (newBoundary.errorDigest = initialState),
                  untrackBoundary(request, newBoundary));
              } finally {
                ((task.blockedBoundary = propName$44),
                  (task.blockedPreamble = propName),
                  (task.hoistableState = parentHoistableState),
                  (task.blockedSegment = parentSegment),
                  (task.keyPath = type),
                  (task.formatContext = ref),
                  (task.row = prevRow));
              }
              task = createRenderTask(
                request,
                null,
                fallback,
                -1,
                propName$44,
                boundarySegment,
                newBoundary.fallbackPreamble,
                newBoundary.fallbackState,
                fallbackAbortSet,
                [keyPath[0], "Suspense Fallback", keyPath[2]],
                getSuspenseFallbackFormatContext(request.resumableState, task.formatContext),
                task.context,
                task.treeContext,
                task.row,
                replaceSuspenseComponentStackWithSuspenseFallbackStack(task.componentStack),
              );
              pushComponentStack(task);
              request.pingedTasks.push(task);
            }
          }
          return;
      }
      if ("object" === typeof type && null !== type)
        switch (type.$$typeof) {
          case REACT_FORWARD_REF_TYPE:
            if ("ref" in props)
              for (parentSegment in ((newProps = {}), props))
                "ref" !== parentSegment && (newProps[parentSegment] = props[parentSegment]);
            else newProps = props;
            type = renderWithHooks(request, task, keyPath, type.render, newProps, ref);
            finishFunctionComponent(
              request,
              task,
              keyPath,
              type,
              0 !== localIdCounter,
              actionStateCounter,
              actionStateMatchingIndex,
            );
            return;
          case REACT_MEMO_TYPE:
            renderElement(request, task, keyPath, type.type, props, ref);
            return;
          case REACT_CONTEXT_TYPE:
            defaultProps = props.children;
            newProps = task.keyPath;
            props = props.value;
            initialState = type._currentValue;
            type._currentValue = props;
            ref = currentActiveSnapshot;
            currentActiveSnapshot = type = {
              parent: ref,
              depth: null === ref ? 0 : ref.depth + 1,
              context: type,
              parentValue: initialState,
              value: props,
            };
            task.context = type;
            task.keyPath = keyPath;
            renderNodeDestructive(request, task, defaultProps, -1);
            request = currentActiveSnapshot;
            if (null === request)
              throw Error("Tried to pop a Context at the root of the app. This is a bug in React.");
            request.context._currentValue = request.parentValue;
            request = currentActiveSnapshot = request.parent;
            task.context = request;
            task.keyPath = newProps;
            return;
          case REACT_CONSUMER_TYPE:
            props = props.children;
            type = props(type._context._currentValue);
            props = task.keyPath;
            task.keyPath = keyPath;
            renderNodeDestructive(request, task, type, -1);
            task.keyPath = props;
            return;
          case REACT_LAZY_TYPE:
            newProps = type._init;
            type = newProps(type._payload);
            if (12 === request.status) throw null;
            renderElement(request, task, keyPath, type, props, ref);
            return;
        }
      throw Error(
        "Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: " +
          ((null == type ? type : typeof type) + "."),
      );
    }
  }
  function resumeNode(request, task, segmentId, node, childIndex) {
    var prevReplay = task.replay,
      blockedBoundary = task.blockedBoundary,
      resumedSegment = createPendingSegment(request, 0, null, task.formatContext, !1, !1);
    resumedSegment.id = segmentId;
    resumedSegment.parentFlushed = !0;
    try {
      ((task.replay = null),
        (task.blockedSegment = resumedSegment),
        renderNode(request, task, node, childIndex),
        (resumedSegment.status = 1),
        finishedSegment(request, blockedBoundary, resumedSegment),
        null === blockedBoundary
          ? (request.completedRootSegment = resumedSegment)
          : (queueCompletedSegment(blockedBoundary, resumedSegment),
            blockedBoundary.parentFlushed && request.partialBoundaries.push(blockedBoundary)));
    } finally {
      ((task.replay = prevReplay), (task.blockedSegment = null));
    }
  }
  function renderNodeDestructive(request, task, node, childIndex) {
    null !== task.replay && "number" === typeof task.replay.slots
      ? resumeNode(request, task, task.replay.slots, node, childIndex)
      : ((task.node = node),
        (task.childIndex = childIndex),
        (node = task.componentStack),
        pushComponentStack(task),
        retryNode(request, task),
        (task.componentStack = node));
  }
  function retryNode(request, task) {
    var node = task.node,
      childIndex = task.childIndex;
    if (null !== node) {
      if ("object" === typeof node) {
        switch (node.$$typeof) {
          case REACT_ELEMENT_TYPE:
            var type = node.type,
              key = node.key,
              props = node.props;
            node = props.ref;
            var ref = void 0 !== node ? node : null,
              name = getComponentNameFromType(type),
              keyOrIndex = null == key ? (-1 === childIndex ? 0 : childIndex) : key;
            key = [task.keyPath, name, keyOrIndex];
            if (null !== task.replay)
              a: {
                var replay = task.replay;
                childIndex = replay.nodes;
                for (node = 0; node < childIndex.length; node++) {
                  var node$jscomp$0 = childIndex[node];
                  if (keyOrIndex === node$jscomp$0[1]) {
                    if (4 === node$jscomp$0.length) {
                      if (null !== name && name !== node$jscomp$0[0])
                        throw Error(
                          "Expected the resume to render <" +
                            node$jscomp$0[0] +
                            "> in this slot but instead it rendered <" +
                            name +
                            ">. The tree doesn't match so React will fallback to client rendering.",
                        );
                      var childNodes = node$jscomp$0[2];
                      name = node$jscomp$0[3];
                      keyOrIndex = task.node;
                      task.replay = {
                        nodes: childNodes,
                        slots: name,
                        pendingTasks: 1,
                      };
                      try {
                        renderElement(request, task, key, type, props, ref);
                        if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                          throw Error(
                            "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
                          );
                        task.replay.pendingTasks--;
                      } catch (x) {
                        if (
                          "object" === typeof x &&
                          null !== x &&
                          (x === SuspenseException || "function" === typeof x.then)
                        )
                          throw (
                            task.node === keyOrIndex
                              ? (task.replay = replay)
                              : childIndex.splice(node, 1),
                            x
                          );
                        task.replay.pendingTasks--;
                        props = getThrownInfo(task.componentStack);
                        key = request;
                        request = task.blockedBoundary;
                        type = x;
                        props = logRecoverableError(key, type, props);
                        abortRemainingReplayNodes(key, request, childNodes, name, type, props);
                      }
                      task.replay = replay;
                    } else {
                      if (type !== REACT_SUSPENSE_TYPE)
                        throw Error(
                          "Expected the resume to render <Suspense> in this slot but instead it rendered <" +
                            (getComponentNameFromType(type) || "Unknown") +
                            ">. The tree doesn't match so React will fallback to client rendering.",
                        );
                      b: {
                        replay = void 0;
                        type = node$jscomp$0[5];
                        ref = node$jscomp$0[2];
                        name = node$jscomp$0[3];
                        keyOrIndex = null === node$jscomp$0[4] ? [] : node$jscomp$0[4][2];
                        node$jscomp$0 = null === node$jscomp$0[4] ? null : node$jscomp$0[4][3];
                        var prevKeyPath = task.keyPath,
                          prevContext = task.formatContext,
                          prevRow = task.row,
                          previousReplaySet = task.replay,
                          parentBoundary = task.blockedBoundary,
                          parentHoistableState = task.hoistableState,
                          content = props.children,
                          fallback = props.fallback,
                          fallbackAbortSet = /* @__PURE__ */ new Set();
                        props =
                          2 > task.formatContext.insertionMode
                            ? createSuspenseBoundary(
                                request,
                                task.row,
                                fallbackAbortSet,
                                createPreambleState(),
                                createPreambleState(),
                              )
                            : createSuspenseBoundary(
                                request,
                                task.row,
                                fallbackAbortSet,
                                null,
                                null,
                              );
                        props.parentFlushed = !0;
                        props.rootSegmentID = type;
                        task.blockedBoundary = props;
                        task.hoistableState = props.contentState;
                        task.keyPath = key;
                        task.formatContext = getSuspenseContentFormatContext(
                          request.resumableState,
                          prevContext,
                        );
                        task.row = null;
                        task.replay = {
                          nodes: ref,
                          slots: name,
                          pendingTasks: 1,
                        };
                        try {
                          renderNode(request, task, content, -1);
                          if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                            throw Error(
                              "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
                            );
                          task.replay.pendingTasks--;
                          if (0 === props.pendingTasks && 0 === props.status) {
                            props.status = 1;
                            request.completedBoundaries.push(props);
                            break b;
                          }
                        } catch (error) {
                          ((props.status = 4),
                            (childNodes = getThrownInfo(task.componentStack)),
                            (replay = logRecoverableError(request, error, childNodes)),
                            (props.errorDigest = replay),
                            task.replay.pendingTasks--,
                            request.clientRenderedBoundaries.push(props));
                        } finally {
                          ((task.blockedBoundary = parentBoundary),
                            (task.hoistableState = parentHoistableState),
                            (task.replay = previousReplaySet),
                            (task.keyPath = prevKeyPath),
                            (task.formatContext = prevContext),
                            (task.row = prevRow));
                        }
                        childNodes = createReplayTask(
                          request,
                          null,
                          {
                            nodes: keyOrIndex,
                            slots: node$jscomp$0,
                            pendingTasks: 0,
                          },
                          fallback,
                          -1,
                          parentBoundary,
                          props.fallbackState,
                          fallbackAbortSet,
                          [key[0], "Suspense Fallback", key[2]],
                          getSuspenseFallbackFormatContext(
                            request.resumableState,
                            task.formatContext,
                          ),
                          task.context,
                          task.treeContext,
                          task.row,
                          replaceSuspenseComponentStackWithSuspenseFallbackStack(
                            task.componentStack,
                          ),
                        );
                        pushComponentStack(childNodes);
                        request.pingedTasks.push(childNodes);
                      }
                    }
                    childIndex.splice(node, 1);
                    break a;
                  }
                }
              }
            else renderElement(request, task, key, type, props, ref);
            return;
          case REACT_PORTAL_TYPE:
            throw Error(
              "Portals are not currently supported by the server renderer. Render them conditionally so that they only appear on the client render.",
            );
          case REACT_LAZY_TYPE:
            childNodes = node._init;
            node = childNodes(node._payload);
            if (12 === request.status) throw null;
            renderNodeDestructive(request, task, node, childIndex);
            return;
        }
        if (isArrayImpl(node)) {
          renderChildrenArray(request, task, node, childIndex);
          return;
        }
        if ((childNodes = getIteratorFn(node))) {
          if ((childNodes = childNodes.call(node))) {
            node = childNodes.next();
            if (!node.done) {
              props = [];
              do (props.push(node.value), (node = childNodes.next()));
              while (!node.done);
              renderChildrenArray(request, task, props, childIndex);
            }
            return;
          }
        }
        if ("function" === typeof node.then)
          return (
            (task.thenableState = null),
            renderNodeDestructive(request, task, unwrapThenable(node), childIndex)
          );
        if (node.$$typeof === REACT_CONTEXT_TYPE)
          return renderNodeDestructive(request, task, node._currentValue, childIndex);
        childIndex = Object.prototype.toString.call(node);
        throw Error(
          "Objects are not valid as a React child (found: " +
            ("[object Object]" === childIndex
              ? "object with keys {" + Object.keys(node).join(", ") + "}"
              : childIndex) +
            "). If you meant to render a collection of children, use an array instead.",
        );
      }
      if ("string" === typeof node)
        ((childIndex = task.blockedSegment),
          null !== childIndex &&
            (childIndex.lastPushedText = pushTextInstance(
              childIndex.chunks,
              node,
              request.renderState,
              childIndex.lastPushedText,
            )));
      else if ("number" === typeof node || "bigint" === typeof node)
        ((childIndex = task.blockedSegment),
          null !== childIndex &&
            (childIndex.lastPushedText = pushTextInstance(
              childIndex.chunks,
              "" + node,
              request.renderState,
              childIndex.lastPushedText,
            )));
    }
  }
  function renderChildrenArray(request, task, children, childIndex) {
    var prevKeyPath = task.keyPath;
    if (
      -1 !== childIndex &&
      ((task.keyPath = [task.keyPath, "Fragment", childIndex]), null !== task.replay)
    ) {
      for (
        var replay = task.replay, replayNodes = replay.nodes, j = 0;
        j < replayNodes.length;
        j++
      ) {
        var node = replayNodes[j];
        if (node[1] === childIndex) {
          childIndex = node[2];
          node = node[3];
          task.replay = {
            nodes: childIndex,
            slots: node,
            pendingTasks: 1,
          };
          try {
            renderChildrenArray(request, task, children, -1);
            if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
              throw Error(
                "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
              );
            task.replay.pendingTasks--;
          } catch (x) {
            if (
              "object" === typeof x &&
              null !== x &&
              (x === SuspenseException || "function" === typeof x.then)
            )
              throw x;
            task.replay.pendingTasks--;
            children = getThrownInfo(task.componentStack);
            var boundary = task.blockedBoundary,
              error = x;
            children = logRecoverableError(request, error, children);
            abortRemainingReplayNodes(request, boundary, childIndex, node, error, children);
          }
          task.replay = replay;
          replayNodes.splice(j, 1);
          break;
        }
      }
      task.keyPath = prevKeyPath;
      return;
    }
    replay = task.treeContext;
    replayNodes = children.length;
    if (null !== task.replay && ((j = task.replay.slots), null !== j && "object" === typeof j)) {
      for (childIndex = 0; childIndex < replayNodes; childIndex++)
        ((node = children[childIndex]),
          (task.treeContext = pushTreeContext(replay, replayNodes, childIndex)),
          (boundary = j[childIndex]),
          "number" === typeof boundary
            ? (resumeNode(request, task, boundary, node, childIndex), delete j[childIndex])
            : renderNode(request, task, node, childIndex));
      task.treeContext = replay;
      task.keyPath = prevKeyPath;
      return;
    }
    for (j = 0; j < replayNodes; j++)
      ((childIndex = children[j]),
        (task.treeContext = pushTreeContext(replay, replayNodes, j)),
        renderNode(request, task, childIndex, j));
    task.treeContext = replay;
    task.keyPath = prevKeyPath;
  }
  function trackPostponedBoundary(request, trackedPostpones, boundary) {
    boundary.status = 5;
    boundary.rootSegmentID = request.nextSegmentId++;
    request = boundary.trackedContentKeyPath;
    if (null === request)
      throw Error("It should not be possible to postpone at the root. This is a bug in React.");
    var fallbackReplayNode = boundary.trackedFallbackNode,
      children = [],
      boundaryNode = trackedPostpones.workingMap.get(request);
    if (void 0 === boundaryNode)
      return (
        (boundary = [
          request[1],
          request[2],
          children,
          null,
          fallbackReplayNode,
          boundary.rootSegmentID,
        ]),
        trackedPostpones.workingMap.set(request, boundary),
        addToReplayParent(boundary, request[0], trackedPostpones),
        boundary
      );
    boundaryNode[4] = fallbackReplayNode;
    boundaryNode[5] = boundary.rootSegmentID;
    return boundaryNode;
  }
  function trackPostpone(request, trackedPostpones, task, segment) {
    segment.status = 5;
    var keyPath = task.keyPath,
      boundary = task.blockedBoundary;
    if (null === boundary)
      ((segment.id = request.nextSegmentId++),
        (trackedPostpones.rootSlots = segment.id),
        null !== request.completedRootSegment && (request.completedRootSegment.status = 5));
    else {
      if (null !== boundary && 0 === boundary.status) {
        var boundaryNode = trackPostponedBoundary(request, trackedPostpones, boundary);
        if (boundary.trackedContentKeyPath === keyPath && -1 === task.childIndex) {
          -1 === segment.id &&
            (segment.id = segment.parentFlushed ? boundary.rootSegmentID : request.nextSegmentId++);
          boundaryNode[3] = segment.id;
          return;
        }
      }
      -1 === segment.id &&
        (segment.id =
          segment.parentFlushed && null !== boundary
            ? boundary.rootSegmentID
            : request.nextSegmentId++);
      if (-1 === task.childIndex)
        null === keyPath
          ? (trackedPostpones.rootSlots = segment.id)
          : ((task = trackedPostpones.workingMap.get(keyPath)),
            void 0 === task
              ? ((task = [keyPath[1], keyPath[2], [], segment.id]),
                addToReplayParent(task, keyPath[0], trackedPostpones))
              : (task[3] = segment.id));
      else {
        if (null === keyPath) {
          if (((request = trackedPostpones.rootSlots), null === request))
            request = trackedPostpones.rootSlots = {};
          else if ("number" === typeof request)
            throw Error(
              "It should not be possible to postpone both at the root of an element as well as a slot below. This is a bug in React.",
            );
        } else if (
          ((boundary = trackedPostpones.workingMap),
          (boundaryNode = boundary.get(keyPath)),
          void 0 === boundaryNode)
        )
          ((request = {}),
            (boundaryNode = [keyPath[1], keyPath[2], [], request]),
            boundary.set(keyPath, boundaryNode),
            addToReplayParent(boundaryNode, keyPath[0], trackedPostpones));
        else if (((request = boundaryNode[3]), null === request)) request = boundaryNode[3] = {};
        else if ("number" === typeof request)
          throw Error(
            "It should not be possible to postpone both at the root of an element as well as a slot below. This is a bug in React.",
          );
        request[task.childIndex] = segment.id;
      }
    }
  }
  function untrackBoundary(request, boundary) {
    request = request.trackedPostpones;
    null !== request &&
      ((boundary = boundary.trackedContentKeyPath),
      null !== boundary &&
        ((boundary = request.workingMap.get(boundary)),
        void 0 !== boundary && ((boundary.length = 4), (boundary[2] = []), (boundary[3] = null))));
  }
  function spawnNewSuspendedReplayTask(request, task, thenableState) {
    return createReplayTask(
      request,
      thenableState,
      task.replay,
      task.node,
      task.childIndex,
      task.blockedBoundary,
      task.hoistableState,
      task.abortSet,
      task.keyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.row,
      task.componentStack,
    );
  }
  function spawnNewSuspendedRenderTask(request, task, thenableState) {
    var segment = task.blockedSegment,
      newSegment = createPendingSegment(
        request,
        segment.chunks.length,
        null,
        task.formatContext,
        segment.lastPushedText,
        !0,
      );
    segment.children.push(newSegment);
    segment.lastPushedText = !1;
    return createRenderTask(
      request,
      thenableState,
      task.node,
      task.childIndex,
      task.blockedBoundary,
      newSegment,
      task.blockedPreamble,
      task.hoistableState,
      task.abortSet,
      task.keyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.row,
      task.componentStack,
    );
  }
  function renderNode(request, task, node, childIndex) {
    var previousFormatContext = task.formatContext,
      previousContext = task.context,
      previousKeyPath = task.keyPath,
      previousTreeContext = task.treeContext,
      previousComponentStack = task.componentStack,
      segment = task.blockedSegment;
    if (null === segment) {
      segment = task.replay;
      try {
        return renderNodeDestructive(request, task, node, childIndex);
      } catch (thrownValue) {
        if (
          (resetHooksState(),
          (node = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue),
          12 !== request.status && "object" === typeof node && null !== node)
        ) {
          if ("function" === typeof node.then) {
            childIndex =
              thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
            request = spawnNewSuspendedReplayTask(request, task, childIndex).ping;
            node.then(request, request);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            task.replay = segment;
            switchContext(previousContext);
            return;
          }
          if ("Maximum call stack size exceeded" === node.message) {
            node = thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
            node = spawnNewSuspendedReplayTask(request, task, node);
            request.pingedTasks.push(node);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            task.replay = segment;
            switchContext(previousContext);
            return;
          }
        }
      }
    } else {
      var childrenLength = segment.children.length,
        chunkLength = segment.chunks.length;
      try {
        return renderNodeDestructive(request, task, node, childIndex);
      } catch (thrownValue$63) {
        if (
          (resetHooksState(),
          (segment.children.length = childrenLength),
          (segment.chunks.length = chunkLength),
          (node = thrownValue$63 === SuspenseException ? getSuspendedThenable() : thrownValue$63),
          12 !== request.status && "object" === typeof node && null !== node)
        ) {
          if ("function" === typeof node.then) {
            segment = node;
            node = thrownValue$63 === SuspenseException ? getThenableStateAfterSuspending() : null;
            request = spawnNewSuspendedRenderTask(request, task, node).ping;
            segment.then(request, request);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            switchContext(previousContext);
            return;
          }
          if ("Maximum call stack size exceeded" === node.message) {
            segment =
              thrownValue$63 === SuspenseException ? getThenableStateAfterSuspending() : null;
            segment = spawnNewSuspendedRenderTask(request, task, segment);
            request.pingedTasks.push(segment);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            switchContext(previousContext);
            return;
          }
        }
      }
    }
    task.formatContext = previousFormatContext;
    task.context = previousContext;
    task.keyPath = previousKeyPath;
    task.treeContext = previousTreeContext;
    switchContext(previousContext);
    throw node;
  }
  function abortTaskSoft(task) {
    var boundary = task.blockedBoundary,
      segment = task.blockedSegment;
    null !== segment && ((segment.status = 3), finishedTask(this, boundary, task.row, segment));
  }
  function abortRemainingReplayNodes(
    request$jscomp$0,
    boundary,
    nodes,
    slots,
    error,
    errorDigest$jscomp$0,
  ) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (4 === node.length)
        abortRemainingReplayNodes(
          request$jscomp$0,
          boundary,
          node[2],
          node[3],
          error,
          errorDigest$jscomp$0,
        );
      else {
        node = node[5];
        var request = request$jscomp$0,
          errorDigest = errorDigest$jscomp$0,
          resumedBoundary = createSuspenseBoundary(
            request,
            null,
            /* @__PURE__ */ new Set(),
            null,
            null,
          );
        resumedBoundary.parentFlushed = !0;
        resumedBoundary.rootSegmentID = node;
        resumedBoundary.status = 4;
        resumedBoundary.errorDigest = errorDigest;
        resumedBoundary.parentFlushed && request.clientRenderedBoundaries.push(resumedBoundary);
      }
    }
    nodes.length = 0;
    if (null !== slots) {
      if (null === boundary)
        throw Error("We should not have any resumable nodes in the shell. This is a bug in React.");
      4 !== boundary.status &&
        ((boundary.status = 4),
        (boundary.errorDigest = errorDigest$jscomp$0),
        boundary.parentFlushed && request$jscomp$0.clientRenderedBoundaries.push(boundary));
      if ("object" === typeof slots) for (var index in slots) delete slots[index];
    }
  }
  function abortTask(task, request, error) {
    var boundary = task.blockedBoundary,
      segment = task.blockedSegment;
    if (null !== segment) {
      if (6 === segment.status) return;
      segment.status = 3;
    }
    var errorInfo = getThrownInfo(task.componentStack);
    if (null === boundary) {
      if (13 !== request.status && 14 !== request.status) {
        boundary = task.replay;
        if (null === boundary) {
          null !== request.trackedPostpones && null !== segment
            ? ((boundary = request.trackedPostpones),
              logRecoverableError(request, error, errorInfo),
              trackPostpone(request, boundary, task, segment),
              finishedTask(request, null, task.row, segment))
            : (logRecoverableError(request, error, errorInfo), fatalError(request, error));
          return;
        }
        boundary.pendingTasks--;
        0 === boundary.pendingTasks &&
          0 < boundary.nodes.length &&
          ((segment = logRecoverableError(request, error, errorInfo)),
          abortRemainingReplayNodes(request, null, boundary.nodes, boundary.slots, error, segment));
        request.pendingRootTasks--;
        0 === request.pendingRootTasks && completeShell(request);
      }
    } else {
      var trackedPostpones$64 = request.trackedPostpones;
      if (4 !== boundary.status) {
        if (null !== trackedPostpones$64 && null !== segment)
          return (
            logRecoverableError(request, error, errorInfo),
            trackPostpone(request, trackedPostpones$64, task, segment),
            boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
              return abortTask(fallbackTask, request, error);
            }),
            boundary.fallbackAbortableTasks.clear(),
            finishedTask(request, boundary, task.row, segment)
          );
        boundary.status = 4;
        segment = logRecoverableError(request, error, errorInfo);
        boundary.status = 4;
        boundary.errorDigest = segment;
        untrackBoundary(request, boundary);
        boundary.parentFlushed && request.clientRenderedBoundaries.push(boundary);
      }
      boundary.pendingTasks--;
      segment = boundary.row;
      null !== segment && 0 === --segment.pendingTasks && finishSuspenseListRow(request, segment);
      boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
        return abortTask(fallbackTask, request, error);
      });
      boundary.fallbackAbortableTasks.clear();
    }
    task = task.row;
    null !== task && 0 === --task.pendingTasks && finishSuspenseListRow(request, task);
    request.allPendingTasks--;
    0 === request.allPendingTasks && completeAll(request);
  }
  function safelyEmitEarlyPreloads(request, shellComplete) {
    try {
      var renderState = request.renderState,
        onHeaders = renderState.onHeaders;
      if (onHeaders) {
        var headers = renderState.headers;
        if (headers) {
          renderState.headers = null;
          var linkHeader = headers.preconnects;
          headers.fontPreloads &&
            (linkHeader && (linkHeader += ", "), (linkHeader += headers.fontPreloads));
          headers.highImagePreloads &&
            (linkHeader && (linkHeader += ", "), (linkHeader += headers.highImagePreloads));
          if (!shellComplete) {
            var queueIter = renderState.styles.values(),
              queueStep = queueIter.next();
            b: for (
              ;
              0 < headers.remainingCapacity && !queueStep.done;
              queueStep = queueIter.next()
            )
              for (
                var sheetIter = queueStep.value.sheets.values(), sheetStep = sheetIter.next();
                0 < headers.remainingCapacity && !sheetStep.done;
                sheetStep = sheetIter.next()
              ) {
                var sheet = sheetStep.value,
                  props = sheet.props,
                  key = props.href,
                  props$jscomp$0 = sheet.props,
                  header = getPreloadAsHeader(props$jscomp$0.href, "style", {
                    crossOrigin: props$jscomp$0.crossOrigin,
                    integrity: props$jscomp$0.integrity,
                    nonce: props$jscomp$0.nonce,
                    type: props$jscomp$0.type,
                    fetchPriority: props$jscomp$0.fetchPriority,
                    referrerPolicy: props$jscomp$0.referrerPolicy,
                    media: props$jscomp$0.media,
                  });
                if (0 <= (headers.remainingCapacity -= header.length + 2))
                  ((renderState.resets.style[key] = PRELOAD_NO_CREDS),
                    linkHeader && (linkHeader += ", "),
                    (linkHeader += header),
                    (renderState.resets.style[key] =
                      "string" === typeof props.crossOrigin || "string" === typeof props.integrity
                        ? [props.crossOrigin, props.integrity]
                        : PRELOAD_NO_CREDS));
                else break b;
              }
          }
          linkHeader ? onHeaders({ Link: linkHeader }) : onHeaders({});
        }
      }
    } catch (error) {
      logRecoverableError(request, error, {});
    }
  }
  function completeShell(request) {
    null === request.trackedPostpones && safelyEmitEarlyPreloads(request, !0);
    null === request.trackedPostpones && preparePreamble(request);
    request.onShellError = noop;
    request = request.onShellReady;
    request();
  }
  function completeAll(request) {
    safelyEmitEarlyPreloads(
      request,
      null === request.trackedPostpones
        ? !0
        : null === request.completedRootSegment || 5 !== request.completedRootSegment.status,
    );
    preparePreamble(request);
    request = request.onAllReady;
    request();
  }
  function queueCompletedSegment(boundary, segment) {
    if (
      0 === segment.chunks.length &&
      1 === segment.children.length &&
      null === segment.children[0].boundary &&
      -1 === segment.children[0].id
    ) {
      var childSegment = segment.children[0];
      childSegment.id = segment.id;
      childSegment.parentFlushed = !0;
      (1 !== childSegment.status && 3 !== childSegment.status && 4 !== childSegment.status) ||
        queueCompletedSegment(boundary, childSegment);
    } else boundary.completedSegments.push(segment);
  }
  function finishedSegment(request, boundary, segment) {
    if (null !== byteLengthOfChunk) {
      segment = segment.chunks;
      for (var segmentByteSize = 0, i = 0; i < segment.length; i++)
        segmentByteSize += segment[i].byteLength;
      null === boundary
        ? (request.byteSize += segmentByteSize)
        : (boundary.byteSize += segmentByteSize);
    }
  }
  function finishedTask(request, boundary, row, segment) {
    null !== row &&
      (0 === --row.pendingTasks
        ? finishSuspenseListRow(request, row)
        : row.together && tryToResolveTogetherRow(request, row));
    request.allPendingTasks--;
    if (null === boundary) {
      if (null !== segment && segment.parentFlushed) {
        if (null !== request.completedRootSegment)
          throw Error("There can only be one root segment. This is a bug in React.");
        request.completedRootSegment = segment;
      }
      request.pendingRootTasks--;
      0 === request.pendingRootTasks && completeShell(request);
    } else if ((boundary.pendingTasks--, 4 !== boundary.status))
      if (0 === boundary.pendingTasks) {
        if (
          (0 === boundary.status && (boundary.status = 1),
          null !== segment &&
            segment.parentFlushed &&
            (1 === segment.status || 3 === segment.status) &&
            queueCompletedSegment(boundary, segment),
          boundary.parentFlushed && request.completedBoundaries.push(boundary),
          1 === boundary.status)
        )
          ((row = boundary.row),
            null !== row && hoistHoistables(row.hoistables, boundary.contentState),
            isEligibleForOutlining(request, boundary) ||
              (boundary.fallbackAbortableTasks.forEach(abortTaskSoft, request),
              boundary.fallbackAbortableTasks.clear(),
              null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row)),
            0 === request.pendingRootTasks &&
              null === request.trackedPostpones &&
              null !== boundary.contentPreamble &&
              preparePreamble(request));
        else if (5 === boundary.status && ((boundary = boundary.row), null !== boundary)) {
          if (null !== request.trackedPostpones) {
            row = request.trackedPostpones;
            var postponedRow = boundary.next;
            if (null !== postponedRow && ((segment = postponedRow.boundaries), null !== segment))
              for (
                postponedRow.boundaries = null, postponedRow = 0;
                postponedRow < segment.length;
                postponedRow++
              ) {
                var postponedBoundary = segment[postponedRow];
                trackPostponedBoundary(request, row, postponedBoundary);
                finishedTask(request, postponedBoundary, null, null);
              }
          }
          0 === --boundary.pendingTasks && finishSuspenseListRow(request, boundary);
        }
      } else
        (null === segment ||
          !segment.parentFlushed ||
          (1 !== segment.status && 3 !== segment.status) ||
          (queueCompletedSegment(boundary, segment),
          1 === boundary.completedSegments.length &&
            boundary.parentFlushed &&
            request.partialBoundaries.push(boundary)),
          (boundary = boundary.row),
          null !== boundary && boundary.together && tryToResolveTogetherRow(request, boundary));
    0 === request.allPendingTasks && completeAll(request);
  }
  function performWork(request$jscomp$2) {
    if (14 !== request$jscomp$2.status && 13 !== request$jscomp$2.status) {
      var prevContext = currentActiveSnapshot,
        prevDispatcher = ReactSharedInternals.H;
      ReactSharedInternals.H = HooksDispatcher;
      var prevAsyncDispatcher = ReactSharedInternals.A;
      ReactSharedInternals.A = DefaultAsyncDispatcher;
      var prevRequest = currentRequest;
      currentRequest = request$jscomp$2;
      var prevResumableState = currentResumableState;
      currentResumableState = request$jscomp$2.resumableState;
      try {
        var pingedTasks = request$jscomp$2.pingedTasks,
          i;
        for (i = 0; i < pingedTasks.length; i++) {
          var task = pingedTasks[i],
            request = request$jscomp$2,
            segment = task.blockedSegment;
          if (null === segment) {
            var request$jscomp$0 = request;
            if (0 !== task.replay.pendingTasks) {
              switchContext(task.context);
              try {
                "number" === typeof task.replay.slots
                  ? resumeNode(
                      request$jscomp$0,
                      task,
                      task.replay.slots,
                      task.node,
                      task.childIndex,
                    )
                  : retryNode(request$jscomp$0, task);
                if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                  throw Error(
                    "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
                  );
                task.replay.pendingTasks--;
                task.abortSet.delete(task);
                finishedTask(request$jscomp$0, task.blockedBoundary, task.row, null);
              } catch (thrownValue) {
                resetHooksState();
                var x = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue;
                if ("object" === typeof x && null !== x && "function" === typeof x.then) {
                  var ping = task.ping;
                  x.then(ping, ping);
                  task.thenableState =
                    thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                } else {
                  task.replay.pendingTasks--;
                  task.abortSet.delete(task);
                  var errorInfo = getThrownInfo(task.componentStack);
                  request = void 0;
                  var request$jscomp$1 = request$jscomp$0,
                    boundary = task.blockedBoundary,
                    error$jscomp$0 =
                      12 === request$jscomp$0.status ? request$jscomp$0.fatalError : x,
                    replayNodes = task.replay.nodes,
                    resumeSlots = task.replay.slots;
                  request = logRecoverableError(request$jscomp$1, error$jscomp$0, errorInfo);
                  abortRemainingReplayNodes(
                    request$jscomp$1,
                    boundary,
                    replayNodes,
                    resumeSlots,
                    error$jscomp$0,
                    request,
                  );
                  request$jscomp$0.pendingRootTasks--;
                  0 === request$jscomp$0.pendingRootTasks && completeShell(request$jscomp$0);
                  request$jscomp$0.allPendingTasks--;
                  0 === request$jscomp$0.allPendingTasks && completeAll(request$jscomp$0);
                }
              }
            }
          } else if (
            ((request$jscomp$0 = void 0),
            (request$jscomp$1 = segment),
            0 === request$jscomp$1.status)
          ) {
            request$jscomp$1.status = 6;
            switchContext(task.context);
            var childrenLength = request$jscomp$1.children.length,
              chunkLength = request$jscomp$1.chunks.length;
            try {
              (retryNode(request, task),
                request$jscomp$1.lastPushedText &&
                  request$jscomp$1.textEmbedded &&
                  request$jscomp$1.chunks.push(textSeparator),
                task.abortSet.delete(task),
                (request$jscomp$1.status = 1),
                finishedSegment(request, task.blockedBoundary, request$jscomp$1),
                finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1));
            } catch (thrownValue) {
              resetHooksState();
              request$jscomp$1.children.length = childrenLength;
              request$jscomp$1.chunks.length = chunkLength;
              var x$jscomp$0 =
                thrownValue === SuspenseException
                  ? getSuspendedThenable()
                  : 12 === request.status
                    ? request.fatalError
                    : thrownValue;
              if (12 === request.status && null !== request.trackedPostpones) {
                var trackedPostpones = request.trackedPostpones,
                  thrownInfo = getThrownInfo(task.componentStack);
                task.abortSet.delete(task);
                logRecoverableError(request, x$jscomp$0, thrownInfo);
                trackPostpone(request, trackedPostpones, task, request$jscomp$1);
                finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1);
              } else if (
                "object" === typeof x$jscomp$0 &&
                null !== x$jscomp$0 &&
                "function" === typeof x$jscomp$0.then
              ) {
                request$jscomp$1.status = 0;
                task.thenableState =
                  thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                var ping$jscomp$0 = task.ping;
                x$jscomp$0.then(ping$jscomp$0, ping$jscomp$0);
              } else {
                var errorInfo$jscomp$0 = getThrownInfo(task.componentStack);
                task.abortSet.delete(task);
                request$jscomp$1.status = 4;
                var boundary$jscomp$0 = task.blockedBoundary,
                  row = task.row;
                null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
                request.allPendingTasks--;
                request$jscomp$0 = logRecoverableError(request, x$jscomp$0, errorInfo$jscomp$0);
                if (null === boundary$jscomp$0) fatalError(request, x$jscomp$0);
                else if ((boundary$jscomp$0.pendingTasks--, 4 !== boundary$jscomp$0.status)) {
                  boundary$jscomp$0.status = 4;
                  boundary$jscomp$0.errorDigest = request$jscomp$0;
                  untrackBoundary(request, boundary$jscomp$0);
                  var boundaryRow = boundary$jscomp$0.row;
                  null !== boundaryRow &&
                    0 === --boundaryRow.pendingTasks &&
                    finishSuspenseListRow(request, boundaryRow);
                  boundary$jscomp$0.parentFlushed &&
                    request.clientRenderedBoundaries.push(boundary$jscomp$0);
                  0 === request.pendingRootTasks &&
                    null === request.trackedPostpones &&
                    null !== boundary$jscomp$0.contentPreamble &&
                    preparePreamble(request);
                }
                0 === request.allPendingTasks && completeAll(request);
              }
            }
          }
        }
        pingedTasks.splice(0, i);
        null !== request$jscomp$2.destination &&
          flushCompletedQueues(request$jscomp$2, request$jscomp$2.destination);
      } catch (error) {
        (logRecoverableError(request$jscomp$2, error, {}), fatalError(request$jscomp$2, error));
      } finally {
        ((currentResumableState = prevResumableState),
          (ReactSharedInternals.H = prevDispatcher),
          (ReactSharedInternals.A = prevAsyncDispatcher),
          prevDispatcher === HooksDispatcher && switchContext(prevContext),
          (currentRequest = prevRequest));
      }
    }
  }
  function preparePreambleFromSubtree(request, segment, collectedPreambleSegments) {
    segment.preambleChildren.length && collectedPreambleSegments.push(segment.preambleChildren);
    for (var pendingPreambles = !1, i = 0; i < segment.children.length; i++)
      pendingPreambles =
        preparePreambleFromSegment(request, segment.children[i], collectedPreambleSegments) ||
        pendingPreambles;
    return pendingPreambles;
  }
  function preparePreambleFromSegment(request, segment, collectedPreambleSegments) {
    var boundary = segment.boundary;
    if (null === boundary)
      return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
    var preamble = boundary.contentPreamble,
      fallbackPreamble = boundary.fallbackPreamble;
    if (null === preamble || null === fallbackPreamble) return !1;
    switch (boundary.status) {
      case 1:
        hoistPreambleState(request.renderState, preamble);
        request.byteSize += boundary.byteSize;
        segment = boundary.completedSegments[0];
        if (!segment)
          throw Error(
            "A previously unvisited boundary must have exactly one root segment. This is a bug in React.",
          );
        return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
      case 5:
        if (null !== request.trackedPostpones) return !0;
      case 4:
        if (1 === segment.status)
          return (
            hoistPreambleState(request.renderState, fallbackPreamble),
            preparePreambleFromSubtree(request, segment, collectedPreambleSegments)
          );
      default:
        return !0;
    }
  }
  function preparePreamble(request) {
    if (request.completedRootSegment && null === request.completedPreambleSegments) {
      var collectedPreambleSegments = [],
        originalRequestByteSize = request.byteSize,
        hasPendingPreambles = preparePreambleFromSegment(
          request,
          request.completedRootSegment,
          collectedPreambleSegments,
        ),
        preamble = request.renderState.preamble;
      !1 === hasPendingPreambles || (preamble.headChunks && preamble.bodyChunks)
        ? (request.completedPreambleSegments = collectedPreambleSegments)
        : (request.byteSize = originalRequestByteSize);
    }
  }
  function flushSubtree(request, destination, segment, hoistableState) {
    segment.parentFlushed = !0;
    switch (segment.status) {
      case 0:
        segment.id = request.nextSegmentId++;
      case 5:
        return (
          (hoistableState = segment.id),
          (segment.lastPushedText = !1),
          (segment.textEmbedded = !1),
          (request = request.renderState),
          writeChunk(destination, placeholder1),
          writeChunk(destination, request.placeholderPrefix),
          (request = stringToChunk(hoistableState.toString(16))),
          writeChunk(destination, request),
          writeChunkAndReturn(destination, placeholder2)
        );
      case 1:
        segment.status = 2;
        var r = !0,
          chunks = segment.chunks,
          chunkIdx = 0;
        segment = segment.children;
        for (var childIdx = 0; childIdx < segment.length; childIdx++) {
          for (r = segment[childIdx]; chunkIdx < r.index; chunkIdx++)
            writeChunk(destination, chunks[chunkIdx]);
          r = flushSegment(request, destination, r, hoistableState);
        }
        for (; chunkIdx < chunks.length - 1; chunkIdx++) writeChunk(destination, chunks[chunkIdx]);
        chunkIdx < chunks.length && (r = writeChunkAndReturn(destination, chunks[chunkIdx]));
        return r;
      case 3:
        return !0;
      default:
        throw Error(
          "Aborted, errored or already flushed boundaries should not be flushed again. This is a bug in React.",
        );
    }
  }
  var flushedByteSize = 0;
  function flushSegment(request, destination, segment, hoistableState) {
    var boundary = segment.boundary;
    if (null === boundary) return flushSubtree(request, destination, segment, hoistableState);
    boundary.parentFlushed = !0;
    if (4 === boundary.status) {
      var row = boundary.row;
      null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
      boundary = boundary.errorDigest;
      writeChunkAndReturn(destination, startClientRenderedSuspenseBoundary);
      writeChunk(destination, clientRenderedSuspenseBoundaryError1);
      boundary &&
        (writeChunk(destination, clientRenderedSuspenseBoundaryError1A),
        writeChunk(destination, stringToChunk(escapeTextForBrowser(boundary))),
        writeChunk(destination, clientRenderedSuspenseBoundaryErrorAttrInterstitial));
      writeChunkAndReturn(destination, clientRenderedSuspenseBoundaryError2);
      flushSubtree(request, destination, segment, hoistableState);
    } else if (1 !== boundary.status)
      (0 === boundary.status && (boundary.rootSegmentID = request.nextSegmentId++),
        0 < boundary.completedSegments.length && request.partialBoundaries.push(boundary),
        writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID),
        hoistableState && hoistHoistables(hoistableState, boundary.fallbackState),
        flushSubtree(request, destination, segment, hoistableState));
    else if (
      !flushingPartialBoundaries &&
      isEligibleForOutlining(request, boundary) &&
      (flushedByteSize + boundary.byteSize > request.progressiveChunkSize ||
        hasSuspenseyContent(boundary.contentState))
    )
      ((boundary.rootSegmentID = request.nextSegmentId++),
        request.completedBoundaries.push(boundary),
        writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID),
        flushSubtree(request, destination, segment, hoistableState));
    else {
      flushedByteSize += boundary.byteSize;
      hoistableState && hoistHoistables(hoistableState, boundary.contentState);
      segment = boundary.row;
      null !== segment &&
        isEligibleForOutlining(request, boundary) &&
        0 === --segment.pendingTasks &&
        finishSuspenseListRow(request, segment);
      writeChunkAndReturn(destination, startCompletedSuspenseBoundary);
      segment = boundary.completedSegments;
      if (1 !== segment.length)
        throw Error(
          "A previously unvisited boundary must have exactly one root segment. This is a bug in React.",
        );
      flushSegment(request, destination, segment[0], hoistableState);
    }
    return writeChunkAndReturn(destination, endSuspenseBoundary);
  }
  function flushSegmentContainer(request, destination, segment, hoistableState) {
    writeStartSegment(destination, request.renderState, segment.parentFormatContext, segment.id);
    flushSegment(request, destination, segment, hoistableState);
    return writeEndSegment(destination, segment.parentFormatContext);
  }
  function flushCompletedBoundary(request, destination, boundary) {
    flushedByteSize = boundary.byteSize;
    for (
      var completedSegments = boundary.completedSegments, i = 0;
      i < completedSegments.length;
      i++
    )
      flushPartiallyCompletedSegment(request, destination, boundary, completedSegments[i]);
    completedSegments.length = 0;
    completedSegments = boundary.row;
    null !== completedSegments &&
      isEligibleForOutlining(request, boundary) &&
      0 === --completedSegments.pendingTasks &&
      finishSuspenseListRow(request, completedSegments);
    writeHoistablesForBoundary(destination, boundary.contentState, request.renderState);
    completedSegments = request.resumableState;
    request = request.renderState;
    i = boundary.rootSegmentID;
    boundary = boundary.contentState;
    var requiresStyleInsertion = request.stylesToHoist;
    request.stylesToHoist = !1;
    writeChunk(destination, request.startInlineScript);
    writeChunk(destination, endOfStartTag);
    requiresStyleInsertion
      ? (0 === (completedSegments.instructions & 4) &&
          ((completedSegments.instructions |= 4),
          writeChunk(destination, clientRenderScriptFunctionOnly)),
        0 === (completedSegments.instructions & 2) &&
          ((completedSegments.instructions |= 2),
          writeChunk(destination, completeBoundaryScriptFunctionOnly)),
        0 === (completedSegments.instructions & 8)
          ? ((completedSegments.instructions |= 8),
            writeChunk(destination, completeBoundaryWithStylesScript1FullPartial))
          : writeChunk(destination, completeBoundaryWithStylesScript1Partial))
      : (0 === (completedSegments.instructions & 2) &&
          ((completedSegments.instructions |= 2),
          writeChunk(destination, completeBoundaryScriptFunctionOnly)),
        writeChunk(destination, completeBoundaryScript1Partial));
    completedSegments = stringToChunk(i.toString(16));
    writeChunk(destination, request.boundaryPrefix);
    writeChunk(destination, completedSegments);
    writeChunk(destination, completeBoundaryScript2);
    writeChunk(destination, request.segmentPrefix);
    writeChunk(destination, completedSegments);
    requiresStyleInsertion
      ? (writeChunk(destination, completeBoundaryScript3a),
        writeStyleResourceDependenciesInJS(destination, boundary))
      : writeChunk(destination, completeBoundaryScript3b);
    boundary = writeChunkAndReturn(destination, completeBoundaryScriptEnd);
    return writeBootstrap(destination, request) && boundary;
  }
  function flushPartiallyCompletedSegment(request, destination, boundary, segment) {
    if (2 === segment.status) return !0;
    var hoistableState = boundary.contentState,
      segmentID = segment.id;
    if (-1 === segmentID) {
      if (-1 === (segment.id = boundary.rootSegmentID))
        throw Error("A root segment ID must have been assigned by now. This is a bug in React.");
      return flushSegmentContainer(request, destination, segment, hoistableState);
    }
    if (segmentID === boundary.rootSegmentID)
      return flushSegmentContainer(request, destination, segment, hoistableState);
    flushSegmentContainer(request, destination, segment, hoistableState);
    boundary = request.resumableState;
    request = request.renderState;
    writeChunk(destination, request.startInlineScript);
    writeChunk(destination, endOfStartTag);
    0 === (boundary.instructions & 1)
      ? ((boundary.instructions |= 1), writeChunk(destination, completeSegmentScript1Full))
      : writeChunk(destination, completeSegmentScript1Partial);
    writeChunk(destination, request.segmentPrefix);
    segmentID = stringToChunk(segmentID.toString(16));
    writeChunk(destination, segmentID);
    writeChunk(destination, completeSegmentScript2);
    writeChunk(destination, request.placeholderPrefix);
    writeChunk(destination, segmentID);
    destination = writeChunkAndReturn(destination, completeSegmentScriptEnd);
    return destination;
  }
  var flushingPartialBoundaries = !1;
  function flushCompletedQueues(request, destination) {
    currentView = new Uint8Array(2048);
    writtenBytes = 0;
    try {
      if (!(0 < request.pendingRootTasks)) {
        var i,
          completedRootSegment = request.completedRootSegment;
        if (null !== completedRootSegment) {
          if (5 === completedRootSegment.status) return;
          var completedPreambleSegments = request.completedPreambleSegments;
          if (null === completedPreambleSegments) return;
          flushedByteSize = request.byteSize;
          var resumableState = request.resumableState,
            renderState = request.renderState,
            preamble = renderState.preamble,
            htmlChunks = preamble.htmlChunks,
            headChunks = preamble.headChunks,
            i$jscomp$0;
          if (htmlChunks) {
            for (i$jscomp$0 = 0; i$jscomp$0 < htmlChunks.length; i$jscomp$0++)
              writeChunk(destination, htmlChunks[i$jscomp$0]);
            if (headChunks)
              for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
                writeChunk(destination, headChunks[i$jscomp$0]);
            else
              (writeChunk(destination, startChunkForTag("head")),
                writeChunk(destination, endOfStartTag));
          } else if (headChunks)
            for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
              writeChunk(destination, headChunks[i$jscomp$0]);
          var charsetChunks = renderState.charsetChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < charsetChunks.length; i$jscomp$0++)
            writeChunk(destination, charsetChunks[i$jscomp$0]);
          charsetChunks.length = 0;
          renderState.preconnects.forEach(flushResource, destination);
          renderState.preconnects.clear();
          var viewportChunks = renderState.viewportChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < viewportChunks.length; i$jscomp$0++)
            writeChunk(destination, viewportChunks[i$jscomp$0]);
          viewportChunks.length = 0;
          renderState.fontPreloads.forEach(flushResource, destination);
          renderState.fontPreloads.clear();
          renderState.highImagePreloads.forEach(flushResource, destination);
          renderState.highImagePreloads.clear();
          currentlyFlushingRenderState = renderState;
          renderState.styles.forEach(flushStylesInPreamble, destination);
          currentlyFlushingRenderState = null;
          var importMapChunks = renderState.importMapChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < importMapChunks.length; i$jscomp$0++)
            writeChunk(destination, importMapChunks[i$jscomp$0]);
          importMapChunks.length = 0;
          renderState.bootstrapScripts.forEach(flushResource, destination);
          renderState.scripts.forEach(flushResource, destination);
          renderState.scripts.clear();
          renderState.bulkPreloads.forEach(flushResource, destination);
          renderState.bulkPreloads.clear();
          htmlChunks || headChunks || (resumableState.instructions |= 32);
          var hoistableChunks = renderState.hoistableChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < hoistableChunks.length; i$jscomp$0++)
            writeChunk(destination, hoistableChunks[i$jscomp$0]);
          for (
            resumableState = hoistableChunks.length = 0;
            resumableState < completedPreambleSegments.length;
            resumableState++
          ) {
            var segments = completedPreambleSegments[resumableState];
            for (renderState = 0; renderState < segments.length; renderState++)
              flushSegment(request, destination, segments[renderState], null);
          }
          var preamble$jscomp$0 = request.renderState.preamble,
            headChunks$jscomp$0 = preamble$jscomp$0.headChunks;
          (preamble$jscomp$0.htmlChunks || headChunks$jscomp$0) &&
            writeChunk(destination, endChunkForTag("head"));
          var bodyChunks = preamble$jscomp$0.bodyChunks;
          if (bodyChunks)
            for (
              completedPreambleSegments = 0;
              completedPreambleSegments < bodyChunks.length;
              completedPreambleSegments++
            )
              writeChunk(destination, bodyChunks[completedPreambleSegments]);
          flushSegment(request, destination, completedRootSegment, null);
          request.completedRootSegment = null;
          var renderState$jscomp$0 = request.renderState;
          if (
            0 !== request.allPendingTasks ||
            0 !== request.clientRenderedBoundaries.length ||
            0 !== request.completedBoundaries.length ||
            (null !== request.trackedPostpones &&
              (0 !== request.trackedPostpones.rootNodes.length ||
                null !== request.trackedPostpones.rootSlots))
          ) {
            var resumableState$jscomp$0 = request.resumableState;
            if (0 === (resumableState$jscomp$0.instructions & 64)) {
              resumableState$jscomp$0.instructions |= 64;
              writeChunk(destination, renderState$jscomp$0.startInlineScript);
              if (0 === (resumableState$jscomp$0.instructions & 32)) {
                resumableState$jscomp$0.instructions |= 32;
                var shellId = "_" + resumableState$jscomp$0.idPrefix + "R_";
                writeChunk(destination, completedShellIdAttributeStart);
                writeChunk(destination, stringToChunk(escapeTextForBrowser(shellId)));
                writeChunk(destination, attributeEnd);
              }
              writeChunk(destination, endOfStartTag);
              writeChunk(destination, shellTimeRuntimeScript);
              writeChunkAndReturn(destination, endInlineScript);
            }
          }
          writeBootstrap(destination, renderState$jscomp$0);
        }
        var renderState$jscomp$1 = request.renderState;
        completedRootSegment = 0;
        var viewportChunks$jscomp$0 = renderState$jscomp$1.viewportChunks;
        for (
          completedRootSegment = 0;
          completedRootSegment < viewportChunks$jscomp$0.length;
          completedRootSegment++
        )
          writeChunk(destination, viewportChunks$jscomp$0[completedRootSegment]);
        viewportChunks$jscomp$0.length = 0;
        renderState$jscomp$1.preconnects.forEach(flushResource, destination);
        renderState$jscomp$1.preconnects.clear();
        renderState$jscomp$1.fontPreloads.forEach(flushResource, destination);
        renderState$jscomp$1.fontPreloads.clear();
        renderState$jscomp$1.highImagePreloads.forEach(flushResource, destination);
        renderState$jscomp$1.highImagePreloads.clear();
        renderState$jscomp$1.styles.forEach(preloadLateStyles, destination);
        renderState$jscomp$1.scripts.forEach(flushResource, destination);
        renderState$jscomp$1.scripts.clear();
        renderState$jscomp$1.bulkPreloads.forEach(flushResource, destination);
        renderState$jscomp$1.bulkPreloads.clear();
        var hoistableChunks$jscomp$0 = renderState$jscomp$1.hoistableChunks;
        for (
          completedRootSegment = 0;
          completedRootSegment < hoistableChunks$jscomp$0.length;
          completedRootSegment++
        )
          writeChunk(destination, hoistableChunks$jscomp$0[completedRootSegment]);
        hoistableChunks$jscomp$0.length = 0;
        var clientRenderedBoundaries = request.clientRenderedBoundaries;
        for (i = 0; i < clientRenderedBoundaries.length; i++) {
          var boundary = clientRenderedBoundaries[i];
          renderState$jscomp$1 = destination;
          var resumableState$jscomp$1 = request.resumableState,
            renderState$jscomp$2 = request.renderState,
            id = boundary.rootSegmentID,
            errorDigest = boundary.errorDigest;
          writeChunk(renderState$jscomp$1, renderState$jscomp$2.startInlineScript);
          writeChunk(renderState$jscomp$1, endOfStartTag);
          0 === (resumableState$jscomp$1.instructions & 4)
            ? ((resumableState$jscomp$1.instructions |= 4),
              writeChunk(renderState$jscomp$1, clientRenderScript1Full))
            : writeChunk(renderState$jscomp$1, clientRenderScript1Partial);
          writeChunk(renderState$jscomp$1, renderState$jscomp$2.boundaryPrefix);
          writeChunk(renderState$jscomp$1, stringToChunk(id.toString(16)));
          writeChunk(renderState$jscomp$1, clientRenderScript1A);
          errorDigest &&
            (writeChunk(renderState$jscomp$1, clientRenderErrorScriptArgInterstitial),
            writeChunk(
              renderState$jscomp$1,
              stringToChunk(escapeJSStringsForInstructionScripts(errorDigest || "")),
            ));
          var JSCompiler_inline_result = writeChunkAndReturn(
            renderState$jscomp$1,
            clientRenderScriptEnd,
          );
          if (!JSCompiler_inline_result) {
            request.destination = null;
            i++;
            clientRenderedBoundaries.splice(0, i);
            return;
          }
        }
        clientRenderedBoundaries.splice(0, i);
        var completedBoundaries = request.completedBoundaries;
        for (i = 0; i < completedBoundaries.length; i++)
          if (!flushCompletedBoundary(request, destination, completedBoundaries[i])) {
            request.destination = null;
            i++;
            completedBoundaries.splice(0, i);
            return;
          }
        completedBoundaries.splice(0, i);
        completeWriting(destination);
        currentView = new Uint8Array(2048);
        writtenBytes = 0;
        flushingPartialBoundaries = !0;
        var partialBoundaries = request.partialBoundaries;
        for (i = 0; i < partialBoundaries.length; i++) {
          var boundary$70 = partialBoundaries[i];
          a: {
            clientRenderedBoundaries = request;
            boundary = destination;
            flushedByteSize = boundary$70.byteSize;
            var completedSegments = boundary$70.completedSegments;
            for (
              JSCompiler_inline_result = 0;
              JSCompiler_inline_result < completedSegments.length;
              JSCompiler_inline_result++
            )
              if (
                !flushPartiallyCompletedSegment(
                  clientRenderedBoundaries,
                  boundary,
                  boundary$70,
                  completedSegments[JSCompiler_inline_result],
                )
              ) {
                JSCompiler_inline_result++;
                completedSegments.splice(0, JSCompiler_inline_result);
                var JSCompiler_inline_result$jscomp$0 = !1;
                break a;
              }
            completedSegments.splice(0, JSCompiler_inline_result);
            var row = boundary$70.row;
            null !== row &&
              row.together &&
              1 === boundary$70.pendingTasks &&
              (1 === row.pendingTasks
                ? unblockSuspenseListRow(clientRenderedBoundaries, row, row.hoistables)
                : row.pendingTasks--);
            JSCompiler_inline_result$jscomp$0 = writeHoistablesForBoundary(
              boundary,
              boundary$70.contentState,
              clientRenderedBoundaries.renderState,
            );
          }
          if (!JSCompiler_inline_result$jscomp$0) {
            request.destination = null;
            i++;
            partialBoundaries.splice(0, i);
            return;
          }
        }
        partialBoundaries.splice(0, i);
        flushingPartialBoundaries = !1;
        var largeBoundaries = request.completedBoundaries;
        for (i = 0; i < largeBoundaries.length; i++)
          if (!flushCompletedBoundary(request, destination, largeBoundaries[i])) {
            request.destination = null;
            i++;
            largeBoundaries.splice(0, i);
            return;
          }
        largeBoundaries.splice(0, i);
      }
    } finally {
      ((flushingPartialBoundaries = !1),
        0 === request.allPendingTasks &&
        0 === request.clientRenderedBoundaries.length &&
        0 === request.completedBoundaries.length
          ? ((request.flushScheduled = !1),
            (i = request.resumableState),
            i.hasBody && writeChunk(destination, endChunkForTag("body")),
            i.hasHtml && writeChunk(destination, endChunkForTag("html")),
            completeWriting(destination),
            (request.status = 14),
            destination.close(),
            (request.destination = null))
          : completeWriting(destination));
    }
  }
  function startWork(request) {
    request.flushScheduled = null !== request.destination;
    supportsRequestStorage
      ? scheduleMicrotask(function () {
          return requestStorage.run(request, performWork, request);
        })
      : scheduleMicrotask(function () {
          return performWork(request);
        });
    setTimeout(function () {
      10 === request.status && (request.status = 11);
      null === request.trackedPostpones &&
        (supportsRequestStorage
          ? requestStorage.run(request, enqueueEarlyPreloadsAfterInitialWork, request)
          : enqueueEarlyPreloadsAfterInitialWork(request));
    }, 0);
  }
  function enqueueEarlyPreloadsAfterInitialWork(request) {
    safelyEmitEarlyPreloads(request, 0 === request.pendingRootTasks);
  }
  function enqueueFlush(request) {
    !1 === request.flushScheduled &&
      0 === request.pingedTasks.length &&
      null !== request.destination &&
      ((request.flushScheduled = !0),
      setTimeout(function () {
        var destination = request.destination;
        destination ? flushCompletedQueues(request, destination) : (request.flushScheduled = !1);
      }, 0));
  }
  function startFlowing(request, destination) {
    if (13 === request.status)
      ((request.status = 14), closeWithError(destination, request.fatalError));
    else if (14 !== request.status && null === request.destination) {
      request.destination = destination;
      try {
        flushCompletedQueues(request, destination);
      } catch (error) {
        (logRecoverableError(request, error, {}), fatalError(request, error));
      }
    }
  }
  function abort(request, reason) {
    if (11 === request.status || 10 === request.status) request.status = 12;
    try {
      var abortableTasks = request.abortableTasks;
      if (0 < abortableTasks.size) {
        var error =
          void 0 === reason
            ? Error("The render was aborted by the server without a reason.")
            : "object" === typeof reason && null !== reason && "function" === typeof reason.then
              ? Error("The render was aborted by the server with a promise.")
              : reason;
        request.fatalError = error;
        abortableTasks.forEach(function (task) {
          return abortTask(task, request, error);
        });
        abortableTasks.clear();
      }
      null !== request.destination && flushCompletedQueues(request, request.destination);
    } catch (error$72) {
      (logRecoverableError(request, error$72, {}), fatalError(request, error$72));
    }
  }
  function addToReplayParent(node, parentKeyPath, trackedPostpones) {
    if (null === parentKeyPath) trackedPostpones.rootNodes.push(node);
    else {
      var workingMap = trackedPostpones.workingMap,
        parentNode = workingMap.get(parentKeyPath);
      void 0 === parentNode &&
        ((parentNode = [parentKeyPath[1], parentKeyPath[2], [], null]),
        workingMap.set(parentKeyPath, parentNode),
        addToReplayParent(parentNode, parentKeyPath[0], trackedPostpones));
      parentNode[2].push(node);
    }
  }
  function getPostponedState(request) {
    var trackedPostpones = request.trackedPostpones;
    if (
      null === trackedPostpones ||
      (0 === trackedPostpones.rootNodes.length && null === trackedPostpones.rootSlots)
    )
      return (request.trackedPostpones = null);
    if (
      null === request.completedRootSegment ||
      (5 !== request.completedRootSegment.status && null !== request.completedPreambleSegments)
    ) {
      var nextSegmentId = request.nextSegmentId;
      var replaySlots = trackedPostpones.rootSlots;
      var resumableState = request.resumableState;
      resumableState.bootstrapScriptContent = void 0;
      resumableState.bootstrapScripts = void 0;
      resumableState.bootstrapModules = void 0;
    } else {
      nextSegmentId = 0;
      replaySlots = -1;
      resumableState = request.resumableState;
      var renderState = request.renderState;
      resumableState.nextFormID = 0;
      resumableState.hasBody = !1;
      resumableState.hasHtml = !1;
      resumableState.unknownResources = { font: renderState.resets.font };
      resumableState.dnsResources = renderState.resets.dns;
      resumableState.connectResources = renderState.resets.connect;
      resumableState.imageResources = renderState.resets.image;
      resumableState.styleResources = renderState.resets.style;
      resumableState.scriptResources = {};
      resumableState.moduleUnknownResources = {};
      resumableState.moduleScriptResources = {};
      resumableState.instructions = 0;
    }
    return {
      nextSegmentId,
      rootFormatContext: request.rootFormatContext,
      progressiveChunkSize: request.progressiveChunkSize,
      resumableState: request.resumableState,
      replayNodes: trackedPostpones.rootNodes,
      replaySlots,
    };
  }
  function ensureCorrectIsomorphicReactVersion() {
    var isomorphicReactPackageVersion = React.version;
    if ("19.2.5" !== isomorphicReactPackageVersion)
      throw Error(
        'Incompatible React versions: The "react" and "react-dom" packages must have the exact same version. Instead got:\n  - react:      ' +
          (isomorphicReactPackageVersion +
            "\n  - react-dom:  19.2.5\nLearn more: https://react.dev/warnings/version-mismatch"),
      );
  }
  ensureCorrectIsomorphicReactVersion();
  ensureCorrectIsomorphicReactVersion();
  exports.prerender = function (children, options) {
    return new Promise(function (resolve, reject) {
      var onHeaders = options ? options.onHeaders : void 0,
        onHeadersImpl;
      onHeaders &&
        (onHeadersImpl = function (headersDescriptor) {
          onHeaders(new Headers(headersDescriptor));
        });
      var resources = createResumableState(
          options ? options.identifierPrefix : void 0,
          options ? options.unstable_externalRuntimeSrc : void 0,
          options ? options.bootstrapScriptContent : void 0,
          options ? options.bootstrapScripts : void 0,
          options ? options.bootstrapModules : void 0,
        ),
        request = createPrerenderRequest(
          children,
          resources,
          createRenderState(
            resources,
            void 0,
            options ? options.unstable_externalRuntimeSrc : void 0,
            options ? options.importMap : void 0,
            onHeadersImpl,
            options ? options.maxHeadersLength : void 0,
          ),
          createRootFormatContext(options ? options.namespaceURI : void 0),
          options ? options.progressiveChunkSize : void 0,
          options ? options.onError : void 0,
          function () {
            var stream = new ReadableStream(
              {
                type: "bytes",
                pull: function (controller) {
                  startFlowing(request, controller);
                },
                cancel: function (reason) {
                  request.destination = null;
                  abort(request, reason);
                },
              },
              { highWaterMark: 0 },
            );
            stream = {
              postponed: getPostponedState(request),
              prelude: stream,
            };
            resolve(stream);
          },
          void 0,
          void 0,
          reject,
          options ? options.onPostpone : void 0,
        );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  exports.renderToReadableStream = function (children, options) {
    return new Promise(function (resolve, reject) {
      var onFatalError,
        onAllReady,
        allReady = new Promise(function (res, rej) {
          onAllReady = res;
          onFatalError = rej;
        }),
        onHeaders = options ? options.onHeaders : void 0,
        onHeadersImpl;
      onHeaders &&
        (onHeadersImpl = function (headersDescriptor) {
          onHeaders(new Headers(headersDescriptor));
        });
      var resumableState = createResumableState(
          options ? options.identifierPrefix : void 0,
          options ? options.unstable_externalRuntimeSrc : void 0,
          options ? options.bootstrapScriptContent : void 0,
          options ? options.bootstrapScripts : void 0,
          options ? options.bootstrapModules : void 0,
        ),
        request = createRequest(
          children,
          resumableState,
          createRenderState(
            resumableState,
            options ? options.nonce : void 0,
            options ? options.unstable_externalRuntimeSrc : void 0,
            options ? options.importMap : void 0,
            onHeadersImpl,
            options ? options.maxHeadersLength : void 0,
          ),
          createRootFormatContext(options ? options.namespaceURI : void 0),
          options ? options.progressiveChunkSize : void 0,
          options ? options.onError : void 0,
          onAllReady,
          function () {
            var stream = new ReadableStream(
              {
                type: "bytes",
                pull: function (controller) {
                  startFlowing(request, controller);
                },
                cancel: function (reason) {
                  request.destination = null;
                  abort(request, reason);
                },
              },
              { highWaterMark: 0 },
            );
            stream.allReady = allReady;
            resolve(stream);
          },
          function (error) {
            allReady.catch(function () {});
            reject(error);
          },
          onFatalError,
          options ? options.onPostpone : void 0,
          options ? options.formState : void 0,
        );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  exports.resume = function (children, postponedState, options) {
    return new Promise(function (resolve, reject) {
      var onFatalError,
        onAllReady,
        allReady = new Promise(function (res, rej) {
          onAllReady = res;
          onFatalError = rej;
        }),
        request = resumeRequest(
          children,
          postponedState,
          createRenderState(
            postponedState.resumableState,
            options ? options.nonce : void 0,
            void 0,
            void 0,
            void 0,
            void 0,
          ),
          options ? options.onError : void 0,
          onAllReady,
          function () {
            var stream = new ReadableStream(
              {
                type: "bytes",
                pull: function (controller) {
                  startFlowing(request, controller);
                },
                cancel: function (reason) {
                  request.destination = null;
                  abort(request, reason);
                },
              },
              { highWaterMark: 0 },
            );
            stream.allReady = allReady;
            resolve(stream);
          },
          function (error) {
            allReady.catch(function () {});
            reject(error);
          },
          onFatalError,
          options ? options.onPostpone : void 0,
        );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  exports.resumeAndPrerender = function (children, postponedState, options) {
    return new Promise(function (resolve, reject) {
      var request = resumeAndPrerenderRequest(
        children,
        postponedState,
        createRenderState(postponedState.resumableState, void 0, void 0, void 0, void 0, void 0),
        options ? options.onError : void 0,
        function () {
          var stream = new ReadableStream(
            {
              type: "bytes",
              pull: function (controller) {
                startFlowing(request, controller);
              },
              cancel: function (reason) {
                request.destination = null;
                abort(request, reason);
              },
            },
            { highWaterMark: 0 },
          );
          stream = {
            postponed: getPostponedState(request),
            prelude: stream,
          };
          resolve(stream);
        },
        void 0,
        void 0,
        reject,
        options ? options.onPostpone : void 0,
      );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  exports.version = "19.2.5";
});
//#endregion
//#region node_modules/react-dom/cjs/react-dom-server-legacy.browser.production.js
/**
 * @license React
 * react-dom-server-legacy.browser.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var require_react_dom_server_legacy_browser_production = /* @__PURE__ */ __commonJSMin(
  (exports) => {
    var React = require_react(),
      ReactDOM = require_react_dom();
    function formatProdErrorMessage(code) {
      var url = "https://react.dev/errors/" + code;
      if (1 < arguments.length) {
        url += "?args[]=" + encodeURIComponent(arguments[1]);
        for (var i = 2; i < arguments.length; i++)
          url += "&args[]=" + encodeURIComponent(arguments[i]);
      }
      return (
        "Minified React error #" +
        code +
        "; visit " +
        url +
        " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
      );
    }
    var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"),
      REACT_PORTAL_TYPE = Symbol.for("react.portal"),
      REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"),
      REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"),
      REACT_PROFILER_TYPE = Symbol.for("react.profiler"),
      REACT_CONSUMER_TYPE = Symbol.for("react.consumer"),
      REACT_CONTEXT_TYPE = Symbol.for("react.context"),
      REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"),
      REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"),
      REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"),
      REACT_MEMO_TYPE = Symbol.for("react.memo"),
      REACT_LAZY_TYPE = Symbol.for("react.lazy"),
      REACT_SCOPE_TYPE = Symbol.for("react.scope"),
      REACT_ACTIVITY_TYPE = Symbol.for("react.activity"),
      REACT_LEGACY_HIDDEN_TYPE = Symbol.for("react.legacy_hidden"),
      REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel"),
      REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"),
      MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
    function getIteratorFn(maybeIterable) {
      if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
      maybeIterable =
        (MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL]) ||
        maybeIterable["@@iterator"];
      return "function" === typeof maybeIterable ? maybeIterable : null;
    }
    var isArrayImpl = Array.isArray;
    function murmurhash3_32_gc(key, seed) {
      var remainder = key.length & 3;
      var bytes = key.length - remainder;
      var h1 = seed;
      for (seed = 0; seed < bytes; ) {
        var k1 =
          (key.charCodeAt(seed) & 255) |
          ((key.charCodeAt(++seed) & 255) << 8) |
          ((key.charCodeAt(++seed) & 255) << 16) |
          ((key.charCodeAt(++seed) & 255) << 24);
        ++seed;
        k1 =
          (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
        k1 = (k1 << 15) | (k1 >>> 17);
        k1 = (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
        h1 ^= k1;
        h1 = (h1 << 13) | (h1 >>> 19);
        h1 = (5 * (h1 & 65535) + (((5 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
        h1 = (h1 & 65535) + 27492 + ((((h1 >>> 16) + 58964) & 65535) << 16);
      }
      k1 = 0;
      switch (remainder) {
        case 3:
          k1 ^= (key.charCodeAt(seed + 2) & 255) << 16;
        case 2:
          k1 ^= (key.charCodeAt(seed + 1) & 255) << 8;
        case 1:
          ((k1 ^= key.charCodeAt(seed) & 255),
            (k1 =
              (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) &
              4294967295),
            (k1 = (k1 << 15) | (k1 >>> 17)),
            (h1 ^=
              (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) &
              4294967295));
      }
      h1 ^= key.length;
      h1 ^= h1 >>> 16;
      h1 = (2246822507 * (h1 & 65535) + (((2246822507 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
      h1 ^= h1 >>> 13;
      h1 = (3266489909 * (h1 & 65535) + (((3266489909 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
      return (h1 ^ (h1 >>> 16)) >>> 0;
    }
    var assign = Object.assign,
      hasOwnProperty = Object.prototype.hasOwnProperty,
      VALID_ATTRIBUTE_NAME_REGEX = RegExp(
        "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$",
      ),
      illegalAttributeNameCache = {},
      validatedAttributeNameCache = {};
    function isAttributeNameSafe(attributeName) {
      if (hasOwnProperty.call(validatedAttributeNameCache, attributeName)) return !0;
      if (hasOwnProperty.call(illegalAttributeNameCache, attributeName)) return !1;
      if (VALID_ATTRIBUTE_NAME_REGEX.test(attributeName))
        return (validatedAttributeNameCache[attributeName] = !0);
      illegalAttributeNameCache[attributeName] = !0;
      return !1;
    }
    var unitlessNumbers = new Set(
        "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
          " ",
        ),
      ),
      aliases = new Map([
        ["acceptCharset", "accept-charset"],
        ["htmlFor", "for"],
        ["httpEquiv", "http-equiv"],
        ["crossOrigin", "crossorigin"],
        ["accentHeight", "accent-height"],
        ["alignmentBaseline", "alignment-baseline"],
        ["arabicForm", "arabic-form"],
        ["baselineShift", "baseline-shift"],
        ["capHeight", "cap-height"],
        ["clipPath", "clip-path"],
        ["clipRule", "clip-rule"],
        ["colorInterpolation", "color-interpolation"],
        ["colorInterpolationFilters", "color-interpolation-filters"],
        ["colorProfile", "color-profile"],
        ["colorRendering", "color-rendering"],
        ["dominantBaseline", "dominant-baseline"],
        ["enableBackground", "enable-background"],
        ["fillOpacity", "fill-opacity"],
        ["fillRule", "fill-rule"],
        ["floodColor", "flood-color"],
        ["floodOpacity", "flood-opacity"],
        ["fontFamily", "font-family"],
        ["fontSize", "font-size"],
        ["fontSizeAdjust", "font-size-adjust"],
        ["fontStretch", "font-stretch"],
        ["fontStyle", "font-style"],
        ["fontVariant", "font-variant"],
        ["fontWeight", "font-weight"],
        ["glyphName", "glyph-name"],
        ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
        ["glyphOrientationVertical", "glyph-orientation-vertical"],
        ["horizAdvX", "horiz-adv-x"],
        ["horizOriginX", "horiz-origin-x"],
        ["imageRendering", "image-rendering"],
        ["letterSpacing", "letter-spacing"],
        ["lightingColor", "lighting-color"],
        ["markerEnd", "marker-end"],
        ["markerMid", "marker-mid"],
        ["markerStart", "marker-start"],
        ["overlinePosition", "overline-position"],
        ["overlineThickness", "overline-thickness"],
        ["paintOrder", "paint-order"],
        ["panose-1", "panose-1"],
        ["pointerEvents", "pointer-events"],
        ["renderingIntent", "rendering-intent"],
        ["shapeRendering", "shape-rendering"],
        ["stopColor", "stop-color"],
        ["stopOpacity", "stop-opacity"],
        ["strikethroughPosition", "strikethrough-position"],
        ["strikethroughThickness", "strikethrough-thickness"],
        ["strokeDasharray", "stroke-dasharray"],
        ["strokeDashoffset", "stroke-dashoffset"],
        ["strokeLinecap", "stroke-linecap"],
        ["strokeLinejoin", "stroke-linejoin"],
        ["strokeMiterlimit", "stroke-miterlimit"],
        ["strokeOpacity", "stroke-opacity"],
        ["strokeWidth", "stroke-width"],
        ["textAnchor", "text-anchor"],
        ["textDecoration", "text-decoration"],
        ["textRendering", "text-rendering"],
        ["transformOrigin", "transform-origin"],
        ["underlinePosition", "underline-position"],
        ["underlineThickness", "underline-thickness"],
        ["unicodeBidi", "unicode-bidi"],
        ["unicodeRange", "unicode-range"],
        ["unitsPerEm", "units-per-em"],
        ["vAlphabetic", "v-alphabetic"],
        ["vHanging", "v-hanging"],
        ["vIdeographic", "v-ideographic"],
        ["vMathematical", "v-mathematical"],
        ["vectorEffect", "vector-effect"],
        ["vertAdvY", "vert-adv-y"],
        ["vertOriginX", "vert-origin-x"],
        ["vertOriginY", "vert-origin-y"],
        ["wordSpacing", "word-spacing"],
        ["writingMode", "writing-mode"],
        ["xmlnsXlink", "xmlns:xlink"],
        ["xHeight", "x-height"],
      ]),
      matchHtmlRegExp = /["'&<>]/;
    function escapeTextForBrowser(text) {
      if ("boolean" === typeof text || "number" === typeof text || "bigint" === typeof text)
        return "" + text;
      text = "" + text;
      var match = matchHtmlRegExp.exec(text);
      if (match) {
        var html = "",
          index,
          lastIndex = 0;
        for (index = match.index; index < text.length; index++) {
          switch (text.charCodeAt(index)) {
            case 34:
              match = "&quot;";
              break;
            case 38:
              match = "&amp;";
              break;
            case 39:
              match = "&#x27;";
              break;
            case 60:
              match = "&lt;";
              break;
            case 62:
              match = "&gt;";
              break;
            default:
              continue;
          }
          lastIndex !== index && (html += text.slice(lastIndex, index));
          lastIndex = index + 1;
          html += match;
        }
        text = lastIndex !== index ? html + text.slice(lastIndex, index) : html;
      }
      return text;
    }
    var uppercasePattern = /([A-Z])/g,
      msPattern = /^ms-/,
      isJavaScriptProtocol =
        /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
    function sanitizeURL(url) {
      return isJavaScriptProtocol.test("" + url)
        ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
        : url;
    }
    var ReactSharedInternals =
        React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
      ReactDOMSharedInternals =
        ReactDOM.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
      sharedNotPendingObject = {
        pending: !1,
        data: null,
        method: null,
        action: null,
      },
      previousDispatcher = ReactDOMSharedInternals.d;
    ReactDOMSharedInternals.d = {
      f: previousDispatcher.f,
      r: previousDispatcher.r,
      D: prefetchDNS,
      C: preconnect,
      L: preload,
      m: preloadModule,
      X: preinitScript,
      S: preinitStyle,
      M: preinitModuleScript,
    };
    var PRELOAD_NO_CREDS = [],
      currentlyFlushingRenderState = null,
      scriptRegex = /(<\/|<)(s)(cript)/gi;
    function scriptReplacer(match, prefix, s, suffix) {
      return "" + prefix + ("s" === s ? "\\u0073" : "\\u0053") + suffix;
    }
    function createResumableState(
      identifierPrefix,
      externalRuntimeConfig,
      bootstrapScriptContent,
      bootstrapScripts,
      bootstrapModules,
    ) {
      return {
        idPrefix: void 0 === identifierPrefix ? "" : identifierPrefix,
        nextFormID: 0,
        streamingFormat: 0,
        bootstrapScriptContent,
        bootstrapScripts,
        bootstrapModules,
        instructions: 0,
        hasBody: !1,
        hasHtml: !1,
        unknownResources: {},
        dnsResources: {},
        connectResources: {
          default: {},
          anonymous: {},
          credentials: {},
        },
        imageResources: {},
        styleResources: {},
        scriptResources: {},
        moduleUnknownResources: {},
        moduleScriptResources: {},
      };
    }
    function createFormatContext(insertionMode, selectedValue, tagScope, viewTransition) {
      return {
        insertionMode,
        selectedValue,
        tagScope,
        viewTransition,
      };
    }
    function getChildFormatContext(parentContext, type, props) {
      var subtreeScope = parentContext.tagScope & -25;
      switch (type) {
        case "noscript":
          return createFormatContext(2, null, subtreeScope | 1, null);
        case "select":
          return createFormatContext(
            2,
            null != props.value ? props.value : props.defaultValue,
            subtreeScope,
            null,
          );
        case "svg":
          return createFormatContext(4, null, subtreeScope, null);
        case "picture":
          return createFormatContext(2, null, subtreeScope | 2, null);
        case "math":
          return createFormatContext(5, null, subtreeScope, null);
        case "foreignObject":
          return createFormatContext(2, null, subtreeScope, null);
        case "table":
          return createFormatContext(6, null, subtreeScope, null);
        case "thead":
        case "tbody":
        case "tfoot":
          return createFormatContext(7, null, subtreeScope, null);
        case "colgroup":
          return createFormatContext(9, null, subtreeScope, null);
        case "tr":
          return createFormatContext(8, null, subtreeScope, null);
        case "head":
          if (2 > parentContext.insertionMode)
            return createFormatContext(3, null, subtreeScope, null);
          break;
        case "html":
          if (0 === parentContext.insertionMode)
            return createFormatContext(1, null, subtreeScope, null);
      }
      return 6 <= parentContext.insertionMode || 2 > parentContext.insertionMode
        ? createFormatContext(2, null, subtreeScope, null)
        : parentContext.tagScope !== subtreeScope
          ? createFormatContext(
              parentContext.insertionMode,
              parentContext.selectedValue,
              subtreeScope,
              null,
            )
          : parentContext;
    }
    function getSuspenseViewTransition(parentViewTransition) {
      return null === parentViewTransition
        ? null
        : {
            update: parentViewTransition.update,
            enter: "none",
            exit: "none",
            share: parentViewTransition.update,
            name: parentViewTransition.autoName,
            autoName: parentViewTransition.autoName,
            nameIdx: 0,
          };
    }
    function getSuspenseFallbackFormatContext(resumableState, parentContext) {
      parentContext.tagScope & 32 && (resumableState.instructions |= 128);
      return createFormatContext(
        parentContext.insertionMode,
        parentContext.selectedValue,
        parentContext.tagScope | 12,
        getSuspenseViewTransition(parentContext.viewTransition),
      );
    }
    function getSuspenseContentFormatContext(resumableState, parentContext) {
      resumableState = getSuspenseViewTransition(parentContext.viewTransition);
      var subtreeScope = parentContext.tagScope | 16;
      null !== resumableState && "none" !== resumableState.share && (subtreeScope |= 64);
      return createFormatContext(
        parentContext.insertionMode,
        parentContext.selectedValue,
        subtreeScope,
        resumableState,
      );
    }
    var styleNameCache = /* @__PURE__ */ new Map();
    function pushStyleAttribute(target, style) {
      if ("object" !== typeof style) throw Error(formatProdErrorMessage(62));
      var isFirst = !0,
        styleName;
      for (styleName in style)
        if (hasOwnProperty.call(style, styleName)) {
          var styleValue = style[styleName];
          if (null != styleValue && "boolean" !== typeof styleValue && "" !== styleValue) {
            if (0 === styleName.indexOf("--")) {
              var nameChunk = escapeTextForBrowser(styleName);
              styleValue = escapeTextForBrowser(("" + styleValue).trim());
            } else
              ((nameChunk = styleNameCache.get(styleName)),
                void 0 === nameChunk &&
                  ((nameChunk = escapeTextForBrowser(
                    styleName
                      .replace(uppercasePattern, "-$1")
                      .toLowerCase()
                      .replace(msPattern, "-ms-"),
                  )),
                  styleNameCache.set(styleName, nameChunk)),
                (styleValue =
                  "number" === typeof styleValue
                    ? 0 === styleValue || unitlessNumbers.has(styleName)
                      ? "" + styleValue
                      : styleValue + "px"
                    : escapeTextForBrowser(("" + styleValue).trim())));
            isFirst
              ? ((isFirst = !1), target.push(' style="', nameChunk, ":", styleValue))
              : target.push(";", nameChunk, ":", styleValue);
          }
        }
      isFirst || target.push('"');
    }
    function pushBooleanAttribute(target, name, value) {
      value &&
        "function" !== typeof value &&
        "symbol" !== typeof value &&
        target.push(" ", name, '=""');
    }
    function pushStringAttribute(target, name, value) {
      "function" !== typeof value &&
        "symbol" !== typeof value &&
        "boolean" !== typeof value &&
        target.push(" ", name, '="', escapeTextForBrowser(value), '"');
    }
    var actionJavaScriptURL = escapeTextForBrowser(
      "javascript:throw new Error('React form unexpectedly submitted.')",
    );
    function pushAdditionalFormField(value, key) {
      this.push('<input type="hidden"');
      validateAdditionalFormField(value);
      pushStringAttribute(this, "name", key);
      pushStringAttribute(this, "value", value);
      this.push("/>");
    }
    function validateAdditionalFormField(value) {
      if ("string" !== typeof value) throw Error(formatProdErrorMessage(480));
    }
    function getCustomFormFields(resumableState, formAction) {
      if ("function" === typeof formAction.$$FORM_ACTION) {
        var id = resumableState.nextFormID++;
        resumableState = resumableState.idPrefix + id;
        try {
          var customFields = formAction.$$FORM_ACTION(resumableState);
          if (customFields) customFields.data?.forEach(validateAdditionalFormField);
          return customFields;
        } catch (x) {
          if ("object" === typeof x && null !== x && "function" === typeof x.then) throw x;
        }
      }
      return null;
    }
    function pushFormActionAttribute(
      target,
      resumableState,
      renderState,
      formAction,
      formEncType,
      formMethod,
      formTarget,
      name,
    ) {
      var formData = null;
      if ("function" === typeof formAction) {
        var customFields = getCustomFormFields(resumableState, formAction);
        null !== customFields
          ? ((name = customFields.name),
            (formAction = customFields.action || ""),
            (formEncType = customFields.encType),
            (formMethod = customFields.method),
            (formTarget = customFields.target),
            (formData = customFields.data))
          : (target.push(" ", "formAction", '="', actionJavaScriptURL, '"'),
            (formTarget = formMethod = formEncType = formAction = name = null),
            injectFormReplayingRuntime(resumableState, renderState));
      }
      null != name && pushAttribute(target, "name", name);
      null != formAction && pushAttribute(target, "formAction", formAction);
      null != formEncType && pushAttribute(target, "formEncType", formEncType);
      null != formMethod && pushAttribute(target, "formMethod", formMethod);
      null != formTarget && pushAttribute(target, "formTarget", formTarget);
      return formData;
    }
    function pushAttribute(target, name, value) {
      switch (name) {
        case "className":
          pushStringAttribute(target, "class", value);
          break;
        case "tabIndex":
          pushStringAttribute(target, "tabindex", value);
          break;
        case "dir":
        case "role":
        case "viewBox":
        case "width":
        case "height":
          pushStringAttribute(target, name, value);
          break;
        case "style":
          pushStyleAttribute(target, value);
          break;
        case "src":
        case "href":
          if ("" === value) break;
        case "action":
        case "formAction":
          if (
            null == value ||
            "function" === typeof value ||
            "symbol" === typeof value ||
            "boolean" === typeof value
          )
            break;
          value = sanitizeURL("" + value);
          target.push(" ", name, '="', escapeTextForBrowser(value), '"');
          break;
        case "defaultValue":
        case "defaultChecked":
        case "innerHTML":
        case "suppressContentEditableWarning":
        case "suppressHydrationWarning":
        case "ref":
          break;
        case "autoFocus":
        case "multiple":
        case "muted":
          pushBooleanAttribute(target, name.toLowerCase(), value);
          break;
        case "xlinkHref":
          if (
            "function" === typeof value ||
            "symbol" === typeof value ||
            "boolean" === typeof value
          )
            break;
          value = sanitizeURL("" + value);
          target.push(" ", "xlink:href", '="', escapeTextForBrowser(value), '"');
          break;
        case "contentEditable":
        case "spellCheck":
        case "draggable":
        case "value":
        case "autoReverse":
        case "externalResourcesRequired":
        case "focusable":
        case "preserveAlpha":
          "function" !== typeof value &&
            "symbol" !== typeof value &&
            target.push(" ", name, '="', escapeTextForBrowser(value), '"');
          break;
        case "inert":
        case "allowFullScreen":
        case "async":
        case "autoPlay":
        case "controls":
        case "default":
        case "defer":
        case "disabled":
        case "disablePictureInPicture":
        case "disableRemotePlayback":
        case "formNoValidate":
        case "hidden":
        case "loop":
        case "noModule":
        case "noValidate":
        case "open":
        case "playsInline":
        case "readOnly":
        case "required":
        case "reversed":
        case "scoped":
        case "seamless":
        case "itemScope":
          value &&
            "function" !== typeof value &&
            "symbol" !== typeof value &&
            target.push(" ", name, '=""');
          break;
        case "capture":
        case "download":
          !0 === value
            ? target.push(" ", name, '=""')
            : !1 !== value &&
              "function" !== typeof value &&
              "symbol" !== typeof value &&
              target.push(" ", name, '="', escapeTextForBrowser(value), '"');
          break;
        case "cols":
        case "rows":
        case "size":
        case "span":
          "function" !== typeof value &&
            "symbol" !== typeof value &&
            !isNaN(value) &&
            1 <= value &&
            target.push(" ", name, '="', escapeTextForBrowser(value), '"');
          break;
        case "rowSpan":
        case "start":
          "function" === typeof value ||
            "symbol" === typeof value ||
            isNaN(value) ||
            target.push(" ", name, '="', escapeTextForBrowser(value), '"');
          break;
        case "xlinkActuate":
          pushStringAttribute(target, "xlink:actuate", value);
          break;
        case "xlinkArcrole":
          pushStringAttribute(target, "xlink:arcrole", value);
          break;
        case "xlinkRole":
          pushStringAttribute(target, "xlink:role", value);
          break;
        case "xlinkShow":
          pushStringAttribute(target, "xlink:show", value);
          break;
        case "xlinkTitle":
          pushStringAttribute(target, "xlink:title", value);
          break;
        case "xlinkType":
          pushStringAttribute(target, "xlink:type", value);
          break;
        case "xmlBase":
          pushStringAttribute(target, "xml:base", value);
          break;
        case "xmlLang":
          pushStringAttribute(target, "xml:lang", value);
          break;
        case "xmlSpace":
          pushStringAttribute(target, "xml:space", value);
          break;
        default:
          if (
            !(2 < name.length) ||
            ("o" !== name[0] && "O" !== name[0]) ||
            ("n" !== name[1] && "N" !== name[1])
          ) {
            if (((name = aliases.get(name) || name), isAttributeNameSafe(name))) {
              switch (typeof value) {
                case "function":
                case "symbol":
                  return;
                case "boolean":
                  var prefix$8 = name.toLowerCase().slice(0, 5);
                  if ("data-" !== prefix$8 && "aria-" !== prefix$8) return;
              }
              target.push(" ", name, '="', escapeTextForBrowser(value), '"');
            }
          }
      }
    }
    function pushInnerHTML(target, innerHTML, children) {
      if (null != innerHTML) {
        if (null != children) throw Error(formatProdErrorMessage(60));
        if ("object" !== typeof innerHTML || !("__html" in innerHTML))
          throw Error(formatProdErrorMessage(61));
        innerHTML = innerHTML.__html;
        null !== innerHTML && void 0 !== innerHTML && target.push("" + innerHTML);
      }
    }
    function flattenOptionChildren(children) {
      var content = "";
      React.Children.forEach(children, function (child) {
        null != child && (content += child);
      });
      return content;
    }
    function injectFormReplayingRuntime(resumableState, renderState) {
      if (0 === (resumableState.instructions & 16)) {
        resumableState.instructions |= 16;
        var preamble = renderState.preamble,
          bootstrapChunks = renderState.bootstrapChunks;
        (preamble.htmlChunks || preamble.headChunks) && 0 === bootstrapChunks.length
          ? (bootstrapChunks.push(renderState.startInlineScript),
            pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
            bootstrapChunks.push(
              ">",
              'addEventListener("submit",function(a){if(!a.defaultPrevented){var c=a.target,d=a.submitter,e=c.action,b=d;if(d){var f=d.getAttribute("formAction");null!=f&&(e=f,b=null)}"javascript:throw new Error(\'React form unexpectedly submitted.\')"===e&&(a.preventDefault(),b?(a=document.createElement("input"),a.name=b.name,a.value=b.value,b.parentNode.insertBefore(a,b),b=new FormData(c),a.parentNode.removeChild(a)):b=new FormData(c),a=c.ownerDocument||c,(a.$$reactFormReplay=a.$$reactFormReplay||[]).push(c,d,b))}});',
              "<\/script>",
            ))
          : bootstrapChunks.unshift(
              renderState.startInlineScript,
              ">",
              'addEventListener("submit",function(a){if(!a.defaultPrevented){var c=a.target,d=a.submitter,e=c.action,b=d;if(d){var f=d.getAttribute("formAction");null!=f&&(e=f,b=null)}"javascript:throw new Error(\'React form unexpectedly submitted.\')"===e&&(a.preventDefault(),b?(a=document.createElement("input"),a.name=b.name,a.value=b.value,b.parentNode.insertBefore(a,b),b=new FormData(c),a.parentNode.removeChild(a)):b=new FormData(c),a=c.ownerDocument||c,(a.$$reactFormReplay=a.$$reactFormReplay||[]).push(c,d,b))}});',
              "<\/script>",
            );
      }
    }
    function pushLinkImpl(target, props) {
      target.push(startChunkForTag("link"));
      for (var propKey in props)
        if (hasOwnProperty.call(props, propKey)) {
          var propValue = props[propKey];
          if (null != propValue)
            switch (propKey) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(formatProdErrorMessage(399, "link"));
              default:
                pushAttribute(target, propKey, propValue);
            }
        }
      target.push("/>");
      return null;
    }
    var styleRegex = /(<\/|<)(s)(tyle)/gi;
    function styleReplacer(match, prefix, s, suffix) {
      return "" + prefix + ("s" === s ? "\\73 " : "\\53 ") + suffix;
    }
    function pushSelfClosing(target, props, tag) {
      target.push(startChunkForTag(tag));
      for (var propKey in props)
        if (hasOwnProperty.call(props, propKey)) {
          var propValue = props[propKey];
          if (null != propValue)
            switch (propKey) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(formatProdErrorMessage(399, tag));
              default:
                pushAttribute(target, propKey, propValue);
            }
        }
      target.push("/>");
      return null;
    }
    function pushTitleImpl(target, props) {
      target.push(startChunkForTag("title"));
      var children = null,
        innerHTML = null,
        propKey;
      for (propKey in props)
        if (hasOwnProperty.call(props, propKey)) {
          var propValue = props[propKey];
          if (null != propValue)
            switch (propKey) {
              case "children":
                children = propValue;
                break;
              case "dangerouslySetInnerHTML":
                innerHTML = propValue;
                break;
              default:
                pushAttribute(target, propKey, propValue);
            }
        }
      target.push(">");
      props = Array.isArray(children) ? (2 > children.length ? children[0] : null) : children;
      "function" !== typeof props &&
        "symbol" !== typeof props &&
        null !== props &&
        void 0 !== props &&
        target.push(escapeTextForBrowser("" + props));
      pushInnerHTML(target, innerHTML, children);
      target.push(endChunkForTag("title"));
      return null;
    }
    function pushScriptImpl(target, props) {
      target.push(startChunkForTag("script"));
      var children = null,
        innerHTML = null,
        propKey;
      for (propKey in props)
        if (hasOwnProperty.call(props, propKey)) {
          var propValue = props[propKey];
          if (null != propValue)
            switch (propKey) {
              case "children":
                children = propValue;
                break;
              case "dangerouslySetInnerHTML":
                innerHTML = propValue;
                break;
              default:
                pushAttribute(target, propKey, propValue);
            }
        }
      target.push(">");
      pushInnerHTML(target, innerHTML, children);
      "string" === typeof children &&
        target.push(("" + children).replace(scriptRegex, scriptReplacer));
      target.push(endChunkForTag("script"));
      return null;
    }
    function pushStartSingletonElement(target, props, tag) {
      target.push(startChunkForTag(tag));
      var innerHTML = (tag = null),
        propKey;
      for (propKey in props)
        if (hasOwnProperty.call(props, propKey)) {
          var propValue = props[propKey];
          if (null != propValue)
            switch (propKey) {
              case "children":
                tag = propValue;
                break;
              case "dangerouslySetInnerHTML":
                innerHTML = propValue;
                break;
              default:
                pushAttribute(target, propKey, propValue);
            }
        }
      target.push(">");
      pushInnerHTML(target, innerHTML, tag);
      return tag;
    }
    function pushStartGenericElement(target, props, tag) {
      target.push(startChunkForTag(tag));
      var innerHTML = (tag = null),
        propKey;
      for (propKey in props)
        if (hasOwnProperty.call(props, propKey)) {
          var propValue = props[propKey];
          if (null != propValue)
            switch (propKey) {
              case "children":
                tag = propValue;
                break;
              case "dangerouslySetInnerHTML":
                innerHTML = propValue;
                break;
              default:
                pushAttribute(target, propKey, propValue);
            }
        }
      target.push(">");
      pushInnerHTML(target, innerHTML, tag);
      return "string" === typeof tag ? (target.push(escapeTextForBrowser(tag)), null) : tag;
    }
    var VALID_TAG_REGEX = /^[a-zA-Z][a-zA-Z:_\.\-\d]*$/,
      validatedTagCache = /* @__PURE__ */ new Map();
    function startChunkForTag(tag) {
      var tagStartChunk = validatedTagCache.get(tag);
      if (void 0 === tagStartChunk) {
        if (!VALID_TAG_REGEX.test(tag)) throw Error(formatProdErrorMessage(65, tag));
        tagStartChunk = "<" + tag;
        validatedTagCache.set(tag, tagStartChunk);
      }
      return tagStartChunk;
    }
    function pushStartInstance(
      target$jscomp$0,
      type,
      props,
      resumableState,
      renderState,
      preambleState,
      hoistableState,
      formatContext,
      textEmbedded,
    ) {
      switch (type) {
        case "div":
        case "span":
        case "svg":
        case "path":
          break;
        case "a":
          target$jscomp$0.push(startChunkForTag("a"));
          var children = null,
            innerHTML = null,
            propKey;
          for (propKey in props)
            if (hasOwnProperty.call(props, propKey)) {
              var propValue = props[propKey];
              if (null != propValue)
                switch (propKey) {
                  case "children":
                    children = propValue;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML = propValue;
                    break;
                  case "href":
                    "" === propValue
                      ? pushStringAttribute(target$jscomp$0, "href", "")
                      : pushAttribute(target$jscomp$0, propKey, propValue);
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey, propValue);
                }
            }
          target$jscomp$0.push(">");
          pushInnerHTML(target$jscomp$0, innerHTML, children);
          if ("string" === typeof children) {
            target$jscomp$0.push(escapeTextForBrowser(children));
            var JSCompiler_inline_result = null;
          } else JSCompiler_inline_result = children;
          return JSCompiler_inline_result;
        case "g":
        case "p":
        case "li":
          break;
        case "select":
          target$jscomp$0.push(startChunkForTag("select"));
          var children$jscomp$0 = null,
            innerHTML$jscomp$0 = null,
            propKey$jscomp$0;
          for (propKey$jscomp$0 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$0)) {
              var propValue$jscomp$0 = props[propKey$jscomp$0];
              if (null != propValue$jscomp$0)
                switch (propKey$jscomp$0) {
                  case "children":
                    children$jscomp$0 = propValue$jscomp$0;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$0 = propValue$jscomp$0;
                    break;
                  case "defaultValue":
                  case "value":
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$0, propValue$jscomp$0);
                }
            }
          target$jscomp$0.push(">");
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$0, children$jscomp$0);
          return children$jscomp$0;
        case "option":
          var selectedValue = formatContext.selectedValue;
          target$jscomp$0.push(startChunkForTag("option"));
          var children$jscomp$1 = null,
            value = null,
            selected = null,
            innerHTML$jscomp$1 = null,
            propKey$jscomp$1;
          for (propKey$jscomp$1 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$1)) {
              var propValue$jscomp$1 = props[propKey$jscomp$1];
              if (null != propValue$jscomp$1)
                switch (propKey$jscomp$1) {
                  case "children":
                    children$jscomp$1 = propValue$jscomp$1;
                    break;
                  case "selected":
                    selected = propValue$jscomp$1;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$1 = propValue$jscomp$1;
                    break;
                  case "value":
                    value = propValue$jscomp$1;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$1, propValue$jscomp$1);
                }
            }
          if (null != selectedValue) {
            var stringValue =
              null !== value ? "" + value : flattenOptionChildren(children$jscomp$1);
            if (isArrayImpl(selectedValue)) {
              for (var i = 0; i < selectedValue.length; i++)
                if ("" + selectedValue[i] === stringValue) {
                  target$jscomp$0.push(' selected=""');
                  break;
                }
            } else "" + selectedValue === stringValue && target$jscomp$0.push(' selected=""');
          } else selected && target$jscomp$0.push(' selected=""');
          target$jscomp$0.push(">");
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$1, children$jscomp$1);
          return children$jscomp$1;
        case "textarea":
          target$jscomp$0.push(startChunkForTag("textarea"));
          var value$jscomp$0 = null,
            defaultValue = null,
            children$jscomp$2 = null,
            propKey$jscomp$2;
          for (propKey$jscomp$2 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$2)) {
              var propValue$jscomp$2 = props[propKey$jscomp$2];
              if (null != propValue$jscomp$2)
                switch (propKey$jscomp$2) {
                  case "children":
                    children$jscomp$2 = propValue$jscomp$2;
                    break;
                  case "value":
                    value$jscomp$0 = propValue$jscomp$2;
                    break;
                  case "defaultValue":
                    defaultValue = propValue$jscomp$2;
                    break;
                  case "dangerouslySetInnerHTML":
                    throw Error(formatProdErrorMessage(91));
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$2, propValue$jscomp$2);
                }
            }
          null === value$jscomp$0 && null !== defaultValue && (value$jscomp$0 = defaultValue);
          target$jscomp$0.push(">");
          if (null != children$jscomp$2) {
            if (null != value$jscomp$0) throw Error(formatProdErrorMessage(92));
            if (isArrayImpl(children$jscomp$2)) {
              if (1 < children$jscomp$2.length) throw Error(formatProdErrorMessage(93));
              value$jscomp$0 = "" + children$jscomp$2[0];
            }
            value$jscomp$0 = "" + children$jscomp$2;
          }
          "string" === typeof value$jscomp$0 &&
            "\n" === value$jscomp$0[0] &&
            target$jscomp$0.push("\n");
          null !== value$jscomp$0 &&
            target$jscomp$0.push(escapeTextForBrowser("" + value$jscomp$0));
          return null;
        case "input":
          target$jscomp$0.push(startChunkForTag("input"));
          var name = null,
            formAction = null,
            formEncType = null,
            formMethod = null,
            formTarget = null,
            value$jscomp$1 = null,
            defaultValue$jscomp$0 = null,
            checked = null,
            defaultChecked = null,
            propKey$jscomp$3;
          for (propKey$jscomp$3 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$3)) {
              var propValue$jscomp$3 = props[propKey$jscomp$3];
              if (null != propValue$jscomp$3)
                switch (propKey$jscomp$3) {
                  case "children":
                  case "dangerouslySetInnerHTML":
                    throw Error(formatProdErrorMessage(399, "input"));
                  case "name":
                    name = propValue$jscomp$3;
                    break;
                  case "formAction":
                    formAction = propValue$jscomp$3;
                    break;
                  case "formEncType":
                    formEncType = propValue$jscomp$3;
                    break;
                  case "formMethod":
                    formMethod = propValue$jscomp$3;
                    break;
                  case "formTarget":
                    formTarget = propValue$jscomp$3;
                    break;
                  case "defaultChecked":
                    defaultChecked = propValue$jscomp$3;
                    break;
                  case "defaultValue":
                    defaultValue$jscomp$0 = propValue$jscomp$3;
                    break;
                  case "checked":
                    checked = propValue$jscomp$3;
                    break;
                  case "value":
                    value$jscomp$1 = propValue$jscomp$3;
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$3, propValue$jscomp$3);
                }
            }
          var formData = pushFormActionAttribute(
            target$jscomp$0,
            resumableState,
            renderState,
            formAction,
            formEncType,
            formMethod,
            formTarget,
            name,
          );
          null !== checked
            ? pushBooleanAttribute(target$jscomp$0, "checked", checked)
            : null !== defaultChecked &&
              pushBooleanAttribute(target$jscomp$0, "checked", defaultChecked);
          null !== value$jscomp$1
            ? pushAttribute(target$jscomp$0, "value", value$jscomp$1)
            : null !== defaultValue$jscomp$0 &&
              pushAttribute(target$jscomp$0, "value", defaultValue$jscomp$0);
          target$jscomp$0.push("/>");
          formData?.forEach(pushAdditionalFormField, target$jscomp$0);
          return null;
        case "button":
          target$jscomp$0.push(startChunkForTag("button"));
          var children$jscomp$3 = null,
            innerHTML$jscomp$2 = null,
            name$jscomp$0 = null,
            formAction$jscomp$0 = null,
            formEncType$jscomp$0 = null,
            formMethod$jscomp$0 = null,
            formTarget$jscomp$0 = null,
            propKey$jscomp$4;
          for (propKey$jscomp$4 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$4)) {
              var propValue$jscomp$4 = props[propKey$jscomp$4];
              if (null != propValue$jscomp$4)
                switch (propKey$jscomp$4) {
                  case "children":
                    children$jscomp$3 = propValue$jscomp$4;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$2 = propValue$jscomp$4;
                    break;
                  case "name":
                    name$jscomp$0 = propValue$jscomp$4;
                    break;
                  case "formAction":
                    formAction$jscomp$0 = propValue$jscomp$4;
                    break;
                  case "formEncType":
                    formEncType$jscomp$0 = propValue$jscomp$4;
                    break;
                  case "formMethod":
                    formMethod$jscomp$0 = propValue$jscomp$4;
                    break;
                  case "formTarget":
                    formTarget$jscomp$0 = propValue$jscomp$4;
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$4, propValue$jscomp$4);
                }
            }
          var formData$jscomp$0 = pushFormActionAttribute(
            target$jscomp$0,
            resumableState,
            renderState,
            formAction$jscomp$0,
            formEncType$jscomp$0,
            formMethod$jscomp$0,
            formTarget$jscomp$0,
            name$jscomp$0,
          );
          target$jscomp$0.push(">");
          formData$jscomp$0?.forEach(pushAdditionalFormField, target$jscomp$0);
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$2, children$jscomp$3);
          if ("string" === typeof children$jscomp$3) {
            target$jscomp$0.push(escapeTextForBrowser(children$jscomp$3));
            var JSCompiler_inline_result$jscomp$0 = null;
          } else JSCompiler_inline_result$jscomp$0 = children$jscomp$3;
          return JSCompiler_inline_result$jscomp$0;
        case "form":
          target$jscomp$0.push(startChunkForTag("form"));
          var children$jscomp$4 = null,
            innerHTML$jscomp$3 = null,
            formAction$jscomp$1 = null,
            formEncType$jscomp$1 = null,
            formMethod$jscomp$1 = null,
            formTarget$jscomp$1 = null,
            propKey$jscomp$5;
          for (propKey$jscomp$5 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$5)) {
              var propValue$jscomp$5 = props[propKey$jscomp$5];
              if (null != propValue$jscomp$5)
                switch (propKey$jscomp$5) {
                  case "children":
                    children$jscomp$4 = propValue$jscomp$5;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$3 = propValue$jscomp$5;
                    break;
                  case "action":
                    formAction$jscomp$1 = propValue$jscomp$5;
                    break;
                  case "encType":
                    formEncType$jscomp$1 = propValue$jscomp$5;
                    break;
                  case "method":
                    formMethod$jscomp$1 = propValue$jscomp$5;
                    break;
                  case "target":
                    formTarget$jscomp$1 = propValue$jscomp$5;
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$5, propValue$jscomp$5);
                }
            }
          var formData$jscomp$1 = null,
            formActionName = null;
          if ("function" === typeof formAction$jscomp$1) {
            var customFields = getCustomFormFields(resumableState, formAction$jscomp$1);
            null !== customFields
              ? ((formAction$jscomp$1 = customFields.action || ""),
                (formEncType$jscomp$1 = customFields.encType),
                (formMethod$jscomp$1 = customFields.method),
                (formTarget$jscomp$1 = customFields.target),
                (formData$jscomp$1 = customFields.data),
                (formActionName = customFields.name))
              : (target$jscomp$0.push(" ", "action", '="', actionJavaScriptURL, '"'),
                (formTarget$jscomp$1 =
                  formMethod$jscomp$1 =
                  formEncType$jscomp$1 =
                  formAction$jscomp$1 =
                    null),
                injectFormReplayingRuntime(resumableState, renderState));
          }
          null != formAction$jscomp$1 &&
            pushAttribute(target$jscomp$0, "action", formAction$jscomp$1);
          null != formEncType$jscomp$1 &&
            pushAttribute(target$jscomp$0, "encType", formEncType$jscomp$1);
          null != formMethod$jscomp$1 &&
            pushAttribute(target$jscomp$0, "method", formMethod$jscomp$1);
          null != formTarget$jscomp$1 &&
            pushAttribute(target$jscomp$0, "target", formTarget$jscomp$1);
          target$jscomp$0.push(">");
          null !== formActionName &&
            (target$jscomp$0.push('<input type="hidden"'),
            pushStringAttribute(target$jscomp$0, "name", formActionName),
            target$jscomp$0.push("/>"),
            formData$jscomp$1?.forEach(pushAdditionalFormField, target$jscomp$0));
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$3, children$jscomp$4);
          if ("string" === typeof children$jscomp$4) {
            target$jscomp$0.push(escapeTextForBrowser(children$jscomp$4));
            var JSCompiler_inline_result$jscomp$1 = null;
          } else JSCompiler_inline_result$jscomp$1 = children$jscomp$4;
          return JSCompiler_inline_result$jscomp$1;
        case "menuitem":
          target$jscomp$0.push(startChunkForTag("menuitem"));
          for (var propKey$jscomp$6 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$6)) {
              var propValue$jscomp$6 = props[propKey$jscomp$6];
              if (null != propValue$jscomp$6)
                switch (propKey$jscomp$6) {
                  case "children":
                  case "dangerouslySetInnerHTML":
                    throw Error(formatProdErrorMessage(400));
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$6, propValue$jscomp$6);
                }
            }
          target$jscomp$0.push(">");
          return null;
        case "object":
          target$jscomp$0.push(startChunkForTag("object"));
          var children$jscomp$5 = null,
            innerHTML$jscomp$4 = null,
            propKey$jscomp$7;
          for (propKey$jscomp$7 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$7)) {
              var propValue$jscomp$7 = props[propKey$jscomp$7];
              if (null != propValue$jscomp$7)
                switch (propKey$jscomp$7) {
                  case "children":
                    children$jscomp$5 = propValue$jscomp$7;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$4 = propValue$jscomp$7;
                    break;
                  case "data":
                    var sanitizedValue = sanitizeURL("" + propValue$jscomp$7);
                    if ("" === sanitizedValue) break;
                    target$jscomp$0.push(
                      " ",
                      "data",
                      '="',
                      escapeTextForBrowser(sanitizedValue),
                      '"',
                    );
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$7, propValue$jscomp$7);
                }
            }
          target$jscomp$0.push(">");
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$4, children$jscomp$5);
          if ("string" === typeof children$jscomp$5) {
            target$jscomp$0.push(escapeTextForBrowser(children$jscomp$5));
            var JSCompiler_inline_result$jscomp$2 = null;
          } else JSCompiler_inline_result$jscomp$2 = children$jscomp$5;
          return JSCompiler_inline_result$jscomp$2;
        case "title":
          var noscriptTagInScope = formatContext.tagScope & 1,
            isFallback = formatContext.tagScope & 4;
          if (4 === formatContext.insertionMode || noscriptTagInScope || null != props.itemProp)
            var JSCompiler_inline_result$jscomp$3 = pushTitleImpl(target$jscomp$0, props);
          else
            isFallback
              ? (JSCompiler_inline_result$jscomp$3 = null)
              : (pushTitleImpl(renderState.hoistableChunks, props),
                (JSCompiler_inline_result$jscomp$3 = void 0));
          return JSCompiler_inline_result$jscomp$3;
        case "link":
          var noscriptTagInScope$jscomp$0 = formatContext.tagScope & 1,
            isFallback$jscomp$0 = formatContext.tagScope & 4,
            rel = props.rel,
            href = props.href,
            precedence = props.precedence;
          if (
            4 === formatContext.insertionMode ||
            noscriptTagInScope$jscomp$0 ||
            null != props.itemProp ||
            "string" !== typeof rel ||
            "string" !== typeof href ||
            "" === href
          ) {
            pushLinkImpl(target$jscomp$0, props);
            var JSCompiler_inline_result$jscomp$4 = null;
          } else if ("stylesheet" === props.rel)
            if (
              "string" !== typeof precedence ||
              null != props.disabled ||
              props.onLoad ||
              props.onError
            )
              JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props);
            else {
              var styleQueue = renderState.styles.get(precedence),
                resourceState = resumableState.styleResources.hasOwnProperty(href)
                  ? resumableState.styleResources[href]
                  : void 0;
              if (null !== resourceState) {
                resumableState.styleResources[href] = null;
                styleQueue ||
                  ((styleQueue = {
                    precedence: escapeTextForBrowser(precedence),
                    rules: [],
                    hrefs: [],
                    sheets: /* @__PURE__ */ new Map(),
                  }),
                  renderState.styles.set(precedence, styleQueue));
                var resource = {
                  state: 0,
                  props: assign({}, props, {
                    "data-precedence": props.precedence,
                    precedence: null,
                  }),
                };
                if (resourceState) {
                  2 === resourceState.length &&
                    adoptPreloadCredentials(resource.props, resourceState);
                  var preloadResource = renderState.preloads.stylesheets.get(href);
                  preloadResource && 0 < preloadResource.length
                    ? (preloadResource.length = 0)
                    : (resource.state = 1);
                }
                styleQueue.sheets.set(href, resource);
                hoistableState && hoistableState.stylesheets.add(resource);
              } else if (styleQueue) {
                var resource$9 = styleQueue.sheets.get(href);
                resource$9 && hoistableState && hoistableState.stylesheets.add(resource$9);
              }
              textEmbedded && target$jscomp$0.push("<!-- -->");
              JSCompiler_inline_result$jscomp$4 = null;
            }
          else
            props.onLoad || props.onError
              ? (JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props))
              : (textEmbedded && target$jscomp$0.push("<!-- -->"),
                (JSCompiler_inline_result$jscomp$4 = isFallback$jscomp$0
                  ? null
                  : pushLinkImpl(renderState.hoistableChunks, props)));
          return JSCompiler_inline_result$jscomp$4;
        case "script":
          var noscriptTagInScope$jscomp$1 = formatContext.tagScope & 1,
            asyncProp = props.async;
          if (
            "string" !== typeof props.src ||
            !props.src ||
            !asyncProp ||
            "function" === typeof asyncProp ||
            "symbol" === typeof asyncProp ||
            props.onLoad ||
            props.onError ||
            4 === formatContext.insertionMode ||
            noscriptTagInScope$jscomp$1 ||
            null != props.itemProp
          )
            var JSCompiler_inline_result$jscomp$5 = pushScriptImpl(target$jscomp$0, props);
          else {
            var key = props.src;
            if ("module" === props.type) {
              var resources = resumableState.moduleScriptResources;
              var preloads = renderState.preloads.moduleScripts;
            } else
              ((resources = resumableState.scriptResources),
                (preloads = renderState.preloads.scripts));
            var resourceState$jscomp$0 = resources.hasOwnProperty(key) ? resources[key] : void 0;
            if (null !== resourceState$jscomp$0) {
              resources[key] = null;
              var scriptProps = props;
              if (resourceState$jscomp$0) {
                2 === resourceState$jscomp$0.length &&
                  ((scriptProps = assign({}, props)),
                  adoptPreloadCredentials(scriptProps, resourceState$jscomp$0));
                var preloadResource$jscomp$0 = preloads.get(key);
                preloadResource$jscomp$0 && (preloadResource$jscomp$0.length = 0);
              }
              var resource$jscomp$0 = [];
              renderState.scripts.add(resource$jscomp$0);
              pushScriptImpl(resource$jscomp$0, scriptProps);
            }
            textEmbedded && target$jscomp$0.push("<!-- -->");
            JSCompiler_inline_result$jscomp$5 = null;
          }
          return JSCompiler_inline_result$jscomp$5;
        case "style":
          var noscriptTagInScope$jscomp$2 = formatContext.tagScope & 1,
            precedence$jscomp$0 = props.precedence,
            href$jscomp$0 = props.href,
            nonce = props.nonce;
          if (
            4 === formatContext.insertionMode ||
            noscriptTagInScope$jscomp$2 ||
            null != props.itemProp ||
            "string" !== typeof precedence$jscomp$0 ||
            "string" !== typeof href$jscomp$0 ||
            "" === href$jscomp$0
          ) {
            target$jscomp$0.push(startChunkForTag("style"));
            var children$jscomp$6 = null,
              innerHTML$jscomp$5 = null,
              propKey$jscomp$8;
            for (propKey$jscomp$8 in props)
              if (hasOwnProperty.call(props, propKey$jscomp$8)) {
                var propValue$jscomp$8 = props[propKey$jscomp$8];
                if (null != propValue$jscomp$8)
                  switch (propKey$jscomp$8) {
                    case "children":
                      children$jscomp$6 = propValue$jscomp$8;
                      break;
                    case "dangerouslySetInnerHTML":
                      innerHTML$jscomp$5 = propValue$jscomp$8;
                      break;
                    default:
                      pushAttribute(target$jscomp$0, propKey$jscomp$8, propValue$jscomp$8);
                  }
              }
            target$jscomp$0.push(">");
            var child = Array.isArray(children$jscomp$6)
              ? 2 > children$jscomp$6.length
                ? children$jscomp$6[0]
                : null
              : children$jscomp$6;
            "function" !== typeof child &&
              "symbol" !== typeof child &&
              null !== child &&
              void 0 !== child &&
              target$jscomp$0.push(("" + child).replace(styleRegex, styleReplacer));
            pushInnerHTML(target$jscomp$0, innerHTML$jscomp$5, children$jscomp$6);
            target$jscomp$0.push(endChunkForTag("style"));
            var JSCompiler_inline_result$jscomp$6 = null;
          } else {
            var styleQueue$jscomp$0 = renderState.styles.get(precedence$jscomp$0);
            if (
              null !==
              (resumableState.styleResources.hasOwnProperty(href$jscomp$0)
                ? resumableState.styleResources[href$jscomp$0]
                : void 0)
            ) {
              resumableState.styleResources[href$jscomp$0] = null;
              styleQueue$jscomp$0 ||
                ((styleQueue$jscomp$0 = {
                  precedence: escapeTextForBrowser(precedence$jscomp$0),
                  rules: [],
                  hrefs: [],
                  sheets: /* @__PURE__ */ new Map(),
                }),
                renderState.styles.set(precedence$jscomp$0, styleQueue$jscomp$0));
              var nonceStyle = renderState.nonce.style;
              if (!nonceStyle || nonceStyle === nonce) {
                styleQueue$jscomp$0.hrefs.push(escapeTextForBrowser(href$jscomp$0));
                var target = styleQueue$jscomp$0.rules,
                  children$jscomp$7 = null,
                  innerHTML$jscomp$6 = null,
                  propKey$jscomp$9;
                for (propKey$jscomp$9 in props)
                  if (hasOwnProperty.call(props, propKey$jscomp$9)) {
                    var propValue$jscomp$9 = props[propKey$jscomp$9];
                    if (null != propValue$jscomp$9)
                      switch (propKey$jscomp$9) {
                        case "children":
                          children$jscomp$7 = propValue$jscomp$9;
                          break;
                        case "dangerouslySetInnerHTML":
                          innerHTML$jscomp$6 = propValue$jscomp$9;
                      }
                  }
                var child$jscomp$0 = Array.isArray(children$jscomp$7)
                  ? 2 > children$jscomp$7.length
                    ? children$jscomp$7[0]
                    : null
                  : children$jscomp$7;
                "function" !== typeof child$jscomp$0 &&
                  "symbol" !== typeof child$jscomp$0 &&
                  null !== child$jscomp$0 &&
                  void 0 !== child$jscomp$0 &&
                  target.push(("" + child$jscomp$0).replace(styleRegex, styleReplacer));
                pushInnerHTML(target, innerHTML$jscomp$6, children$jscomp$7);
              }
            }
            styleQueue$jscomp$0 && hoistableState && hoistableState.styles.add(styleQueue$jscomp$0);
            textEmbedded && target$jscomp$0.push("<!-- -->");
            JSCompiler_inline_result$jscomp$6 = void 0;
          }
          return JSCompiler_inline_result$jscomp$6;
        case "meta":
          var noscriptTagInScope$jscomp$3 = formatContext.tagScope & 1,
            isFallback$jscomp$1 = formatContext.tagScope & 4;
          if (
            4 === formatContext.insertionMode ||
            noscriptTagInScope$jscomp$3 ||
            null != props.itemProp
          )
            var JSCompiler_inline_result$jscomp$7 = pushSelfClosing(target$jscomp$0, props, "meta");
          else
            (textEmbedded && target$jscomp$0.push("<!-- -->"),
              (JSCompiler_inline_result$jscomp$7 = isFallback$jscomp$1
                ? null
                : "string" === typeof props.charSet
                  ? pushSelfClosing(renderState.charsetChunks, props, "meta")
                  : "viewport" === props.name
                    ? pushSelfClosing(renderState.viewportChunks, props, "meta")
                    : pushSelfClosing(renderState.hoistableChunks, props, "meta")));
          return JSCompiler_inline_result$jscomp$7;
        case "listing":
        case "pre":
          target$jscomp$0.push(startChunkForTag(type));
          var children$jscomp$8 = null,
            innerHTML$jscomp$7 = null,
            propKey$jscomp$10;
          for (propKey$jscomp$10 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$10)) {
              var propValue$jscomp$10 = props[propKey$jscomp$10];
              if (null != propValue$jscomp$10)
                switch (propKey$jscomp$10) {
                  case "children":
                    children$jscomp$8 = propValue$jscomp$10;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$7 = propValue$jscomp$10;
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$10, propValue$jscomp$10);
                }
            }
          target$jscomp$0.push(">");
          if (null != innerHTML$jscomp$7) {
            if (null != children$jscomp$8) throw Error(formatProdErrorMessage(60));
            if ("object" !== typeof innerHTML$jscomp$7 || !("__html" in innerHTML$jscomp$7))
              throw Error(formatProdErrorMessage(61));
            var html = innerHTML$jscomp$7.__html;
            null !== html &&
              void 0 !== html &&
              ("string" === typeof html && 0 < html.length && "\n" === html[0]
                ? target$jscomp$0.push("\n", html)
                : target$jscomp$0.push("" + html));
          }
          "string" === typeof children$jscomp$8 &&
            "\n" === children$jscomp$8[0] &&
            target$jscomp$0.push("\n");
          return children$jscomp$8;
        case "img":
          var pictureOrNoScriptTagInScope = formatContext.tagScope & 3,
            src = props.src,
            srcSet = props.srcSet;
          if (
            !(
              "lazy" === props.loading ||
              (!src && !srcSet) ||
              ("string" !== typeof src && null != src) ||
              ("string" !== typeof srcSet && null != srcSet) ||
              "low" === props.fetchPriority ||
              pictureOrNoScriptTagInScope
            ) &&
            ("string" !== typeof src ||
              ":" !== src[4] ||
              ("d" !== src[0] && "D" !== src[0]) ||
              ("a" !== src[1] && "A" !== src[1]) ||
              ("t" !== src[2] && "T" !== src[2]) ||
              ("a" !== src[3] && "A" !== src[3])) &&
            ("string" !== typeof srcSet ||
              ":" !== srcSet[4] ||
              ("d" !== srcSet[0] && "D" !== srcSet[0]) ||
              ("a" !== srcSet[1] && "A" !== srcSet[1]) ||
              ("t" !== srcSet[2] && "T" !== srcSet[2]) ||
              ("a" !== srcSet[3] && "A" !== srcSet[3]))
          ) {
            null !== hoistableState &&
              formatContext.tagScope & 64 &&
              (hoistableState.suspenseyImages = !0);
            var sizes = "string" === typeof props.sizes ? props.sizes : void 0,
              key$jscomp$0 = srcSet ? srcSet + "\n" + (sizes || "") : src,
              promotablePreloads = renderState.preloads.images,
              resource$jscomp$1 = promotablePreloads.get(key$jscomp$0);
            if (resource$jscomp$1) {
              if ("high" === props.fetchPriority || 10 > renderState.highImagePreloads.size)
                (promotablePreloads.delete(key$jscomp$0),
                  renderState.highImagePreloads.add(resource$jscomp$1));
            } else if (!resumableState.imageResources.hasOwnProperty(key$jscomp$0)) {
              resumableState.imageResources[key$jscomp$0] = PRELOAD_NO_CREDS;
              var input = props.crossOrigin;
              var JSCompiler_inline_result$jscomp$8 =
                "string" === typeof input ? ("use-credentials" === input ? input : "") : void 0;
              var headers = renderState.headers,
                header;
              headers &&
              0 < headers.remainingCapacity &&
              "string" !== typeof props.srcSet &&
              ("high" === props.fetchPriority || 500 > headers.highImagePreloads.length) &&
              ((header = getPreloadAsHeader(src, "image", {
                imageSrcSet: props.srcSet,
                imageSizes: props.sizes,
                crossOrigin: JSCompiler_inline_result$jscomp$8,
                integrity: props.integrity,
                nonce: props.nonce,
                type: props.type,
                fetchPriority: props.fetchPriority,
                referrerPolicy: props.refererPolicy,
              })),
              0 <= (headers.remainingCapacity -= header.length + 2))
                ? ((renderState.resets.image[key$jscomp$0] = PRELOAD_NO_CREDS),
                  headers.highImagePreloads && (headers.highImagePreloads += ", "),
                  (headers.highImagePreloads += header))
                : ((resource$jscomp$1 = []),
                  pushLinkImpl(resource$jscomp$1, {
                    rel: "preload",
                    as: "image",
                    href: srcSet ? void 0 : src,
                    imageSrcSet: srcSet,
                    imageSizes: sizes,
                    crossOrigin: JSCompiler_inline_result$jscomp$8,
                    integrity: props.integrity,
                    type: props.type,
                    fetchPriority: props.fetchPriority,
                    referrerPolicy: props.referrerPolicy,
                  }),
                  "high" === props.fetchPriority || 10 > renderState.highImagePreloads.size
                    ? renderState.highImagePreloads.add(resource$jscomp$1)
                    : (renderState.bulkPreloads.add(resource$jscomp$1),
                      promotablePreloads.set(key$jscomp$0, resource$jscomp$1)));
            }
          }
          return pushSelfClosing(target$jscomp$0, props, "img");
        case "base":
        case "area":
        case "br":
        case "col":
        case "embed":
        case "hr":
        case "keygen":
        case "param":
        case "source":
        case "track":
        case "wbr":
          return pushSelfClosing(target$jscomp$0, props, type);
        case "annotation-xml":
        case "color-profile":
        case "font-face":
        case "font-face-src":
        case "font-face-uri":
        case "font-face-format":
        case "font-face-name":
        case "missing-glyph":
          break;
        case "head":
          if (2 > formatContext.insertionMode) {
            var preamble = preambleState || renderState.preamble;
            if (preamble.headChunks) throw Error(formatProdErrorMessage(545, "`<head>`"));
            null !== preambleState && target$jscomp$0.push("<!--head-->");
            preamble.headChunks = [];
            var JSCompiler_inline_result$jscomp$9 = pushStartSingletonElement(
              preamble.headChunks,
              props,
              "head",
            );
          } else
            JSCompiler_inline_result$jscomp$9 = pushStartGenericElement(
              target$jscomp$0,
              props,
              "head",
            );
          return JSCompiler_inline_result$jscomp$9;
        case "body":
          if (2 > formatContext.insertionMode) {
            var preamble$jscomp$0 = preambleState || renderState.preamble;
            if (preamble$jscomp$0.bodyChunks) throw Error(formatProdErrorMessage(545, "`<body>`"));
            null !== preambleState && target$jscomp$0.push("<!--body-->");
            preamble$jscomp$0.bodyChunks = [];
            var JSCompiler_inline_result$jscomp$10 = pushStartSingletonElement(
              preamble$jscomp$0.bodyChunks,
              props,
              "body",
            );
          } else
            JSCompiler_inline_result$jscomp$10 = pushStartGenericElement(
              target$jscomp$0,
              props,
              "body",
            );
          return JSCompiler_inline_result$jscomp$10;
        case "html":
          if (0 === formatContext.insertionMode) {
            var preamble$jscomp$1 = preambleState || renderState.preamble;
            if (preamble$jscomp$1.htmlChunks) throw Error(formatProdErrorMessage(545, "`<html>`"));
            null !== preambleState && target$jscomp$0.push("<!--html-->");
            preamble$jscomp$1.htmlChunks = [""];
            var JSCompiler_inline_result$jscomp$11 = pushStartSingletonElement(
              preamble$jscomp$1.htmlChunks,
              props,
              "html",
            );
          } else
            JSCompiler_inline_result$jscomp$11 = pushStartGenericElement(
              target$jscomp$0,
              props,
              "html",
            );
          return JSCompiler_inline_result$jscomp$11;
        default:
          if (-1 !== type.indexOf("-")) {
            target$jscomp$0.push(startChunkForTag(type));
            var children$jscomp$9 = null,
              innerHTML$jscomp$8 = null,
              propKey$jscomp$11;
            for (propKey$jscomp$11 in props)
              if (hasOwnProperty.call(props, propKey$jscomp$11)) {
                var propValue$jscomp$11 = props[propKey$jscomp$11];
                if (null != propValue$jscomp$11) {
                  var attributeName = propKey$jscomp$11;
                  switch (propKey$jscomp$11) {
                    case "children":
                      children$jscomp$9 = propValue$jscomp$11;
                      break;
                    case "dangerouslySetInnerHTML":
                      innerHTML$jscomp$8 = propValue$jscomp$11;
                      break;
                    case "style":
                      pushStyleAttribute(target$jscomp$0, propValue$jscomp$11);
                      break;
                    case "suppressContentEditableWarning":
                    case "suppressHydrationWarning":
                    case "ref":
                      break;
                    case "className":
                      attributeName = "class";
                    default:
                      if (
                        isAttributeNameSafe(propKey$jscomp$11) &&
                        "function" !== typeof propValue$jscomp$11 &&
                        "symbol" !== typeof propValue$jscomp$11 &&
                        !1 !== propValue$jscomp$11
                      ) {
                        if (!0 === propValue$jscomp$11) propValue$jscomp$11 = "";
                        else if ("object" === typeof propValue$jscomp$11) continue;
                        target$jscomp$0.push(
                          " ",
                          attributeName,
                          '="',
                          escapeTextForBrowser(propValue$jscomp$11),
                          '"',
                        );
                      }
                  }
                }
              }
            target$jscomp$0.push(">");
            pushInnerHTML(target$jscomp$0, innerHTML$jscomp$8, children$jscomp$9);
            return children$jscomp$9;
          }
      }
      return pushStartGenericElement(target$jscomp$0, props, type);
    }
    var endTagCache = /* @__PURE__ */ new Map();
    function endChunkForTag(tag) {
      var chunk = endTagCache.get(tag);
      void 0 === chunk && ((chunk = "</" + tag + ">"), endTagCache.set(tag, chunk));
      return chunk;
    }
    function hoistPreambleState(renderState, preambleState) {
      renderState = renderState.preamble;
      null === renderState.htmlChunks &&
        preambleState.htmlChunks &&
        (renderState.htmlChunks = preambleState.htmlChunks);
      null === renderState.headChunks &&
        preambleState.headChunks &&
        (renderState.headChunks = preambleState.headChunks);
      null === renderState.bodyChunks &&
        preambleState.bodyChunks &&
        (renderState.bodyChunks = preambleState.bodyChunks);
    }
    function writeBootstrap(destination, renderState) {
      renderState = renderState.bootstrapChunks;
      for (var i = 0; i < renderState.length - 1; i++) destination.push(renderState[i]);
      return i < renderState.length
        ? ((i = renderState[i]), (renderState.length = 0), destination.push(i))
        : !0;
    }
    function writeStartPendingSuspenseBoundary(destination, renderState, id) {
      destination.push('<!--$?--><template id="');
      if (null === id) throw Error(formatProdErrorMessage(395));
      destination.push(renderState.boundaryPrefix);
      renderState = id.toString(16);
      destination.push(renderState);
      return destination.push('"></template>');
    }
    function writeStartSegment(destination, renderState, formatContext, id) {
      switch (formatContext.insertionMode) {
        case 0:
        case 1:
        case 3:
        case 2:
          return (
            destination.push('<div hidden id="'),
            destination.push(renderState.segmentPrefix),
            (renderState = id.toString(16)),
            destination.push(renderState),
            destination.push('">')
          );
        case 4:
          return (
            destination.push('<svg aria-hidden="true" style="display:none" id="'),
            destination.push(renderState.segmentPrefix),
            (renderState = id.toString(16)),
            destination.push(renderState),
            destination.push('">')
          );
        case 5:
          return (
            destination.push('<math aria-hidden="true" style="display:none" id="'),
            destination.push(renderState.segmentPrefix),
            (renderState = id.toString(16)),
            destination.push(renderState),
            destination.push('">')
          );
        case 6:
          return (
            destination.push('<table hidden id="'),
            destination.push(renderState.segmentPrefix),
            (renderState = id.toString(16)),
            destination.push(renderState),
            destination.push('">')
          );
        case 7:
          return (
            destination.push('<table hidden><tbody id="'),
            destination.push(renderState.segmentPrefix),
            (renderState = id.toString(16)),
            destination.push(renderState),
            destination.push('">')
          );
        case 8:
          return (
            destination.push('<table hidden><tr id="'),
            destination.push(renderState.segmentPrefix),
            (renderState = id.toString(16)),
            destination.push(renderState),
            destination.push('">')
          );
        case 9:
          return (
            destination.push('<table hidden><colgroup id="'),
            destination.push(renderState.segmentPrefix),
            (renderState = id.toString(16)),
            destination.push(renderState),
            destination.push('">')
          );
        default:
          throw Error(formatProdErrorMessage(397));
      }
    }
    function writeEndSegment(destination, formatContext) {
      switch (formatContext.insertionMode) {
        case 0:
        case 1:
        case 3:
        case 2:
          return destination.push("</div>");
        case 4:
          return destination.push("</svg>");
        case 5:
          return destination.push("</math>");
        case 6:
          return destination.push("</table>");
        case 7:
          return destination.push("</tbody></table>");
        case 8:
          return destination.push("</tr></table>");
        case 9:
          return destination.push("</colgroup></table>");
        default:
          throw Error(formatProdErrorMessage(397));
      }
    }
    var regexForJSStringsInInstructionScripts = /[<\u2028\u2029]/g;
    function escapeJSStringsForInstructionScripts(input) {
      return JSON.stringify(input).replace(regexForJSStringsInInstructionScripts, function (match) {
        switch (match) {
          case "<":
            return "\\u003c";
          case "\u2028":
            return "\\u2028";
          case "\u2029":
            return "\\u2029";
          default:
            throw Error(
              "escapeJSStringsForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
            );
        }
      });
    }
    var regexForJSStringsInScripts = /[&><\u2028\u2029]/g;
    function escapeJSObjectForInstructionScripts(input) {
      return JSON.stringify(input).replace(regexForJSStringsInScripts, function (match) {
        switch (match) {
          case "&":
            return "\\u0026";
          case ">":
            return "\\u003e";
          case "<":
            return "\\u003c";
          case "\u2028":
            return "\\u2028";
          case "\u2029":
            return "\\u2029";
          default:
            throw Error(
              "escapeJSObjectForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
            );
        }
      });
    }
    var currentlyRenderingBoundaryHasStylesToHoist = !1,
      destinationHasCapacity = !0;
    function flushStyleTagsLateForBoundary(styleQueue) {
      var rules = styleQueue.rules,
        hrefs = styleQueue.hrefs,
        i = 0;
      if (hrefs.length) {
        this.push(currentlyFlushingRenderState.startInlineStyle);
        this.push(' media="not all" data-precedence="');
        this.push(styleQueue.precedence);
        for (this.push('" data-href="'); i < hrefs.length - 1; i++)
          (this.push(hrefs[i]), this.push(" "));
        this.push(hrefs[i]);
        this.push('">');
        for (i = 0; i < rules.length; i++) this.push(rules[i]);
        destinationHasCapacity = this.push("</style>");
        currentlyRenderingBoundaryHasStylesToHoist = !0;
        rules.length = 0;
        hrefs.length = 0;
      }
    }
    function hasStylesToHoist(stylesheet) {
      return 2 !== stylesheet.state ? (currentlyRenderingBoundaryHasStylesToHoist = !0) : !1;
    }
    function writeHoistablesForBoundary(destination, hoistableState, renderState) {
      currentlyRenderingBoundaryHasStylesToHoist = !1;
      destinationHasCapacity = !0;
      currentlyFlushingRenderState = renderState;
      hoistableState.styles.forEach(flushStyleTagsLateForBoundary, destination);
      currentlyFlushingRenderState = null;
      hoistableState.stylesheets.forEach(hasStylesToHoist);
      currentlyRenderingBoundaryHasStylesToHoist && (renderState.stylesToHoist = !0);
      return destinationHasCapacity;
    }
    function flushResource(resource) {
      for (var i = 0; i < resource.length; i++) this.push(resource[i]);
      resource.length = 0;
    }
    var stylesheetFlushingQueue = [];
    function flushStyleInPreamble(stylesheet) {
      pushLinkImpl(stylesheetFlushingQueue, stylesheet.props);
      for (var i = 0; i < stylesheetFlushingQueue.length; i++)
        this.push(stylesheetFlushingQueue[i]);
      stylesheetFlushingQueue.length = 0;
      stylesheet.state = 2;
    }
    function flushStylesInPreamble(styleQueue) {
      var hasStylesheets = 0 < styleQueue.sheets.size;
      styleQueue.sheets.forEach(flushStyleInPreamble, this);
      styleQueue.sheets.clear();
      var rules = styleQueue.rules,
        hrefs = styleQueue.hrefs;
      if (!hasStylesheets || hrefs.length) {
        this.push(currentlyFlushingRenderState.startInlineStyle);
        this.push(' data-precedence="');
        this.push(styleQueue.precedence);
        styleQueue = 0;
        if (hrefs.length) {
          for (this.push('" data-href="'); styleQueue < hrefs.length - 1; styleQueue++)
            (this.push(hrefs[styleQueue]), this.push(" "));
          this.push(hrefs[styleQueue]);
        }
        this.push('">');
        for (styleQueue = 0; styleQueue < rules.length; styleQueue++) this.push(rules[styleQueue]);
        this.push("</style>");
        rules.length = 0;
        hrefs.length = 0;
      }
    }
    function preloadLateStyle(stylesheet) {
      if (0 === stylesheet.state) {
        stylesheet.state = 1;
        var props = stylesheet.props;
        pushLinkImpl(stylesheetFlushingQueue, {
          rel: "preload",
          as: "style",
          href: stylesheet.props.href,
          crossOrigin: props.crossOrigin,
          fetchPriority: props.fetchPriority,
          integrity: props.integrity,
          media: props.media,
          hrefLang: props.hrefLang,
          referrerPolicy: props.referrerPolicy,
        });
        for (stylesheet = 0; stylesheet < stylesheetFlushingQueue.length; stylesheet++)
          this.push(stylesheetFlushingQueue[stylesheet]);
        stylesheetFlushingQueue.length = 0;
      }
    }
    function preloadLateStyles(styleQueue) {
      styleQueue.sheets.forEach(preloadLateStyle, this);
      styleQueue.sheets.clear();
    }
    function pushCompletedShellIdAttribute(target, resumableState) {
      0 === (resumableState.instructions & 32) &&
        ((resumableState.instructions |= 32),
        target.push(' id="', escapeTextForBrowser("_" + resumableState.idPrefix + "R_"), '"'));
    }
    function writeStyleResourceDependenciesInJS(destination, hoistableState) {
      destination.push("[");
      var nextArrayOpenBrackChunk = "[";
      hoistableState.stylesheets.forEach(function (resource) {
        if (2 !== resource.state)
          if (3 === resource.state)
            (destination.push(nextArrayOpenBrackChunk),
              (resource = escapeJSObjectForInstructionScripts("" + resource.props.href)),
              destination.push(resource),
              destination.push("]"),
              (nextArrayOpenBrackChunk = ",["));
          else {
            destination.push(nextArrayOpenBrackChunk);
            var precedence = resource.props["data-precedence"],
              props = resource.props,
              coercedHref = sanitizeURL("" + resource.props.href);
            coercedHref = escapeJSObjectForInstructionScripts(coercedHref);
            destination.push(coercedHref);
            precedence = "" + precedence;
            destination.push(",");
            precedence = escapeJSObjectForInstructionScripts(precedence);
            destination.push(precedence);
            for (var propKey in props)
              if (
                hasOwnProperty.call(props, propKey) &&
                ((precedence = props[propKey]), null != precedence)
              )
                switch (propKey) {
                  case "href":
                  case "rel":
                  case "precedence":
                  case "data-precedence":
                    break;
                  case "children":
                  case "dangerouslySetInnerHTML":
                    throw Error(formatProdErrorMessage(399, "link"));
                  default:
                    writeStyleResourceAttributeInJS(destination, propKey, precedence);
                }
            destination.push("]");
            nextArrayOpenBrackChunk = ",[";
            resource.state = 3;
          }
      });
      destination.push("]");
    }
    function writeStyleResourceAttributeInJS(destination, name, value) {
      var attributeName = name.toLowerCase();
      switch (typeof value) {
        case "function":
        case "symbol":
          return;
      }
      switch (name) {
        case "innerHTML":
        case "dangerouslySetInnerHTML":
        case "suppressContentEditableWarning":
        case "suppressHydrationWarning":
        case "style":
        case "ref":
          return;
        case "className":
          attributeName = "class";
          name = "" + value;
          break;
        case "hidden":
          if (!1 === value) return;
          name = "";
          break;
        case "src":
        case "href":
          value = sanitizeURL(value);
          name = "" + value;
          break;
        default:
          if (
            (2 < name.length &&
              ("o" === name[0] || "O" === name[0]) &&
              ("n" === name[1] || "N" === name[1])) ||
            !isAttributeNameSafe(name)
          )
            return;
          name = "" + value;
      }
      destination.push(",");
      attributeName = escapeJSObjectForInstructionScripts(attributeName);
      destination.push(attributeName);
      destination.push(",");
      attributeName = escapeJSObjectForInstructionScripts(name);
      destination.push(attributeName);
    }
    function createHoistableState() {
      return {
        styles: /* @__PURE__ */ new Set(),
        stylesheets: /* @__PURE__ */ new Set(),
        suspenseyImages: !1,
      };
    }
    function prefetchDNS(href) {
      var request = currentRequest ? currentRequest : null;
      if (request) {
        var resumableState = request.resumableState,
          renderState = request.renderState;
        if ("string" === typeof href && href) {
          if (!resumableState.dnsResources.hasOwnProperty(href)) {
            resumableState.dnsResources[href] = null;
            resumableState = renderState.headers;
            var header, JSCompiler_temp;
            if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity))
              JSCompiler_temp =
                ((header =
                  "<" +
                  ("" + href).replace(
                    regexForHrefInLinkHeaderURLContext,
                    escapeHrefForLinkHeaderURLContextReplacer,
                  ) +
                  ">; rel=dns-prefetch"),
                0 <= (resumableState.remainingCapacity -= header.length + 2));
            JSCompiler_temp
              ? ((renderState.resets.dns[href] = null),
                resumableState.preconnects && (resumableState.preconnects += ", "),
                (resumableState.preconnects += header))
              : ((header = []),
                pushLinkImpl(header, {
                  href,
                  rel: "dns-prefetch",
                }),
                renderState.preconnects.add(header));
          }
          enqueueFlush(request);
        }
      } else previousDispatcher.D(href);
    }
    function preconnect(href, crossOrigin) {
      var request = currentRequest ? currentRequest : null;
      if (request) {
        var resumableState = request.resumableState,
          renderState = request.renderState;
        if ("string" === typeof href && href) {
          var bucket =
            "use-credentials" === crossOrigin
              ? "credentials"
              : "string" === typeof crossOrigin
                ? "anonymous"
                : "default";
          if (!resumableState.connectResources[bucket].hasOwnProperty(href)) {
            resumableState.connectResources[bucket][href] = null;
            resumableState = renderState.headers;
            var header, JSCompiler_temp;
            if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity)) {
              JSCompiler_temp =
                "<" +
                ("" + href).replace(
                  regexForHrefInLinkHeaderURLContext,
                  escapeHrefForLinkHeaderURLContextReplacer,
                ) +
                ">; rel=preconnect";
              if ("string" === typeof crossOrigin) {
                var escapedCrossOrigin = ("" + crossOrigin).replace(
                  regexForLinkHeaderQuotedParamValueContext,
                  escapeStringForLinkHeaderQuotedParamValueContextReplacer,
                );
                JSCompiler_temp += '; crossorigin="' + escapedCrossOrigin + '"';
              }
              JSCompiler_temp =
                ((header = JSCompiler_temp),
                0 <= (resumableState.remainingCapacity -= header.length + 2));
            }
            JSCompiler_temp
              ? ((renderState.resets.connect[bucket][href] = null),
                resumableState.preconnects && (resumableState.preconnects += ", "),
                (resumableState.preconnects += header))
              : ((bucket = []),
                pushLinkImpl(bucket, {
                  rel: "preconnect",
                  href,
                  crossOrigin,
                }),
                renderState.preconnects.add(bucket));
          }
          enqueueFlush(request);
        }
      } else previousDispatcher.C(href, crossOrigin);
    }
    function preload(href, as, options) {
      var request = currentRequest ? currentRequest : null;
      if (request) {
        var resumableState = request.resumableState,
          renderState = request.renderState;
        if (as && href) {
          switch (as) {
            case "image":
              if (options) {
                var imageSrcSet = options.imageSrcSet;
                var imageSizes = options.imageSizes;
                var fetchPriority = options.fetchPriority;
              }
              var key = imageSrcSet ? imageSrcSet + "\n" + (imageSizes || "") : href;
              if (resumableState.imageResources.hasOwnProperty(key)) return;
              resumableState.imageResources[key] = PRELOAD_NO_CREDS;
              resumableState = renderState.headers;
              var header;
              resumableState &&
              0 < resumableState.remainingCapacity &&
              "string" !== typeof imageSrcSet &&
              "high" === fetchPriority &&
              ((header = getPreloadAsHeader(href, as, options)),
              0 <= (resumableState.remainingCapacity -= header.length + 2))
                ? ((renderState.resets.image[key] = PRELOAD_NO_CREDS),
                  resumableState.highImagePreloads && (resumableState.highImagePreloads += ", "),
                  (resumableState.highImagePreloads += header))
                : ((resumableState = []),
                  pushLinkImpl(
                    resumableState,
                    assign(
                      {
                        rel: "preload",
                        href: imageSrcSet ? void 0 : href,
                        as,
                      },
                      options,
                    ),
                  ),
                  "high" === fetchPriority
                    ? renderState.highImagePreloads.add(resumableState)
                    : (renderState.bulkPreloads.add(resumableState),
                      renderState.preloads.images.set(key, resumableState)));
              break;
            case "style":
              if (resumableState.styleResources.hasOwnProperty(href)) return;
              imageSrcSet = [];
              pushLinkImpl(
                imageSrcSet,
                assign(
                  {
                    rel: "preload",
                    href,
                    as,
                  },
                  options,
                ),
              );
              resumableState.styleResources[href] =
                !options ||
                ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                  ? PRELOAD_NO_CREDS
                  : [options.crossOrigin, options.integrity];
              renderState.preloads.stylesheets.set(href, imageSrcSet);
              renderState.bulkPreloads.add(imageSrcSet);
              break;
            case "script":
              if (resumableState.scriptResources.hasOwnProperty(href)) return;
              imageSrcSet = [];
              renderState.preloads.scripts.set(href, imageSrcSet);
              renderState.bulkPreloads.add(imageSrcSet);
              pushLinkImpl(
                imageSrcSet,
                assign(
                  {
                    rel: "preload",
                    href,
                    as,
                  },
                  options,
                ),
              );
              resumableState.scriptResources[href] =
                !options ||
                ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                  ? PRELOAD_NO_CREDS
                  : [options.crossOrigin, options.integrity];
              break;
            default:
              if (resumableState.unknownResources.hasOwnProperty(as)) {
                if (
                  ((imageSrcSet = resumableState.unknownResources[as]),
                  imageSrcSet.hasOwnProperty(href))
                )
                  return;
              } else ((imageSrcSet = {}), (resumableState.unknownResources[as] = imageSrcSet));
              imageSrcSet[href] = PRELOAD_NO_CREDS;
              if (
                (resumableState = renderState.headers) &&
                0 < resumableState.remainingCapacity &&
                "font" === as &&
                ((key = getPreloadAsHeader(href, as, options)),
                0 <= (resumableState.remainingCapacity -= key.length + 2))
              )
                ((renderState.resets.font[href] = PRELOAD_NO_CREDS),
                  resumableState.fontPreloads && (resumableState.fontPreloads += ", "),
                  (resumableState.fontPreloads += key));
              else
                switch (
                  ((resumableState = []),
                  (href = assign(
                    {
                      rel: "preload",
                      href,
                      as,
                    },
                    options,
                  )),
                  pushLinkImpl(resumableState, href),
                  as)
                ) {
                  case "font":
                    renderState.fontPreloads.add(resumableState);
                    break;
                  default:
                    renderState.bulkPreloads.add(resumableState);
                }
          }
          enqueueFlush(request);
        }
      } else previousDispatcher.L(href, as, options);
    }
    function preloadModule(href, options) {
      var request = currentRequest ? currentRequest : null;
      if (request) {
        var resumableState = request.resumableState,
          renderState = request.renderState;
        if (href) {
          var as = options && "string" === typeof options.as ? options.as : "script";
          switch (as) {
            case "script":
              if (resumableState.moduleScriptResources.hasOwnProperty(href)) return;
              as = [];
              resumableState.moduleScriptResources[href] =
                !options ||
                ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                  ? PRELOAD_NO_CREDS
                  : [options.crossOrigin, options.integrity];
              renderState.preloads.moduleScripts.set(href, as);
              break;
            default:
              if (resumableState.moduleUnknownResources.hasOwnProperty(as)) {
                var resources = resumableState.unknownResources[as];
                if (resources.hasOwnProperty(href)) return;
              } else ((resources = {}), (resumableState.moduleUnknownResources[as] = resources));
              as = [];
              resources[href] = PRELOAD_NO_CREDS;
          }
          pushLinkImpl(
            as,
            assign(
              {
                rel: "modulepreload",
                href,
              },
              options,
            ),
          );
          renderState.bulkPreloads.add(as);
          enqueueFlush(request);
        }
      } else previousDispatcher.m(href, options);
    }
    function preinitStyle(href, precedence, options) {
      var request = currentRequest ? currentRequest : null;
      if (request) {
        var resumableState = request.resumableState,
          renderState = request.renderState;
        if (href) {
          precedence = precedence || "default";
          var styleQueue = renderState.styles.get(precedence),
            resourceState = resumableState.styleResources.hasOwnProperty(href)
              ? resumableState.styleResources[href]
              : void 0;
          null !== resourceState &&
            ((resumableState.styleResources[href] = null),
            styleQueue ||
              ((styleQueue = {
                precedence: escapeTextForBrowser(precedence),
                rules: [],
                hrefs: [],
                sheets: /* @__PURE__ */ new Map(),
              }),
              renderState.styles.set(precedence, styleQueue)),
            (precedence = {
              state: 0,
              props: assign(
                {
                  rel: "stylesheet",
                  href,
                  "data-precedence": precedence,
                },
                options,
              ),
            }),
            resourceState &&
              (2 === resourceState.length &&
                adoptPreloadCredentials(precedence.props, resourceState),
              (renderState = renderState.preloads.stylesheets.get(href)) && 0 < renderState.length
                ? (renderState.length = 0)
                : (precedence.state = 1)),
            styleQueue.sheets.set(href, precedence),
            enqueueFlush(request));
        }
      } else previousDispatcher.S(href, precedence, options);
    }
    function preinitScript(src, options) {
      var request = currentRequest ? currentRequest : null;
      if (request) {
        var resumableState = request.resumableState,
          renderState = request.renderState;
        if (src) {
          var resourceState = resumableState.scriptResources.hasOwnProperty(src)
            ? resumableState.scriptResources[src]
            : void 0;
          null !== resourceState &&
            ((resumableState.scriptResources[src] = null),
            (options = assign(
              {
                src,
                async: !0,
              },
              options,
            )),
            resourceState &&
              (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
              (src = renderState.preloads.scripts.get(src))) &&
              (src.length = 0),
            (src = []),
            renderState.scripts.add(src),
            pushScriptImpl(src, options),
            enqueueFlush(request));
        }
      } else previousDispatcher.X(src, options);
    }
    function preinitModuleScript(src, options) {
      var request = currentRequest ? currentRequest : null;
      if (request) {
        var resumableState = request.resumableState,
          renderState = request.renderState;
        if (src) {
          var resourceState = resumableState.moduleScriptResources.hasOwnProperty(src)
            ? resumableState.moduleScriptResources[src]
            : void 0;
          null !== resourceState &&
            ((resumableState.moduleScriptResources[src] = null),
            (options = assign(
              {
                src,
                type: "module",
                async: !0,
              },
              options,
            )),
            resourceState &&
              (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
              (src = renderState.preloads.moduleScripts.get(src))) &&
              (src.length = 0),
            (src = []),
            renderState.scripts.add(src),
            pushScriptImpl(src, options),
            enqueueFlush(request));
        }
      } else previousDispatcher.M(src, options);
    }
    function adoptPreloadCredentials(target, preloadState) {
      target.crossOrigin ??= preloadState[0];
      target.integrity ??= preloadState[1];
    }
    function getPreloadAsHeader(href, as, params) {
      href = ("" + href).replace(
        regexForHrefInLinkHeaderURLContext,
        escapeHrefForLinkHeaderURLContextReplacer,
      );
      as = ("" + as).replace(
        regexForLinkHeaderQuotedParamValueContext,
        escapeStringForLinkHeaderQuotedParamValueContextReplacer,
      );
      as = "<" + href + '>; rel=preload; as="' + as + '"';
      for (var paramName in params)
        hasOwnProperty.call(params, paramName) &&
          ((href = params[paramName]),
          "string" === typeof href &&
            (as +=
              "; " +
              paramName.toLowerCase() +
              '="' +
              ("" + href).replace(
                regexForLinkHeaderQuotedParamValueContext,
                escapeStringForLinkHeaderQuotedParamValueContextReplacer,
              ) +
              '"'));
      return as;
    }
    var regexForHrefInLinkHeaderURLContext = /[<>\r\n]/g;
    function escapeHrefForLinkHeaderURLContextReplacer(match) {
      switch (match) {
        case "<":
          return "%3C";
        case ">":
          return "%3E";
        case "\n":
          return "%0A";
        case "\r":
          return "%0D";
        default:
          throw Error(
            "escapeLinkHrefForHeaderContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    }
    var regexForLinkHeaderQuotedParamValueContext = /["';,\r\n]/g;
    function escapeStringForLinkHeaderQuotedParamValueContextReplacer(match) {
      switch (match) {
        case '"':
          return "%22";
        case "'":
          return "%27";
        case ";":
          return "%3B";
        case ",":
          return "%2C";
        case "\n":
          return "%0A";
        case "\r":
          return "%0D";
        default:
          throw Error(
            "escapeStringForLinkHeaderQuotedParamValueContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    }
    function hoistStyleQueueDependency(styleQueue) {
      this.styles.add(styleQueue);
    }
    function hoistStylesheetDependency(stylesheet) {
      this.stylesheets.add(stylesheet);
    }
    function hoistHoistables(parentState, childState) {
      childState.styles.forEach(hoistStyleQueueDependency, parentState);
      childState.stylesheets.forEach(hoistStylesheetDependency, parentState);
      childState.suspenseyImages && (parentState.suspenseyImages = !0);
    }
    function createRenderState(resumableState, generateStaticMarkup) {
      var idPrefix = resumableState.idPrefix,
        bootstrapChunks = [],
        bootstrapScriptContent = resumableState.bootstrapScriptContent,
        bootstrapScripts = resumableState.bootstrapScripts,
        bootstrapModules = resumableState.bootstrapModules;
      void 0 !== bootstrapScriptContent &&
        (bootstrapChunks.push("<script"),
        pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
        bootstrapChunks.push(
          ">",
          ("" + bootstrapScriptContent).replace(scriptRegex, scriptReplacer),
          "<\/script>",
        ));
      bootstrapScriptContent = idPrefix + "P:";
      var JSCompiler_object_inline_segmentPrefix_1673 = idPrefix + "S:";
      idPrefix += "B:";
      var JSCompiler_object_inline_preconnects_1687 = /* @__PURE__ */ new Set(),
        JSCompiler_object_inline_fontPreloads_1688 = /* @__PURE__ */ new Set(),
        JSCompiler_object_inline_highImagePreloads_1689 = /* @__PURE__ */ new Set(),
        JSCompiler_object_inline_styles_1690 = /* @__PURE__ */ new Map(),
        JSCompiler_object_inline_bootstrapScripts_1691 = /* @__PURE__ */ new Set(),
        JSCompiler_object_inline_scripts_1692 = /* @__PURE__ */ new Set(),
        JSCompiler_object_inline_bulkPreloads_1693 = /* @__PURE__ */ new Set(),
        JSCompiler_object_inline_preloads_1694 = {
          images: /* @__PURE__ */ new Map(),
          stylesheets: /* @__PURE__ */ new Map(),
          scripts: /* @__PURE__ */ new Map(),
          moduleScripts: /* @__PURE__ */ new Map(),
        };
      if (void 0 !== bootstrapScripts)
        for (var i = 0; i < bootstrapScripts.length; i++) {
          var scriptConfig = bootstrapScripts[i],
            src,
            crossOrigin = void 0,
            integrity = void 0,
            props = {
              rel: "preload",
              as: "script",
              fetchPriority: "low",
              nonce: void 0,
            };
          "string" === typeof scriptConfig
            ? (props.href = src = scriptConfig)
            : ((props.href = src = scriptConfig.src),
              (props.integrity = integrity =
                "string" === typeof scriptConfig.integrity ? scriptConfig.integrity : void 0),
              (props.crossOrigin = crossOrigin =
                "string" === typeof scriptConfig || null == scriptConfig.crossOrigin
                  ? void 0
                  : "use-credentials" === scriptConfig.crossOrigin
                    ? "use-credentials"
                    : ""));
          scriptConfig = resumableState;
          var href = src;
          scriptConfig.scriptResources[href] = null;
          scriptConfig.moduleScriptResources[href] = null;
          scriptConfig = [];
          pushLinkImpl(scriptConfig, props);
          JSCompiler_object_inline_bootstrapScripts_1691.add(scriptConfig);
          bootstrapChunks.push('<script src="', escapeTextForBrowser(src), '"');
          "string" === typeof integrity &&
            bootstrapChunks.push(' integrity="', escapeTextForBrowser(integrity), '"');
          "string" === typeof crossOrigin &&
            bootstrapChunks.push(' crossorigin="', escapeTextForBrowser(crossOrigin), '"');
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState);
          bootstrapChunks.push(' async=""><\/script>');
        }
      if (void 0 !== bootstrapModules)
        for (bootstrapScripts = 0; bootstrapScripts < bootstrapModules.length; bootstrapScripts++)
          ((props = bootstrapModules[bootstrapScripts]),
            (crossOrigin = src = void 0),
            (integrity = {
              rel: "modulepreload",
              fetchPriority: "low",
              nonce: void 0,
            }),
            "string" === typeof props
              ? (integrity.href = i = props)
              : ((integrity.href = i = props.src),
                (integrity.integrity = crossOrigin =
                  "string" === typeof props.integrity ? props.integrity : void 0),
                (integrity.crossOrigin = src =
                  "string" === typeof props || null == props.crossOrigin
                    ? void 0
                    : "use-credentials" === props.crossOrigin
                      ? "use-credentials"
                      : "")),
            (props = resumableState),
            (scriptConfig = i),
            (props.scriptResources[scriptConfig] = null),
            (props.moduleScriptResources[scriptConfig] = null),
            (props = []),
            pushLinkImpl(props, integrity),
            JSCompiler_object_inline_bootstrapScripts_1691.add(props),
            bootstrapChunks.push('<script type="module" src="', escapeTextForBrowser(i), '"'),
            "string" === typeof crossOrigin &&
              bootstrapChunks.push(' integrity="', escapeTextForBrowser(crossOrigin), '"'),
            "string" === typeof src &&
              bootstrapChunks.push(' crossorigin="', escapeTextForBrowser(src), '"'),
            pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
            bootstrapChunks.push(' async=""><\/script>'));
      return {
        placeholderPrefix: bootstrapScriptContent,
        segmentPrefix: JSCompiler_object_inline_segmentPrefix_1673,
        boundaryPrefix: idPrefix,
        startInlineScript: "<script",
        startInlineStyle: "<style",
        preamble: {
          htmlChunks: null,
          headChunks: null,
          bodyChunks: null,
        },
        externalRuntimeScript: null,
        bootstrapChunks,
        importMapChunks: [],
        onHeaders: void 0,
        headers: null,
        resets: {
          font: {},
          dns: {},
          connect: {
            default: {},
            anonymous: {},
            credentials: {},
          },
          image: {},
          style: {},
        },
        charsetChunks: [],
        viewportChunks: [],
        hoistableChunks: [],
        preconnects: JSCompiler_object_inline_preconnects_1687,
        fontPreloads: JSCompiler_object_inline_fontPreloads_1688,
        highImagePreloads: JSCompiler_object_inline_highImagePreloads_1689,
        styles: JSCompiler_object_inline_styles_1690,
        bootstrapScripts: JSCompiler_object_inline_bootstrapScripts_1691,
        scripts: JSCompiler_object_inline_scripts_1692,
        bulkPreloads: JSCompiler_object_inline_bulkPreloads_1693,
        preloads: JSCompiler_object_inline_preloads_1694,
        nonce: {
          script: void 0,
          style: void 0,
        },
        stylesToHoist: !1,
        generateStaticMarkup,
      };
    }
    function pushTextInstance(target, text, renderState, textEmbedded) {
      if (renderState.generateStaticMarkup) return (target.push(escapeTextForBrowser(text)), !1);
      "" === text
        ? (target = textEmbedded)
        : (textEmbedded && target.push("<!-- -->"),
          target.push(escapeTextForBrowser(text)),
          (target = !0));
      return target;
    }
    function pushSegmentFinale(target, renderState, lastPushedText, textEmbedded) {
      renderState.generateStaticMarkup ||
        (lastPushedText && textEmbedded && target.push("<!-- -->"));
    }
    var bind = Function.prototype.bind,
      REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");
    function getComponentNameFromType(type) {
      if (null == type) return null;
      if ("function" === typeof type)
        return type.$$typeof === REACT_CLIENT_REFERENCE
          ? null
          : type.displayName || type.name || null;
      if ("string" === typeof type) return type;
      switch (type) {
        case REACT_FRAGMENT_TYPE:
          return "Fragment";
        case REACT_PROFILER_TYPE:
          return "Profiler";
        case REACT_STRICT_MODE_TYPE:
          return "StrictMode";
        case REACT_SUSPENSE_TYPE:
          return "Suspense";
        case REACT_SUSPENSE_LIST_TYPE:
          return "SuspenseList";
        case REACT_ACTIVITY_TYPE:
          return "Activity";
      }
      if ("object" === typeof type)
        switch (type.$$typeof) {
          case REACT_PORTAL_TYPE:
            return "Portal";
          case REACT_CONTEXT_TYPE:
            return type.displayName || "Context";
          case REACT_CONSUMER_TYPE:
            return (type._context.displayName || "Context") + ".Consumer";
          case REACT_FORWARD_REF_TYPE:
            var innerType = type.render;
            type = type.displayName;
            type ||
              ((type = innerType.displayName || innerType.name || ""),
              (type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef"));
            return type;
          case REACT_MEMO_TYPE:
            return (
              (innerType = type.displayName || null),
              null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo"
            );
          case REACT_LAZY_TYPE:
            innerType = type._payload;
            type = type._init;
            try {
              return getComponentNameFromType(type(innerType));
            } catch (x) {}
        }
      return null;
    }
    var emptyContextObject = {},
      currentActiveSnapshot = null;
    function popToNearestCommonAncestor(prev, next) {
      if (prev !== next) {
        prev.context._currentValue2 = prev.parentValue;
        prev = prev.parent;
        var parentNext = next.parent;
        if (null === prev) {
          if (null !== parentNext) throw Error(formatProdErrorMessage(401));
        } else {
          if (null === parentNext) throw Error(formatProdErrorMessage(401));
          popToNearestCommonAncestor(prev, parentNext);
        }
        next.context._currentValue2 = next.value;
      }
    }
    function popAllPrevious(prev) {
      prev.context._currentValue2 = prev.parentValue;
      prev = prev.parent;
      null !== prev && popAllPrevious(prev);
    }
    function pushAllNext(next) {
      var parentNext = next.parent;
      null !== parentNext && pushAllNext(parentNext);
      next.context._currentValue2 = next.value;
    }
    function popPreviousToCommonLevel(prev, next) {
      prev.context._currentValue2 = prev.parentValue;
      prev = prev.parent;
      if (null === prev) throw Error(formatProdErrorMessage(402));
      prev.depth === next.depth
        ? popToNearestCommonAncestor(prev, next)
        : popPreviousToCommonLevel(prev, next);
    }
    function popNextToCommonLevel(prev, next) {
      var parentNext = next.parent;
      if (null === parentNext) throw Error(formatProdErrorMessage(402));
      prev.depth === parentNext.depth
        ? popToNearestCommonAncestor(prev, parentNext)
        : popNextToCommonLevel(prev, parentNext);
      next.context._currentValue2 = next.value;
    }
    function switchContext(newSnapshot) {
      var prev = currentActiveSnapshot;
      prev !== newSnapshot &&
        (null === prev
          ? pushAllNext(newSnapshot)
          : null === newSnapshot
            ? popAllPrevious(prev)
            : prev.depth === newSnapshot.depth
              ? popToNearestCommonAncestor(prev, newSnapshot)
              : prev.depth > newSnapshot.depth
                ? popPreviousToCommonLevel(prev, newSnapshot)
                : popNextToCommonLevel(prev, newSnapshot),
        (currentActiveSnapshot = newSnapshot));
    }
    var classComponentUpdater = {
        enqueueSetState: function (inst, payload) {
          inst = inst._reactInternals;
          null !== inst.queue && inst.queue.push(payload);
        },
        enqueueReplaceState: function (inst, payload) {
          inst = inst._reactInternals;
          inst.replace = !0;
          inst.queue = [payload];
        },
        enqueueForceUpdate: function () {},
      },
      emptyTreeContext = {
        id: 1,
        overflow: "",
      };
    function pushTreeContext(baseContext, totalChildren, index) {
      var baseIdWithLeadingBit = baseContext.id;
      baseContext = baseContext.overflow;
      var baseLength = 32 - clz32(baseIdWithLeadingBit) - 1;
      baseIdWithLeadingBit &= ~(1 << baseLength);
      index += 1;
      var length = 32 - clz32(totalChildren) + baseLength;
      if (30 < length) {
        var numberOfOverflowBits = baseLength - (baseLength % 5);
        length = (baseIdWithLeadingBit & ((1 << numberOfOverflowBits) - 1)).toString(32);
        baseIdWithLeadingBit >>= numberOfOverflowBits;
        baseLength -= numberOfOverflowBits;
        return {
          id:
            (1 << (32 - clz32(totalChildren) + baseLength)) |
            (index << baseLength) |
            baseIdWithLeadingBit,
          overflow: length + baseContext,
        };
      }
      return {
        id: (1 << length) | (index << baseLength) | baseIdWithLeadingBit,
        overflow: baseContext,
      };
    }
    var clz32 = Math.clz32 ? Math.clz32 : clz32Fallback,
      log = Math.log,
      LN2 = Math.LN2;
    function clz32Fallback(x) {
      x >>>= 0;
      return 0 === x ? 32 : (31 - ((log(x) / LN2) | 0)) | 0;
    }
    function noop() {}
    var SuspenseException = Error(formatProdErrorMessage(460));
    function trackUsedThenable(thenableState, thenable, index) {
      index = thenableState[index];
      void 0 === index
        ? thenableState.push(thenable)
        : index !== thenable && (thenable.then(noop, noop), (thenable = index));
      switch (thenable.status) {
        case "fulfilled":
          return thenable.value;
        case "rejected":
          throw thenable.reason;
        default:
          "string" === typeof thenable.status
            ? thenable.then(noop, noop)
            : ((thenableState = thenable),
              (thenableState.status = "pending"),
              thenableState.then(
                function (fulfilledValue) {
                  if ("pending" === thenable.status) {
                    var fulfilledThenable = thenable;
                    fulfilledThenable.status = "fulfilled";
                    fulfilledThenable.value = fulfilledValue;
                  }
                },
                function (error) {
                  if ("pending" === thenable.status) {
                    var rejectedThenable = thenable;
                    rejectedThenable.status = "rejected";
                    rejectedThenable.reason = error;
                  }
                },
              ));
          switch (thenable.status) {
            case "fulfilled":
              return thenable.value;
            case "rejected":
              throw thenable.reason;
          }
          suspendedThenable = thenable;
          throw SuspenseException;
      }
    }
    var suspendedThenable = null;
    function getSuspendedThenable() {
      if (null === suspendedThenable) throw Error(formatProdErrorMessage(459));
      var thenable = suspendedThenable;
      suspendedThenable = null;
      return thenable;
    }
    function is(x, y) {
      return (x === y && (0 !== x || 1 / x === 1 / y)) || (x !== x && y !== y);
    }
    var objectIs = "function" === typeof Object.is ? Object.is : is,
      currentlyRenderingComponent = null,
      currentlyRenderingTask = null,
      currentlyRenderingRequest = null,
      currentlyRenderingKeyPath = null,
      firstWorkInProgressHook = null,
      workInProgressHook = null,
      isReRender = !1,
      didScheduleRenderPhaseUpdate = !1,
      localIdCounter = 0,
      actionStateCounter = 0,
      actionStateMatchingIndex = -1,
      thenableIndexCounter = 0,
      thenableState = null,
      renderPhaseUpdates = null,
      numberOfReRenders = 0;
    function resolveCurrentlyRenderingComponent() {
      if (null === currentlyRenderingComponent) throw Error(formatProdErrorMessage(321));
      return currentlyRenderingComponent;
    }
    function createHook() {
      if (0 < numberOfReRenders) throw Error(formatProdErrorMessage(312));
      return {
        memoizedState: null,
        queue: null,
        next: null,
      };
    }
    function createWorkInProgressHook() {
      null === workInProgressHook
        ? null === firstWorkInProgressHook
          ? ((isReRender = !1), (firstWorkInProgressHook = workInProgressHook = createHook()))
          : ((isReRender = !0), (workInProgressHook = firstWorkInProgressHook))
        : null === workInProgressHook.next
          ? ((isReRender = !1), (workInProgressHook = workInProgressHook.next = createHook()))
          : ((isReRender = !0), (workInProgressHook = workInProgressHook.next));
      return workInProgressHook;
    }
    function getThenableStateAfterSuspending() {
      var state = thenableState;
      thenableState = null;
      return state;
    }
    function resetHooksState() {
      currentlyRenderingKeyPath =
        currentlyRenderingRequest =
        currentlyRenderingTask =
        currentlyRenderingComponent =
          null;
      didScheduleRenderPhaseUpdate = !1;
      firstWorkInProgressHook = null;
      numberOfReRenders = 0;
      workInProgressHook = renderPhaseUpdates = null;
    }
    function basicStateReducer(state, action) {
      return "function" === typeof action ? action(state) : action;
    }
    function useReducer(reducer, initialArg, init) {
      currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
      workInProgressHook = createWorkInProgressHook();
      if (isReRender) {
        var queue = workInProgressHook.queue;
        initialArg = queue.dispatch;
        if (
          null !== renderPhaseUpdates &&
          ((init = renderPhaseUpdates.get(queue)), void 0 !== init)
        ) {
          renderPhaseUpdates.delete(queue);
          queue = workInProgressHook.memoizedState;
          do ((queue = reducer(queue, init.action)), (init = init.next));
          while (null !== init);
          workInProgressHook.memoizedState = queue;
          return [queue, initialArg];
        }
        return [workInProgressHook.memoizedState, initialArg];
      }
      reducer =
        reducer === basicStateReducer
          ? "function" === typeof initialArg
            ? initialArg()
            : initialArg
          : void 0 !== init
            ? init(initialArg)
            : initialArg;
      workInProgressHook.memoizedState = reducer;
      reducer = workInProgressHook.queue = {
        last: null,
        dispatch: null,
      };
      reducer = reducer.dispatch = dispatchAction.bind(null, currentlyRenderingComponent, reducer);
      return [workInProgressHook.memoizedState, reducer];
    }
    function useMemo(nextCreate, deps) {
      currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
      workInProgressHook = createWorkInProgressHook();
      deps = void 0 === deps ? null : deps;
      if (null !== workInProgressHook) {
        var prevState = workInProgressHook.memoizedState;
        if (null !== prevState && null !== deps) {
          var prevDeps = prevState[1];
          a: if (null === prevDeps) prevDeps = !1;
          else {
            for (var i = 0; i < prevDeps.length && i < deps.length; i++)
              if (!objectIs(deps[i], prevDeps[i])) {
                prevDeps = !1;
                break a;
              }
            prevDeps = !0;
          }
          if (prevDeps) return prevState[0];
        }
      }
      nextCreate = nextCreate();
      workInProgressHook.memoizedState = [nextCreate, deps];
      return nextCreate;
    }
    function dispatchAction(componentIdentity, queue, action) {
      if (25 <= numberOfReRenders) throw Error(formatProdErrorMessage(301));
      if (componentIdentity === currentlyRenderingComponent)
        if (
          ((didScheduleRenderPhaseUpdate = !0),
          (componentIdentity = {
            action,
            next: null,
          }),
          null === renderPhaseUpdates && (renderPhaseUpdates = /* @__PURE__ */ new Map()),
          (action = renderPhaseUpdates.get(queue)),
          void 0 === action)
        )
          renderPhaseUpdates.set(queue, componentIdentity);
        else {
          for (queue = action; null !== queue.next; ) queue = queue.next;
          queue.next = componentIdentity;
        }
    }
    function throwOnUseEffectEventCall() {
      throw Error(formatProdErrorMessage(440));
    }
    function unsupportedStartTransition() {
      throw Error(formatProdErrorMessage(394));
    }
    function unsupportedSetOptimisticState() {
      throw Error(formatProdErrorMessage(479));
    }
    function useActionState(action, initialState, permalink) {
      resolveCurrentlyRenderingComponent();
      var actionStateHookIndex = actionStateCounter++,
        request = currentlyRenderingRequest;
      if ("function" === typeof action.$$FORM_ACTION) {
        var nextPostbackStateKey = null,
          componentKeyPath = currentlyRenderingKeyPath;
        request = request.formState;
        var isSignatureEqual = action.$$IS_SIGNATURE_EQUAL;
        if (null !== request && "function" === typeof isSignatureEqual) {
          var postbackKey = request[1];
          isSignatureEqual.call(action, request[2], request[3]) &&
            ((nextPostbackStateKey =
              void 0 !== permalink
                ? "p" + permalink
                : "k" +
                  murmurhash3_32_gc(
                    JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                    0,
                  )),
            postbackKey === nextPostbackStateKey &&
              ((actionStateMatchingIndex = actionStateHookIndex), (initialState = request[0])));
        }
        var boundAction = action.bind(null, initialState);
        action = function (payload) {
          boundAction(payload);
        };
        "function" === typeof boundAction.$$FORM_ACTION &&
          (action.$$FORM_ACTION = function (prefix) {
            prefix = boundAction.$$FORM_ACTION(prefix);
            void 0 !== permalink && ((permalink += ""), (prefix.action = permalink));
            var formData = prefix.data;
            formData &&
              (null === nextPostbackStateKey &&
                (nextPostbackStateKey =
                  void 0 !== permalink
                    ? "p" + permalink
                    : "k" +
                      murmurhash3_32_gc(
                        JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                        0,
                      )),
              formData.append("$ACTION_KEY", nextPostbackStateKey));
            return prefix;
          });
        return [initialState, action, !1];
      }
      var boundAction$22 = action.bind(null, initialState);
      return [
        initialState,
        function (payload) {
          boundAction$22(payload);
        },
        !1,
      ];
    }
    function unwrapThenable(thenable) {
      var index = thenableIndexCounter;
      thenableIndexCounter += 1;
      null === thenableState && (thenableState = []);
      return trackUsedThenable(thenableState, thenable, index);
    }
    function unsupportedRefresh() {
      throw Error(formatProdErrorMessage(393));
    }
    var HooksDispatcher = {
        readContext: function (context) {
          return context._currentValue2;
        },
        use: function (usable) {
          if (null !== usable && "object" === typeof usable) {
            if ("function" === typeof usable.then) return unwrapThenable(usable);
            if (usable.$$typeof === REACT_CONTEXT_TYPE) return usable._currentValue2;
          }
          throw Error(formatProdErrorMessage(438, String(usable)));
        },
        useContext: function (context) {
          resolveCurrentlyRenderingComponent();
          return context._currentValue2;
        },
        useMemo,
        useReducer,
        useRef: function (initialValue) {
          currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
          workInProgressHook = createWorkInProgressHook();
          var previousRef = workInProgressHook.memoizedState;
          return null === previousRef
            ? ((initialValue = { current: initialValue }),
              (workInProgressHook.memoizedState = initialValue))
            : previousRef;
        },
        useState: function (initialState) {
          return useReducer(basicStateReducer, initialState);
        },
        useInsertionEffect: noop,
        useLayoutEffect: noop,
        useCallback: function (callback, deps) {
          return useMemo(function () {
            return callback;
          }, deps);
        },
        useImperativeHandle: noop,
        useEffect: noop,
        useDebugValue: noop,
        useDeferredValue: function (value, initialValue) {
          resolveCurrentlyRenderingComponent();
          return void 0 !== initialValue ? initialValue : value;
        },
        useTransition: function () {
          resolveCurrentlyRenderingComponent();
          return [!1, unsupportedStartTransition];
        },
        useId: function () {
          var JSCompiler_inline_result = currentlyRenderingTask.treeContext;
          var overflow = JSCompiler_inline_result.overflow;
          JSCompiler_inline_result = JSCompiler_inline_result.id;
          JSCompiler_inline_result =
            (
              JSCompiler_inline_result & ~(1 << (32 - clz32(JSCompiler_inline_result) - 1))
            ).toString(32) + overflow;
          var resumableState = currentResumableState;
          if (null === resumableState) throw Error(formatProdErrorMessage(404));
          overflow = localIdCounter++;
          JSCompiler_inline_result =
            "_" + resumableState.idPrefix + "R_" + JSCompiler_inline_result;
          0 < overflow && (JSCompiler_inline_result += "H" + overflow.toString(32));
          return JSCompiler_inline_result + "_";
        },
        useSyncExternalStore: function (subscribe, getSnapshot, getServerSnapshot) {
          if (void 0 === getServerSnapshot) throw Error(formatProdErrorMessage(407));
          return getServerSnapshot();
        },
        useOptimistic: function (passthrough) {
          resolveCurrentlyRenderingComponent();
          return [passthrough, unsupportedSetOptimisticState];
        },
        useActionState,
        useFormState: useActionState,
        useHostTransitionStatus: function () {
          resolveCurrentlyRenderingComponent();
          return sharedNotPendingObject;
        },
        useMemoCache: function (size) {
          for (var data = Array(size), i = 0; i < size; i++) data[i] = REACT_MEMO_CACHE_SENTINEL;
          return data;
        },
        useCacheRefresh: function () {
          return unsupportedRefresh;
        },
        useEffectEvent: function () {
          return throwOnUseEffectEventCall;
        },
      },
      currentResumableState = null,
      DefaultAsyncDispatcher = {
        getCacheForType: function () {
          throw Error(formatProdErrorMessage(248));
        },
        cacheSignal: function () {
          throw Error(formatProdErrorMessage(248));
        },
      },
      prefix,
      suffix;
    function describeBuiltInComponentFrame(name) {
      if (void 0 === prefix)
        try {
          throw Error();
        } catch (x) {
          var match = x.stack.trim().match(/\n( *(at )?)/);
          prefix = (match && match[1]) || "";
          suffix =
            -1 < x.stack.indexOf("\n    at")
              ? " (<anonymous>)"
              : -1 < x.stack.indexOf("@")
                ? "@unknown:0:0"
                : "";
        }
      return "\n" + prefix + name + suffix;
    }
    var reentry = !1;
    function describeNativeComponentFrame(fn, construct) {
      if (!fn || reentry) return "";
      reentry = !0;
      var previousPrepareStackTrace = Error.prepareStackTrace;
      Error.prepareStackTrace = void 0;
      try {
        var RunInRootFrame = {
          DetermineComponentFrameRoot: function () {
            try {
              if (construct) {
                var Fake = function () {
                  throw Error();
                };
                Object.defineProperty(Fake.prototype, "props", {
                  set: function () {
                    throw Error();
                  },
                });
                if ("object" === typeof Reflect && Reflect.construct) {
                  try {
                    Reflect.construct(Fake, []);
                  } catch (x) {
                    var control = x;
                  }
                  Reflect.construct(fn, [], Fake);
                } else {
                  try {
                    Fake.call();
                  } catch (x$24) {
                    control = x$24;
                  }
                  fn.call(Fake.prototype);
                }
              } else {
                try {
                  throw Error();
                } catch (x$25) {
                  control = x$25;
                }
                (Fake = fn()) && "function" === typeof Fake.catch && Fake.catch(function () {});
              }
            } catch (sample) {
              if (sample && control && "string" === typeof sample.stack)
                return [sample.stack, control.stack];
            }
            return [null, null];
          },
        };
        RunInRootFrame.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
        var namePropDescriptor = Object.getOwnPropertyDescriptor(
          RunInRootFrame.DetermineComponentFrameRoot,
          "name",
        );
        namePropDescriptor &&
          namePropDescriptor.configurable &&
          Object.defineProperty(RunInRootFrame.DetermineComponentFrameRoot, "name", {
            value: "DetermineComponentFrameRoot",
          });
        var _RunInRootFrame$Deter = RunInRootFrame.DetermineComponentFrameRoot(),
          sampleStack = _RunInRootFrame$Deter[0],
          controlStack = _RunInRootFrame$Deter[1];
        if (sampleStack && controlStack) {
          var sampleLines = sampleStack.split("\n"),
            controlLines = controlStack.split("\n");
          for (
            namePropDescriptor = RunInRootFrame = 0;
            RunInRootFrame < sampleLines.length &&
            !sampleLines[RunInRootFrame].includes("DetermineComponentFrameRoot");
          )
            RunInRootFrame++;
          for (
            ;
            namePropDescriptor < controlLines.length &&
            !controlLines[namePropDescriptor].includes("DetermineComponentFrameRoot");
          )
            namePropDescriptor++;
          if (RunInRootFrame === sampleLines.length || namePropDescriptor === controlLines.length)
            for (
              RunInRootFrame = sampleLines.length - 1, namePropDescriptor = controlLines.length - 1;
              1 <= RunInRootFrame &&
              0 <= namePropDescriptor &&
              sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor];
            )
              namePropDescriptor--;
          for (
            ;
            1 <= RunInRootFrame && 0 <= namePropDescriptor;
            RunInRootFrame--, namePropDescriptor--
          )
            if (sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor]) {
              if (1 !== RunInRootFrame || 1 !== namePropDescriptor)
                do
                  if (
                    (RunInRootFrame--,
                    namePropDescriptor--,
                    0 > namePropDescriptor ||
                      sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor])
                  ) {
                    var frame = "\n" + sampleLines[RunInRootFrame].replace(" at new ", " at ");
                    fn.displayName &&
                      frame.includes("<anonymous>") &&
                      (frame = frame.replace("<anonymous>", fn.displayName));
                    return frame;
                  }
                while (1 <= RunInRootFrame && 0 <= namePropDescriptor);
              break;
            }
        }
      } finally {
        ((reentry = !1), (Error.prepareStackTrace = previousPrepareStackTrace));
      }
      return (previousPrepareStackTrace = fn ? fn.displayName || fn.name : "")
        ? describeBuiltInComponentFrame(previousPrepareStackTrace)
        : "";
    }
    function describeComponentStackByType(type) {
      if ("string" === typeof type) return describeBuiltInComponentFrame(type);
      if ("function" === typeof type)
        return type.prototype && type.prototype.isReactComponent
          ? describeNativeComponentFrame(type, !0)
          : describeNativeComponentFrame(type, !1);
      if ("object" === typeof type && null !== type) {
        switch (type.$$typeof) {
          case REACT_FORWARD_REF_TYPE:
            return describeNativeComponentFrame(type.render, !1);
          case REACT_MEMO_TYPE:
            return describeNativeComponentFrame(type.type, !1);
          case REACT_LAZY_TYPE:
            var lazyComponent = type,
              payload = lazyComponent._payload;
            lazyComponent = lazyComponent._init;
            try {
              type = lazyComponent(payload);
            } catch (x) {
              return describeBuiltInComponentFrame("Lazy");
            }
            return describeComponentStackByType(type);
        }
        if ("string" === typeof type.name) {
          a: {
            payload = type.name;
            lazyComponent = type.env;
            var location = type.debugLocation;
            if (
              null != location &&
              ((type = Error.prepareStackTrace),
              (Error.prepareStackTrace = void 0),
              (location = location.stack),
              (Error.prepareStackTrace = type),
              location.startsWith("Error: react-stack-top-frame\n") &&
                (location = location.slice(29)),
              (type = location.indexOf("\n")),
              -1 !== type && (location = location.slice(type + 1)),
              (type = location.indexOf("react_stack_bottom_frame")),
              -1 !== type && (type = location.lastIndexOf("\n", type)),
              (type = -1 !== type ? (location = location.slice(0, type)) : ""),
              (location = type.lastIndexOf("\n")),
              (type = -1 === location ? type : type.slice(location + 1)),
              -1 !== type.indexOf(payload))
            ) {
              payload = "\n" + type;
              break a;
            }
            payload = describeBuiltInComponentFrame(
              payload + (lazyComponent ? " [" + lazyComponent + "]" : ""),
            );
          }
          return payload;
        }
      }
      switch (type) {
        case REACT_SUSPENSE_LIST_TYPE:
          return describeBuiltInComponentFrame("SuspenseList");
        case REACT_SUSPENSE_TYPE:
          return describeBuiltInComponentFrame("Suspense");
      }
      return "";
    }
    function isEligibleForOutlining(request, boundary) {
      return (500 < boundary.byteSize || !1) && null === boundary.contentPreamble;
    }
    function defaultErrorHandler(error) {
      if (
        "object" === typeof error &&
        null !== error &&
        "string" === typeof error.environmentName
      ) {
        var JSCompiler_inline_result = error.environmentName;
        error = [error].slice(0);
        "string" === typeof error[0]
          ? error.splice(0, 1, "[%s] " + error[0], " " + JSCompiler_inline_result + " ")
          : error.splice(0, 0, "[%s]", " " + JSCompiler_inline_result + " ");
        error.unshift(console);
        JSCompiler_inline_result = bind.apply(console.error, error);
        JSCompiler_inline_result();
      } else console.error(error);
      return null;
    }
    function RequestInstance(
      resumableState,
      renderState,
      rootFormatContext,
      progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      formState,
    ) {
      var abortSet = /* @__PURE__ */ new Set();
      this.destination = null;
      this.flushScheduled = !1;
      this.resumableState = resumableState;
      this.renderState = renderState;
      this.rootFormatContext = rootFormatContext;
      this.progressiveChunkSize = void 0 === progressiveChunkSize ? 12800 : progressiveChunkSize;
      this.status = 10;
      this.fatalError = null;
      this.pendingRootTasks = this.allPendingTasks = this.nextSegmentId = 0;
      this.completedPreambleSegments = this.completedRootSegment = null;
      this.byteSize = 0;
      this.abortableTasks = abortSet;
      this.pingedTasks = [];
      this.clientRenderedBoundaries = [];
      this.completedBoundaries = [];
      this.partialBoundaries = [];
      this.trackedPostpones = null;
      this.onError = void 0 === onError ? defaultErrorHandler : onError;
      this.onPostpone = void 0 === onPostpone ? noop : onPostpone;
      this.onAllReady = void 0 === onAllReady ? noop : onAllReady;
      this.onShellReady = void 0 === onShellReady ? noop : onShellReady;
      this.onShellError = void 0 === onShellError ? noop : onShellError;
      this.onFatalError = void 0 === onFatalError ? noop : onFatalError;
      this.formState = void 0 === formState ? null : formState;
    }
    function createRequest(
      children,
      resumableState,
      renderState,
      rootFormatContext,
      progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      formState,
    ) {
      resumableState = new RequestInstance(
        resumableState,
        renderState,
        rootFormatContext,
        progressiveChunkSize,
        onError,
        onAllReady,
        onShellReady,
        onShellError,
        onFatalError,
        onPostpone,
        formState,
      );
      renderState = createPendingSegment(resumableState, 0, null, rootFormatContext, !1, !1);
      renderState.parentFlushed = !0;
      children = createRenderTask(
        resumableState,
        null,
        children,
        -1,
        null,
        renderState,
        null,
        null,
        resumableState.abortableTasks,
        null,
        rootFormatContext,
        null,
        emptyTreeContext,
        null,
        null,
      );
      pushComponentStack(children);
      resumableState.pingedTasks.push(children);
      return resumableState;
    }
    var currentRequest = null;
    function pingTask(request, task) {
      request.pingedTasks.push(task);
      1 === request.pingedTasks.length &&
        ((request.flushScheduled = null !== request.destination), performWork(request));
    }
    function createSuspenseBoundary(
      request,
      row,
      fallbackAbortableTasks,
      contentPreamble,
      fallbackPreamble,
    ) {
      fallbackAbortableTasks = {
        status: 0,
        rootSegmentID: -1,
        parentFlushed: !1,
        pendingTasks: 0,
        row,
        completedSegments: [],
        byteSize: 0,
        fallbackAbortableTasks,
        errorDigest: null,
        contentState: createHoistableState(),
        fallbackState: createHoistableState(),
        contentPreamble,
        fallbackPreamble,
        trackedContentKeyPath: null,
        trackedFallbackNode: null,
      };
      null !== row &&
        (row.pendingTasks++,
        (contentPreamble = row.boundaries),
        null !== contentPreamble &&
          (request.allPendingTasks++,
          fallbackAbortableTasks.pendingTasks++,
          contentPreamble.push(fallbackAbortableTasks)),
        (request = row.inheritedHoistables),
        null !== request && hoistHoistables(fallbackAbortableTasks.contentState, request));
      return fallbackAbortableTasks;
    }
    function createRenderTask(
      request,
      thenableState,
      node,
      childIndex,
      blockedBoundary,
      blockedSegment,
      blockedPreamble,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
    ) {
      request.allPendingTasks++;
      null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
      null !== row && row.pendingTasks++;
      var task = {
        replay: null,
        node,
        childIndex,
        ping: function () {
          return pingTask(request, task);
        },
        blockedBoundary,
        blockedSegment,
        blockedPreamble,
        hoistableState,
        abortSet,
        keyPath,
        formatContext,
        context,
        treeContext,
        row,
        componentStack,
        thenableState,
      };
      abortSet.add(task);
      return task;
    }
    function createReplayTask(
      request,
      thenableState,
      replay,
      node,
      childIndex,
      blockedBoundary,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
    ) {
      request.allPendingTasks++;
      null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
      null !== row && row.pendingTasks++;
      replay.pendingTasks++;
      var task = {
        replay,
        node,
        childIndex,
        ping: function () {
          return pingTask(request, task);
        },
        blockedBoundary,
        blockedSegment: null,
        blockedPreamble: null,
        hoistableState,
        abortSet,
        keyPath,
        formatContext,
        context,
        treeContext,
        row,
        componentStack,
        thenableState,
      };
      abortSet.add(task);
      return task;
    }
    function createPendingSegment(
      request,
      index,
      boundary,
      parentFormatContext,
      lastPushedText,
      textEmbedded,
    ) {
      return {
        status: 0,
        parentFlushed: !1,
        id: -1,
        index,
        chunks: [],
        children: [],
        preambleChildren: [],
        parentFormatContext,
        boundary,
        lastPushedText,
        textEmbedded,
      };
    }
    function pushComponentStack(task) {
      var node = task.node;
      if ("object" === typeof node && null !== node)
        switch (node.$$typeof) {
          case REACT_ELEMENT_TYPE:
            task.componentStack = {
              parent: task.componentStack,
              type: node.type,
            };
        }
    }
    function replaceSuspenseComponentStackWithSuspenseFallbackStack(componentStack) {
      return null === componentStack
        ? null
        : {
            parent: componentStack.parent,
            type: "Suspense Fallback",
          };
    }
    function getThrownInfo(node$jscomp$0) {
      var errorInfo = {};
      node$jscomp$0 &&
        Object.defineProperty(errorInfo, "componentStack", {
          configurable: !0,
          enumerable: !0,
          get: function () {
            try {
              var info = "",
                node = node$jscomp$0;
              do ((info += describeComponentStackByType(node.type)), (node = node.parent));
              while (node);
              var JSCompiler_inline_result = info;
            } catch (x) {
              JSCompiler_inline_result = "\nError generating stack: " + x.message + "\n" + x.stack;
            }
            Object.defineProperty(errorInfo, "componentStack", { value: JSCompiler_inline_result });
            return JSCompiler_inline_result;
          },
        });
      return errorInfo;
    }
    function logRecoverableError(request, error, errorInfo) {
      request = request.onError;
      error = request(error, errorInfo);
      if (null == error || "string" === typeof error) return error;
    }
    function fatalError(request, error) {
      var onShellError = request.onShellError,
        onFatalError = request.onFatalError;
      onShellError(error);
      onFatalError(error);
      null !== request.destination
        ? ((request.status = 14), request.destination.destroy(error))
        : ((request.status = 13), (request.fatalError = error));
    }
    function finishSuspenseListRow(request, row) {
      unblockSuspenseListRow(request, row.next, row.hoistables);
    }
    function unblockSuspenseListRow(request, unblockedRow, inheritedHoistables) {
      for (; null !== unblockedRow; ) {
        null !== inheritedHoistables &&
          (hoistHoistables(unblockedRow.hoistables, inheritedHoistables),
          (unblockedRow.inheritedHoistables = inheritedHoistables));
        var unblockedBoundaries = unblockedRow.boundaries;
        if (null !== unblockedBoundaries) {
          unblockedRow.boundaries = null;
          for (var i = 0; i < unblockedBoundaries.length; i++) {
            var unblockedBoundary = unblockedBoundaries[i];
            null !== inheritedHoistables &&
              hoistHoistables(unblockedBoundary.contentState, inheritedHoistables);
            finishedTask(request, unblockedBoundary, null, null);
          }
        }
        unblockedRow.pendingTasks--;
        if (0 < unblockedRow.pendingTasks) break;
        inheritedHoistables = unblockedRow.hoistables;
        unblockedRow = unblockedRow.next;
      }
    }
    function tryToResolveTogetherRow(request, togetherRow) {
      var boundaries = togetherRow.boundaries;
      if (null !== boundaries && togetherRow.pendingTasks === boundaries.length) {
        for (var allCompleteAndInlinable = !0, i = 0; i < boundaries.length; i++) {
          var rowBoundary = boundaries[i];
          if (
            1 !== rowBoundary.pendingTasks ||
            rowBoundary.parentFlushed ||
            isEligibleForOutlining(request, rowBoundary)
          ) {
            allCompleteAndInlinable = !1;
            break;
          }
        }
        allCompleteAndInlinable &&
          unblockSuspenseListRow(request, togetherRow, togetherRow.hoistables);
      }
    }
    function createSuspenseListRow(previousRow) {
      var newRow = {
        pendingTasks: 1,
        boundaries: null,
        hoistables: createHoistableState(),
        inheritedHoistables: null,
        together: !1,
        next: null,
      };
      null !== previousRow &&
        0 < previousRow.pendingTasks &&
        (newRow.pendingTasks++, (newRow.boundaries = []), (previousRow.next = newRow));
      return newRow;
    }
    function renderSuspenseListRows(request, task, keyPath, rows, revealOrder) {
      var prevKeyPath = task.keyPath,
        prevTreeContext = task.treeContext,
        prevRow = task.row;
      task.keyPath = keyPath;
      keyPath = rows.length;
      var previousSuspenseListRow = null;
      if (null !== task.replay) {
        var resumeSlots = task.replay.slots;
        if (null !== resumeSlots && "object" === typeof resumeSlots)
          for (var n = 0; n < keyPath; n++) {
            var i =
                "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
                  ? n
                  : keyPath - 1 - n,
              node = rows[i];
            task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
            task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
            var resumeSegmentID = resumeSlots[i];
            "number" === typeof resumeSegmentID
              ? (resumeNode(request, task, resumeSegmentID, node, i), delete resumeSlots[i])
              : renderNode(request, task, node, i);
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow);
          }
        else
          for (resumeSlots = 0; resumeSlots < keyPath; resumeSlots++)
            ((n =
              "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
                ? resumeSlots
                : keyPath - 1 - resumeSlots),
              (i = rows[n]),
              (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
              (task.treeContext = pushTreeContext(prevTreeContext, keyPath, n)),
              renderNode(request, task, i, n),
              0 === --previousSuspenseListRow.pendingTasks &&
                finishSuspenseListRow(request, previousSuspenseListRow));
      } else if ("backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder)
        for (revealOrder = 0; revealOrder < keyPath; revealOrder++)
          ((resumeSlots = rows[revealOrder]),
            (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
            (task.treeContext = pushTreeContext(prevTreeContext, keyPath, revealOrder)),
            renderNode(request, task, resumeSlots, revealOrder),
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow));
      else {
        revealOrder = task.blockedSegment;
        resumeSlots = revealOrder.children.length;
        n = revealOrder.chunks.length;
        for (i = keyPath - 1; 0 <= i; i--) {
          node = rows[i];
          task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
          task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
          resumeSegmentID = createPendingSegment(
            request,
            n,
            null,
            task.formatContext,
            0 === i ? revealOrder.lastPushedText : !0,
            !0,
          );
          revealOrder.children.splice(resumeSlots, 0, resumeSegmentID);
          task.blockedSegment = resumeSegmentID;
          try {
            (renderNode(request, task, node, i),
              pushSegmentFinale(
                resumeSegmentID.chunks,
                request.renderState,
                resumeSegmentID.lastPushedText,
                resumeSegmentID.textEmbedded,
              ),
              (resumeSegmentID.status = 1),
              0 === --previousSuspenseListRow.pendingTasks &&
                finishSuspenseListRow(request, previousSuspenseListRow));
          } catch (thrownValue) {
            throw ((resumeSegmentID.status = 12 === request.status ? 3 : 4), thrownValue);
          }
        }
        task.blockedSegment = revealOrder;
        revealOrder.lastPushedText = !1;
      }
      null !== prevRow &&
        null !== previousSuspenseListRow &&
        0 < previousSuspenseListRow.pendingTasks &&
        (prevRow.pendingTasks++, (previousSuspenseListRow.next = prevRow));
      task.treeContext = prevTreeContext;
      task.row = prevRow;
      task.keyPath = prevKeyPath;
    }
    function renderWithHooks(request, task, keyPath, Component, props, secondArg) {
      var prevThenableState = task.thenableState;
      task.thenableState = null;
      currentlyRenderingComponent = {};
      currentlyRenderingTask = task;
      currentlyRenderingRequest = request;
      currentlyRenderingKeyPath = keyPath;
      actionStateCounter = localIdCounter = 0;
      actionStateMatchingIndex = -1;
      thenableIndexCounter = 0;
      thenableState = prevThenableState;
      for (request = Component(props, secondArg); didScheduleRenderPhaseUpdate; )
        ((didScheduleRenderPhaseUpdate = !1),
          (actionStateCounter = localIdCounter = 0),
          (actionStateMatchingIndex = -1),
          (thenableIndexCounter = 0),
          (numberOfReRenders += 1),
          (workInProgressHook = null),
          (request = Component(props, secondArg)));
      resetHooksState();
      return request;
    }
    function finishFunctionComponent(
      request,
      task,
      keyPath,
      children,
      hasId,
      actionStateCount,
      actionStateMatchingIndex,
    ) {
      var didEmitActionStateMarkers = !1;
      if (0 !== actionStateCount && null !== request.formState) {
        var segment = task.blockedSegment;
        if (null !== segment) {
          didEmitActionStateMarkers = !0;
          segment = segment.chunks;
          for (var i = 0; i < actionStateCount; i++)
            i === actionStateMatchingIndex ? segment.push("<!--F!-->") : segment.push("<!--F-->");
        }
      }
      actionStateCount = task.keyPath;
      task.keyPath = keyPath;
      hasId
        ? ((keyPath = task.treeContext),
          (task.treeContext = pushTreeContext(keyPath, 1, 0)),
          renderNode(request, task, children, -1),
          (task.treeContext = keyPath))
        : didEmitActionStateMarkers
          ? renderNode(request, task, children, -1)
          : renderNodeDestructive(request, task, children, -1);
      task.keyPath = actionStateCount;
    }
    function renderElement(request, task, keyPath, type, props, ref) {
      if ("function" === typeof type)
        if (type.prototype && type.prototype.isReactComponent) {
          var newProps = props;
          if ("ref" in props) {
            newProps = {};
            for (var propName in props)
              "ref" !== propName && (newProps[propName] = props[propName]);
          }
          var defaultProps = type.defaultProps;
          if (defaultProps) {
            newProps === props && (newProps = assign({}, newProps, props));
            for (var propName$43 in defaultProps)
              void 0 === newProps[propName$43] &&
                (newProps[propName$43] = defaultProps[propName$43]);
          }
          props = newProps;
          newProps = emptyContextObject;
          defaultProps = type.contextType;
          "object" === typeof defaultProps &&
            null !== defaultProps &&
            (newProps = defaultProps._currentValue2);
          newProps = new type(props, newProps);
          var initialState = void 0 !== newProps.state ? newProps.state : null;
          newProps.updater = classComponentUpdater;
          newProps.props = props;
          newProps.state = initialState;
          defaultProps = {
            queue: [],
            replace: !1,
          };
          newProps._reactInternals = defaultProps;
          ref = type.contextType;
          newProps.context =
            "object" === typeof ref && null !== ref ? ref._currentValue2 : emptyContextObject;
          ref = type.getDerivedStateFromProps;
          "function" === typeof ref &&
            ((ref = ref(props, initialState)),
            (initialState =
              null === ref || void 0 === ref ? initialState : assign({}, initialState, ref)),
            (newProps.state = initialState));
          if (
            "function" !== typeof type.getDerivedStateFromProps &&
            "function" !== typeof newProps.getSnapshotBeforeUpdate &&
            ("function" === typeof newProps.UNSAFE_componentWillMount ||
              "function" === typeof newProps.componentWillMount)
          )
            if (
              ((type = newProps.state),
              "function" === typeof newProps.componentWillMount && newProps.componentWillMount(),
              "function" === typeof newProps.UNSAFE_componentWillMount &&
                newProps.UNSAFE_componentWillMount(),
              type !== newProps.state &&
                classComponentUpdater.enqueueReplaceState(newProps, newProps.state, null),
              null !== defaultProps.queue && 0 < defaultProps.queue.length)
            )
              if (
                ((type = defaultProps.queue),
                (ref = defaultProps.replace),
                (defaultProps.queue = null),
                (defaultProps.replace = !1),
                ref && 1 === type.length)
              )
                newProps.state = type[0];
              else {
                defaultProps = ref ? type[0] : newProps.state;
                initialState = !0;
                for (ref = ref ? 1 : 0; ref < type.length; ref++)
                  ((propName$43 = type[ref]),
                    (propName$43 =
                      "function" === typeof propName$43
                        ? propName$43.call(newProps, defaultProps, props, void 0)
                        : propName$43),
                    null != propName$43 &&
                      (initialState
                        ? ((initialState = !1),
                          (defaultProps = assign({}, defaultProps, propName$43)))
                        : assign(defaultProps, propName$43)));
                newProps.state = defaultProps;
              }
            else defaultProps.queue = null;
          type = newProps.render();
          if (12 === request.status) throw null;
          props = task.keyPath;
          task.keyPath = keyPath;
          renderNodeDestructive(request, task, type, -1);
          task.keyPath = props;
        } else {
          type = renderWithHooks(request, task, keyPath, type, props, void 0);
          if (12 === request.status) throw null;
          finishFunctionComponent(
            request,
            task,
            keyPath,
            type,
            0 !== localIdCounter,
            actionStateCounter,
            actionStateMatchingIndex,
          );
        }
      else if ("string" === typeof type)
        if (((newProps = task.blockedSegment), null === newProps))
          ((newProps = props.children),
            (defaultProps = task.formatContext),
            (initialState = task.keyPath),
            (task.formatContext = getChildFormatContext(defaultProps, type, props)),
            (task.keyPath = keyPath),
            renderNode(request, task, newProps, -1),
            (task.formatContext = defaultProps),
            (task.keyPath = initialState));
        else {
          initialState = pushStartInstance(
            newProps.chunks,
            type,
            props,
            request.resumableState,
            request.renderState,
            task.blockedPreamble,
            task.hoistableState,
            task.formatContext,
            newProps.lastPushedText,
          );
          newProps.lastPushedText = !1;
          defaultProps = task.formatContext;
          ref = task.keyPath;
          task.keyPath = keyPath;
          if (
            3 ===
            (task.formatContext = getChildFormatContext(defaultProps, type, props)).insertionMode
          ) {
            keyPath = createPendingSegment(request, 0, null, task.formatContext, !1, !1);
            newProps.preambleChildren.push(keyPath);
            task.blockedSegment = keyPath;
            try {
              ((keyPath.status = 6),
                renderNode(request, task, initialState, -1),
                pushSegmentFinale(
                  keyPath.chunks,
                  request.renderState,
                  keyPath.lastPushedText,
                  keyPath.textEmbedded,
                ),
                (keyPath.status = 1));
            } finally {
              task.blockedSegment = newProps;
            }
          } else renderNode(request, task, initialState, -1);
          task.formatContext = defaultProps;
          task.keyPath = ref;
          a: {
            task = newProps.chunks;
            request = request.resumableState;
            switch (type) {
              case "title":
              case "style":
              case "script":
              case "area":
              case "base":
              case "br":
              case "col":
              case "embed":
              case "hr":
              case "img":
              case "input":
              case "keygen":
              case "link":
              case "meta":
              case "param":
              case "source":
              case "track":
              case "wbr":
                break a;
              case "body":
                if (1 >= defaultProps.insertionMode) {
                  request.hasBody = !0;
                  break a;
                }
                break;
              case "html":
                if (0 === defaultProps.insertionMode) {
                  request.hasHtml = !0;
                  break a;
                }
                break;
              case "head":
                if (1 >= defaultProps.insertionMode) break a;
            }
            task.push(endChunkForTag(type));
          }
          newProps.lastPushedText = !1;
        }
      else {
        switch (type) {
          case REACT_LEGACY_HIDDEN_TYPE:
          case REACT_STRICT_MODE_TYPE:
          case REACT_PROFILER_TYPE:
          case REACT_FRAGMENT_TYPE:
            type = task.keyPath;
            task.keyPath = keyPath;
            renderNodeDestructive(request, task, props.children, -1);
            task.keyPath = type;
            return;
          case REACT_ACTIVITY_TYPE:
            type = task.blockedSegment;
            null === type
              ? "hidden" !== props.mode &&
                ((type = task.keyPath),
                (task.keyPath = keyPath),
                renderNode(request, task, props.children, -1),
                (task.keyPath = type))
              : "hidden" !== props.mode &&
                (request.renderState.generateStaticMarkup || type.chunks.push("<!--&-->"),
                (type.lastPushedText = !1),
                (newProps = task.keyPath),
                (task.keyPath = keyPath),
                renderNode(request, task, props.children, -1),
                (task.keyPath = newProps),
                request.renderState.generateStaticMarkup || type.chunks.push("<!--/&-->"),
                (type.lastPushedText = !1));
            return;
          case REACT_SUSPENSE_LIST_TYPE:
            a: {
              type = props.children;
              props = props.revealOrder;
              if (
                "forwards" === props ||
                "backwards" === props ||
                "unstable_legacy-backwards" === props
              ) {
                if (isArrayImpl(type)) {
                  renderSuspenseListRows(request, task, keyPath, type, props);
                  break a;
                }
                if ((newProps = getIteratorFn(type))) {
                  if ((newProps = newProps.call(type))) {
                    defaultProps = newProps.next();
                    if (!defaultProps.done) {
                      do defaultProps = newProps.next();
                      while (!defaultProps.done);
                      renderSuspenseListRows(request, task, keyPath, type, props);
                    }
                    break a;
                  }
                }
              }
              "together" === props
                ? ((props = task.keyPath),
                  (newProps = task.row),
                  (defaultProps = task.row = createSuspenseListRow(null)),
                  (defaultProps.boundaries = []),
                  (defaultProps.together = !0),
                  (task.keyPath = keyPath),
                  renderNodeDestructive(request, task, type, -1),
                  0 === --defaultProps.pendingTasks && finishSuspenseListRow(request, defaultProps),
                  (task.keyPath = props),
                  (task.row = newProps),
                  null !== newProps &&
                    0 < defaultProps.pendingTasks &&
                    (newProps.pendingTasks++, (defaultProps.next = newProps)))
                : ((props = task.keyPath),
                  (task.keyPath = keyPath),
                  renderNodeDestructive(request, task, type, -1),
                  (task.keyPath = props));
            }
            return;
          case REACT_VIEW_TRANSITION_TYPE:
          case REACT_SCOPE_TYPE:
            throw Error(formatProdErrorMessage(343));
          case REACT_SUSPENSE_TYPE:
            a: if (null !== task.replay) {
              type = task.keyPath;
              newProps = task.formatContext;
              defaultProps = task.row;
              task.keyPath = keyPath;
              task.formatContext = getSuspenseContentFormatContext(
                request.resumableState,
                newProps,
              );
              task.row = null;
              keyPath = props.children;
              try {
                renderNode(request, task, keyPath, -1);
              } finally {
                ((task.keyPath = type), (task.formatContext = newProps), (task.row = defaultProps));
              }
            } else {
              type = task.keyPath;
              ref = task.formatContext;
              var prevRow = task.row,
                parentBoundary = task.blockedBoundary;
              propName$43 = task.blockedPreamble;
              var parentHoistableState = task.hoistableState;
              propName = task.blockedSegment;
              var fallback = props.fallback;
              props = props.children;
              var fallbackAbortSet = /* @__PURE__ */ new Set();
              var newBoundary = createSuspenseBoundary(
                request,
                task.row,
                fallbackAbortSet,
                null,
                null,
              );
              null !== request.trackedPostpones && (newBoundary.trackedContentKeyPath = keyPath);
              var boundarySegment = createPendingSegment(
                request,
                propName.chunks.length,
                newBoundary,
                task.formatContext,
                !1,
                !1,
              );
              propName.children.push(boundarySegment);
              propName.lastPushedText = !1;
              var contentRootSegment = createPendingSegment(
                request,
                0,
                null,
                task.formatContext,
                !1,
                !1,
              );
              contentRootSegment.parentFlushed = !0;
              if (null !== request.trackedPostpones) {
                newProps = task.componentStack;
                defaultProps = [keyPath[0], "Suspense Fallback", keyPath[2]];
                initialState = [defaultProps[1], defaultProps[2], [], null];
                request.trackedPostpones.workingMap.set(defaultProps, initialState);
                newBoundary.trackedFallbackNode = initialState;
                task.blockedSegment = boundarySegment;
                task.blockedPreamble = newBoundary.fallbackPreamble;
                task.keyPath = defaultProps;
                task.formatContext = getSuspenseFallbackFormatContext(request.resumableState, ref);
                task.componentStack =
                  replaceSuspenseComponentStackWithSuspenseFallbackStack(newProps);
                boundarySegment.status = 6;
                try {
                  (renderNode(request, task, fallback, -1),
                    pushSegmentFinale(
                      boundarySegment.chunks,
                      request.renderState,
                      boundarySegment.lastPushedText,
                      boundarySegment.textEmbedded,
                    ),
                    (boundarySegment.status = 1));
                } catch (thrownValue) {
                  throw ((boundarySegment.status = 12 === request.status ? 3 : 4), thrownValue);
                } finally {
                  ((task.blockedSegment = propName),
                    (task.blockedPreamble = propName$43),
                    (task.keyPath = type),
                    (task.formatContext = ref));
                }
                task = createRenderTask(
                  request,
                  null,
                  props,
                  -1,
                  newBoundary,
                  contentRootSegment,
                  newBoundary.contentPreamble,
                  newBoundary.contentState,
                  task.abortSet,
                  keyPath,
                  getSuspenseContentFormatContext(request.resumableState, task.formatContext),
                  task.context,
                  task.treeContext,
                  null,
                  newProps,
                );
                pushComponentStack(task);
                request.pingedTasks.push(task);
              } else {
                task.blockedBoundary = newBoundary;
                task.blockedPreamble = newBoundary.contentPreamble;
                task.hoistableState = newBoundary.contentState;
                task.blockedSegment = contentRootSegment;
                task.keyPath = keyPath;
                task.formatContext = getSuspenseContentFormatContext(request.resumableState, ref);
                task.row = null;
                contentRootSegment.status = 6;
                try {
                  if (
                    (renderNode(request, task, props, -1),
                    pushSegmentFinale(
                      contentRootSegment.chunks,
                      request.renderState,
                      contentRootSegment.lastPushedText,
                      contentRootSegment.textEmbedded,
                    ),
                    (contentRootSegment.status = 1),
                    queueCompletedSegment(newBoundary, contentRootSegment),
                    0 === newBoundary.pendingTasks && 0 === newBoundary.status)
                  ) {
                    if (((newBoundary.status = 1), !isEligibleForOutlining(request, newBoundary))) {
                      null !== prevRow &&
                        0 === --prevRow.pendingTasks &&
                        finishSuspenseListRow(request, prevRow);
                      0 === request.pendingRootTasks &&
                        task.blockedPreamble &&
                        preparePreamble(request);
                      break a;
                    }
                  } else
                    null !== prevRow &&
                      prevRow.together &&
                      tryToResolveTogetherRow(request, prevRow);
                } catch (thrownValue$30) {
                  ((newBoundary.status = 4),
                    12 === request.status
                      ? ((contentRootSegment.status = 3), (newProps = request.fatalError))
                      : ((contentRootSegment.status = 4), (newProps = thrownValue$30)),
                    (defaultProps = getThrownInfo(task.componentStack)),
                    (initialState = logRecoverableError(request, newProps, defaultProps)),
                    (newBoundary.errorDigest = initialState),
                    untrackBoundary(request, newBoundary));
                } finally {
                  ((task.blockedBoundary = parentBoundary),
                    (task.blockedPreamble = propName$43),
                    (task.hoistableState = parentHoistableState),
                    (task.blockedSegment = propName),
                    (task.keyPath = type),
                    (task.formatContext = ref),
                    (task.row = prevRow));
                }
                task = createRenderTask(
                  request,
                  null,
                  fallback,
                  -1,
                  parentBoundary,
                  boundarySegment,
                  newBoundary.fallbackPreamble,
                  newBoundary.fallbackState,
                  fallbackAbortSet,
                  [keyPath[0], "Suspense Fallback", keyPath[2]],
                  getSuspenseFallbackFormatContext(request.resumableState, task.formatContext),
                  task.context,
                  task.treeContext,
                  task.row,
                  replaceSuspenseComponentStackWithSuspenseFallbackStack(task.componentStack),
                );
                pushComponentStack(task);
                request.pingedTasks.push(task);
              }
            }
            return;
        }
        if ("object" === typeof type && null !== type)
          switch (type.$$typeof) {
            case REACT_FORWARD_REF_TYPE:
              if ("ref" in props)
                for (fallback in ((newProps = {}), props))
                  "ref" !== fallback && (newProps[fallback] = props[fallback]);
              else newProps = props;
              type = renderWithHooks(request, task, keyPath, type.render, newProps, ref);
              finishFunctionComponent(
                request,
                task,
                keyPath,
                type,
                0 !== localIdCounter,
                actionStateCounter,
                actionStateMatchingIndex,
              );
              return;
            case REACT_MEMO_TYPE:
              renderElement(request, task, keyPath, type.type, props, ref);
              return;
            case REACT_CONTEXT_TYPE:
              defaultProps = props.children;
              newProps = task.keyPath;
              props = props.value;
              initialState = type._currentValue2;
              type._currentValue2 = props;
              ref = currentActiveSnapshot;
              currentActiveSnapshot = type = {
                parent: ref,
                depth: null === ref ? 0 : ref.depth + 1,
                context: type,
                parentValue: initialState,
                value: props,
              };
              task.context = type;
              task.keyPath = keyPath;
              renderNodeDestructive(request, task, defaultProps, -1);
              request = currentActiveSnapshot;
              if (null === request) throw Error(formatProdErrorMessage(403));
              request.context._currentValue2 = request.parentValue;
              request = currentActiveSnapshot = request.parent;
              task.context = request;
              task.keyPath = newProps;
              return;
            case REACT_CONSUMER_TYPE:
              props = props.children;
              type = props(type._context._currentValue2);
              props = task.keyPath;
              task.keyPath = keyPath;
              renderNodeDestructive(request, task, type, -1);
              task.keyPath = props;
              return;
            case REACT_LAZY_TYPE:
              newProps = type._init;
              type = newProps(type._payload);
              if (12 === request.status) throw null;
              renderElement(request, task, keyPath, type, props, ref);
              return;
          }
        throw Error(formatProdErrorMessage(130, null == type ? type : typeof type, ""));
      }
    }
    function resumeNode(request, task, segmentId, node, childIndex) {
      var prevReplay = task.replay,
        blockedBoundary = task.blockedBoundary,
        resumedSegment = createPendingSegment(request, 0, null, task.formatContext, !1, !1);
      resumedSegment.id = segmentId;
      resumedSegment.parentFlushed = !0;
      try {
        ((task.replay = null),
          (task.blockedSegment = resumedSegment),
          renderNode(request, task, node, childIndex),
          (resumedSegment.status = 1),
          null === blockedBoundary
            ? (request.completedRootSegment = resumedSegment)
            : (queueCompletedSegment(blockedBoundary, resumedSegment),
              blockedBoundary.parentFlushed && request.partialBoundaries.push(blockedBoundary)));
      } finally {
        ((task.replay = prevReplay), (task.blockedSegment = null));
      }
    }
    function renderNodeDestructive(request, task, node, childIndex) {
      null !== task.replay && "number" === typeof task.replay.slots
        ? resumeNode(request, task, task.replay.slots, node, childIndex)
        : ((task.node = node),
          (task.childIndex = childIndex),
          (node = task.componentStack),
          pushComponentStack(task),
          retryNode(request, task),
          (task.componentStack = node));
    }
    function retryNode(request, task) {
      var node = task.node,
        childIndex = task.childIndex;
      if (null !== node) {
        if ("object" === typeof node) {
          switch (node.$$typeof) {
            case REACT_ELEMENT_TYPE:
              var type = node.type,
                key = node.key,
                props = node.props;
              node = props.ref;
              var ref = void 0 !== node ? node : null,
                name = getComponentNameFromType(type),
                keyOrIndex = null == key ? (-1 === childIndex ? 0 : childIndex) : key;
              key = [task.keyPath, name, keyOrIndex];
              if (null !== task.replay)
                a: {
                  var replay = task.replay;
                  childIndex = replay.nodes;
                  for (node = 0; node < childIndex.length; node++) {
                    var node$jscomp$0 = childIndex[node];
                    if (keyOrIndex === node$jscomp$0[1]) {
                      if (4 === node$jscomp$0.length) {
                        if (null !== name && name !== node$jscomp$0[0])
                          throw Error(formatProdErrorMessage(490, node$jscomp$0[0], name));
                        var childNodes = node$jscomp$0[2];
                        name = node$jscomp$0[3];
                        keyOrIndex = task.node;
                        task.replay = {
                          nodes: childNodes,
                          slots: name,
                          pendingTasks: 1,
                        };
                        try {
                          renderElement(request, task, key, type, props, ref);
                          if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                            throw Error(formatProdErrorMessage(488));
                          task.replay.pendingTasks--;
                        } catch (x) {
                          if (
                            "object" === typeof x &&
                            null !== x &&
                            (x === SuspenseException || "function" === typeof x.then)
                          )
                            throw (
                              task.node === keyOrIndex
                                ? (task.replay = replay)
                                : childIndex.splice(node, 1),
                              x
                            );
                          task.replay.pendingTasks--;
                          props = getThrownInfo(task.componentStack);
                          key = request;
                          request = task.blockedBoundary;
                          type = x;
                          props = logRecoverableError(key, type, props);
                          abortRemainingReplayNodes(key, request, childNodes, name, type, props);
                        }
                        task.replay = replay;
                      } else {
                        if (type !== REACT_SUSPENSE_TYPE)
                          throw Error(
                            formatProdErrorMessage(
                              490,
                              "Suspense",
                              getComponentNameFromType(type) || "Unknown",
                            ),
                          );
                        b: {
                          replay = void 0;
                          type = node$jscomp$0[5];
                          ref = node$jscomp$0[2];
                          name = node$jscomp$0[3];
                          keyOrIndex = null === node$jscomp$0[4] ? [] : node$jscomp$0[4][2];
                          node$jscomp$0 = null === node$jscomp$0[4] ? null : node$jscomp$0[4][3];
                          var prevKeyPath = task.keyPath,
                            prevContext = task.formatContext,
                            prevRow = task.row,
                            previousReplaySet = task.replay,
                            parentBoundary = task.blockedBoundary,
                            parentHoistableState = task.hoistableState,
                            content = props.children,
                            fallback = props.fallback,
                            fallbackAbortSet = /* @__PURE__ */ new Set();
                          props = createSuspenseBoundary(
                            request,
                            task.row,
                            fallbackAbortSet,
                            null,
                            null,
                          );
                          props.parentFlushed = !0;
                          props.rootSegmentID = type;
                          task.blockedBoundary = props;
                          task.hoistableState = props.contentState;
                          task.keyPath = key;
                          task.formatContext = getSuspenseContentFormatContext(
                            request.resumableState,
                            prevContext,
                          );
                          task.row = null;
                          task.replay = {
                            nodes: ref,
                            slots: name,
                            pendingTasks: 1,
                          };
                          try {
                            renderNode(request, task, content, -1);
                            if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                              throw Error(formatProdErrorMessage(488));
                            task.replay.pendingTasks--;
                            if (0 === props.pendingTasks && 0 === props.status) {
                              props.status = 1;
                              request.completedBoundaries.push(props);
                              break b;
                            }
                          } catch (error) {
                            ((props.status = 4),
                              (childNodes = getThrownInfo(task.componentStack)),
                              (replay = logRecoverableError(request, error, childNodes)),
                              (props.errorDigest = replay),
                              task.replay.pendingTasks--,
                              request.clientRenderedBoundaries.push(props));
                          } finally {
                            ((task.blockedBoundary = parentBoundary),
                              (task.hoistableState = parentHoistableState),
                              (task.replay = previousReplaySet),
                              (task.keyPath = prevKeyPath),
                              (task.formatContext = prevContext),
                              (task.row = prevRow));
                          }
                          childNodes = createReplayTask(
                            request,
                            null,
                            {
                              nodes: keyOrIndex,
                              slots: node$jscomp$0,
                              pendingTasks: 0,
                            },
                            fallback,
                            -1,
                            parentBoundary,
                            props.fallbackState,
                            fallbackAbortSet,
                            [key[0], "Suspense Fallback", key[2]],
                            getSuspenseFallbackFormatContext(
                              request.resumableState,
                              task.formatContext,
                            ),
                            task.context,
                            task.treeContext,
                            task.row,
                            replaceSuspenseComponentStackWithSuspenseFallbackStack(
                              task.componentStack,
                            ),
                          );
                          pushComponentStack(childNodes);
                          request.pingedTasks.push(childNodes);
                        }
                      }
                      childIndex.splice(node, 1);
                      break a;
                    }
                  }
                }
              else renderElement(request, task, key, type, props, ref);
              return;
            case REACT_PORTAL_TYPE:
              throw Error(formatProdErrorMessage(257));
            case REACT_LAZY_TYPE:
              childNodes = node._init;
              node = childNodes(node._payload);
              if (12 === request.status) throw null;
              renderNodeDestructive(request, task, node, childIndex);
              return;
          }
          if (isArrayImpl(node)) {
            renderChildrenArray(request, task, node, childIndex);
            return;
          }
          if ((childNodes = getIteratorFn(node))) {
            if ((childNodes = childNodes.call(node))) {
              node = childNodes.next();
              if (!node.done) {
                props = [];
                do (props.push(node.value), (node = childNodes.next()));
                while (!node.done);
                renderChildrenArray(request, task, props, childIndex);
              }
              return;
            }
          }
          if ("function" === typeof node.then)
            return (
              (task.thenableState = null),
              renderNodeDestructive(request, task, unwrapThenable(node), childIndex)
            );
          if (node.$$typeof === REACT_CONTEXT_TYPE)
            return renderNodeDestructive(request, task, node._currentValue2, childIndex);
          childIndex = Object.prototype.toString.call(node);
          throw Error(
            formatProdErrorMessage(
              31,
              "[object Object]" === childIndex
                ? "object with keys {" + Object.keys(node).join(", ") + "}"
                : childIndex,
            ),
          );
        }
        if ("string" === typeof node)
          ((childIndex = task.blockedSegment),
            null !== childIndex &&
              (childIndex.lastPushedText = pushTextInstance(
                childIndex.chunks,
                node,
                request.renderState,
                childIndex.lastPushedText,
              )));
        else if ("number" === typeof node || "bigint" === typeof node)
          ((childIndex = task.blockedSegment),
            null !== childIndex &&
              (childIndex.lastPushedText = pushTextInstance(
                childIndex.chunks,
                "" + node,
                request.renderState,
                childIndex.lastPushedText,
              )));
      }
    }
    function renderChildrenArray(request, task, children, childIndex) {
      var prevKeyPath = task.keyPath;
      if (
        -1 !== childIndex &&
        ((task.keyPath = [task.keyPath, "Fragment", childIndex]), null !== task.replay)
      ) {
        for (
          var replay = task.replay, replayNodes = replay.nodes, j = 0;
          j < replayNodes.length;
          j++
        ) {
          var node = replayNodes[j];
          if (node[1] === childIndex) {
            childIndex = node[2];
            node = node[3];
            task.replay = {
              nodes: childIndex,
              slots: node,
              pendingTasks: 1,
            };
            try {
              renderChildrenArray(request, task, children, -1);
              if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                throw Error(formatProdErrorMessage(488));
              task.replay.pendingTasks--;
            } catch (x) {
              if (
                "object" === typeof x &&
                null !== x &&
                (x === SuspenseException || "function" === typeof x.then)
              )
                throw x;
              task.replay.pendingTasks--;
              children = getThrownInfo(task.componentStack);
              var boundary = task.blockedBoundary,
                error = x;
              children = logRecoverableError(request, error, children);
              abortRemainingReplayNodes(request, boundary, childIndex, node, error, children);
            }
            task.replay = replay;
            replayNodes.splice(j, 1);
            break;
          }
        }
        task.keyPath = prevKeyPath;
        return;
      }
      replay = task.treeContext;
      replayNodes = children.length;
      if (null !== task.replay && ((j = task.replay.slots), null !== j && "object" === typeof j)) {
        for (childIndex = 0; childIndex < replayNodes; childIndex++)
          ((node = children[childIndex]),
            (task.treeContext = pushTreeContext(replay, replayNodes, childIndex)),
            (boundary = j[childIndex]),
            "number" === typeof boundary
              ? (resumeNode(request, task, boundary, node, childIndex), delete j[childIndex])
              : renderNode(request, task, node, childIndex));
        task.treeContext = replay;
        task.keyPath = prevKeyPath;
        return;
      }
      for (j = 0; j < replayNodes; j++)
        ((childIndex = children[j]),
          (task.treeContext = pushTreeContext(replay, replayNodes, j)),
          renderNode(request, task, childIndex, j));
      task.treeContext = replay;
      task.keyPath = prevKeyPath;
    }
    function trackPostponedBoundary(request, trackedPostpones, boundary) {
      boundary.status = 5;
      boundary.rootSegmentID = request.nextSegmentId++;
      request = boundary.trackedContentKeyPath;
      if (null === request) throw Error(formatProdErrorMessage(486));
      var fallbackReplayNode = boundary.trackedFallbackNode,
        children = [],
        boundaryNode = trackedPostpones.workingMap.get(request);
      if (void 0 === boundaryNode)
        return (
          (boundary = [
            request[1],
            request[2],
            children,
            null,
            fallbackReplayNode,
            boundary.rootSegmentID,
          ]),
          trackedPostpones.workingMap.set(request, boundary),
          addToReplayParent(boundary, request[0], trackedPostpones),
          boundary
        );
      boundaryNode[4] = fallbackReplayNode;
      boundaryNode[5] = boundary.rootSegmentID;
      return boundaryNode;
    }
    function trackPostpone(request, trackedPostpones, task, segment) {
      segment.status = 5;
      var keyPath = task.keyPath,
        boundary = task.blockedBoundary;
      if (null === boundary)
        ((segment.id = request.nextSegmentId++),
          (trackedPostpones.rootSlots = segment.id),
          null !== request.completedRootSegment && (request.completedRootSegment.status = 5));
      else {
        if (null !== boundary && 0 === boundary.status) {
          var boundaryNode = trackPostponedBoundary(request, trackedPostpones, boundary);
          if (boundary.trackedContentKeyPath === keyPath && -1 === task.childIndex) {
            -1 === segment.id &&
              (segment.id = segment.parentFlushed
                ? boundary.rootSegmentID
                : request.nextSegmentId++);
            boundaryNode[3] = segment.id;
            return;
          }
        }
        -1 === segment.id &&
          (segment.id =
            segment.parentFlushed && null !== boundary
              ? boundary.rootSegmentID
              : request.nextSegmentId++);
        if (-1 === task.childIndex)
          null === keyPath
            ? (trackedPostpones.rootSlots = segment.id)
            : ((task = trackedPostpones.workingMap.get(keyPath)),
              void 0 === task
                ? ((task = [keyPath[1], keyPath[2], [], segment.id]),
                  addToReplayParent(task, keyPath[0], trackedPostpones))
                : (task[3] = segment.id));
        else {
          if (null === keyPath) {
            if (((request = trackedPostpones.rootSlots), null === request))
              request = trackedPostpones.rootSlots = {};
            else if ("number" === typeof request) throw Error(formatProdErrorMessage(491));
          } else if (
            ((boundary = trackedPostpones.workingMap),
            (boundaryNode = boundary.get(keyPath)),
            void 0 === boundaryNode)
          )
            ((request = {}),
              (boundaryNode = [keyPath[1], keyPath[2], [], request]),
              boundary.set(keyPath, boundaryNode),
              addToReplayParent(boundaryNode, keyPath[0], trackedPostpones));
          else if (((request = boundaryNode[3]), null === request)) request = boundaryNode[3] = {};
          else if ("number" === typeof request) throw Error(formatProdErrorMessage(491));
          request[task.childIndex] = segment.id;
        }
      }
    }
    function untrackBoundary(request, boundary) {
      request = request.trackedPostpones;
      null !== request &&
        ((boundary = boundary.trackedContentKeyPath),
        null !== boundary &&
          ((boundary = request.workingMap.get(boundary)),
          void 0 !== boundary &&
            ((boundary.length = 4), (boundary[2] = []), (boundary[3] = null))));
    }
    function spawnNewSuspendedReplayTask(request, task, thenableState) {
      return createReplayTask(
        request,
        thenableState,
        task.replay,
        task.node,
        task.childIndex,
        task.blockedBoundary,
        task.hoistableState,
        task.abortSet,
        task.keyPath,
        task.formatContext,
        task.context,
        task.treeContext,
        task.row,
        task.componentStack,
      );
    }
    function spawnNewSuspendedRenderTask(request, task, thenableState) {
      var segment = task.blockedSegment,
        newSegment = createPendingSegment(
          request,
          segment.chunks.length,
          null,
          task.formatContext,
          segment.lastPushedText,
          !0,
        );
      segment.children.push(newSegment);
      segment.lastPushedText = !1;
      return createRenderTask(
        request,
        thenableState,
        task.node,
        task.childIndex,
        task.blockedBoundary,
        newSegment,
        task.blockedPreamble,
        task.hoistableState,
        task.abortSet,
        task.keyPath,
        task.formatContext,
        task.context,
        task.treeContext,
        task.row,
        task.componentStack,
      );
    }
    function renderNode(request, task, node, childIndex) {
      var previousFormatContext = task.formatContext,
        previousContext = task.context,
        previousKeyPath = task.keyPath,
        previousTreeContext = task.treeContext,
        previousComponentStack = task.componentStack,
        segment = task.blockedSegment;
      if (null === segment) {
        segment = task.replay;
        try {
          return renderNodeDestructive(request, task, node, childIndex);
        } catch (thrownValue) {
          if (
            (resetHooksState(),
            (node = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue),
            12 !== request.status && "object" === typeof node && null !== node)
          ) {
            if ("function" === typeof node.then) {
              childIndex =
                thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
              request = spawnNewSuspendedReplayTask(request, task, childIndex).ping;
              node.then(request, request);
              task.formatContext = previousFormatContext;
              task.context = previousContext;
              task.keyPath = previousKeyPath;
              task.treeContext = previousTreeContext;
              task.componentStack = previousComponentStack;
              task.replay = segment;
              switchContext(previousContext);
              return;
            }
            if ("Maximum call stack size exceeded" === node.message) {
              node = thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
              node = spawnNewSuspendedReplayTask(request, task, node);
              request.pingedTasks.push(node);
              task.formatContext = previousFormatContext;
              task.context = previousContext;
              task.keyPath = previousKeyPath;
              task.treeContext = previousTreeContext;
              task.componentStack = previousComponentStack;
              task.replay = segment;
              switchContext(previousContext);
              return;
            }
          }
        }
      } else {
        var childrenLength = segment.children.length,
          chunkLength = segment.chunks.length;
        try {
          return renderNodeDestructive(request, task, node, childIndex);
        } catch (thrownValue$62) {
          if (
            (resetHooksState(),
            (segment.children.length = childrenLength),
            (segment.chunks.length = chunkLength),
            (node = thrownValue$62 === SuspenseException ? getSuspendedThenable() : thrownValue$62),
            12 !== request.status && "object" === typeof node && null !== node)
          ) {
            if ("function" === typeof node.then) {
              segment = node;
              node =
                thrownValue$62 === SuspenseException ? getThenableStateAfterSuspending() : null;
              request = spawnNewSuspendedRenderTask(request, task, node).ping;
              segment.then(request, request);
              task.formatContext = previousFormatContext;
              task.context = previousContext;
              task.keyPath = previousKeyPath;
              task.treeContext = previousTreeContext;
              task.componentStack = previousComponentStack;
              switchContext(previousContext);
              return;
            }
            if ("Maximum call stack size exceeded" === node.message) {
              segment =
                thrownValue$62 === SuspenseException ? getThenableStateAfterSuspending() : null;
              segment = spawnNewSuspendedRenderTask(request, task, segment);
              request.pingedTasks.push(segment);
              task.formatContext = previousFormatContext;
              task.context = previousContext;
              task.keyPath = previousKeyPath;
              task.treeContext = previousTreeContext;
              task.componentStack = previousComponentStack;
              switchContext(previousContext);
              return;
            }
          }
        }
      }
      task.formatContext = previousFormatContext;
      task.context = previousContext;
      task.keyPath = previousKeyPath;
      task.treeContext = previousTreeContext;
      switchContext(previousContext);
      throw node;
    }
    function abortTaskSoft(task) {
      var boundary = task.blockedBoundary,
        segment = task.blockedSegment;
      null !== segment && ((segment.status = 3), finishedTask(this, boundary, task.row, segment));
    }
    function abortRemainingReplayNodes(
      request$jscomp$0,
      boundary,
      nodes,
      slots,
      error,
      errorDigest$jscomp$0,
    ) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (4 === node.length)
          abortRemainingReplayNodes(
            request$jscomp$0,
            boundary,
            node[2],
            node[3],
            error,
            errorDigest$jscomp$0,
          );
        else {
          node = node[5];
          var request = request$jscomp$0,
            errorDigest = errorDigest$jscomp$0,
            resumedBoundary = createSuspenseBoundary(
              request,
              null,
              /* @__PURE__ */ new Set(),
              null,
              null,
            );
          resumedBoundary.parentFlushed = !0;
          resumedBoundary.rootSegmentID = node;
          resumedBoundary.status = 4;
          resumedBoundary.errorDigest = errorDigest;
          resumedBoundary.parentFlushed && request.clientRenderedBoundaries.push(resumedBoundary);
        }
      }
      nodes.length = 0;
      if (null !== slots) {
        if (null === boundary) throw Error(formatProdErrorMessage(487));
        4 !== boundary.status &&
          ((boundary.status = 4),
          (boundary.errorDigest = errorDigest$jscomp$0),
          boundary.parentFlushed && request$jscomp$0.clientRenderedBoundaries.push(boundary));
        if ("object" === typeof slots) for (var index in slots) delete slots[index];
      }
    }
    function abortTask(task, request, error) {
      var boundary = task.blockedBoundary,
        segment = task.blockedSegment;
      if (null !== segment) {
        if (6 === segment.status) return;
        segment.status = 3;
      }
      var errorInfo = getThrownInfo(task.componentStack);
      if (null === boundary) {
        if (13 !== request.status && 14 !== request.status) {
          boundary = task.replay;
          if (null === boundary) {
            null !== request.trackedPostpones && null !== segment
              ? ((boundary = request.trackedPostpones),
                logRecoverableError(request, error, errorInfo),
                trackPostpone(request, boundary, task, segment),
                finishedTask(request, null, task.row, segment))
              : (logRecoverableError(request, error, errorInfo), fatalError(request, error));
            return;
          }
          boundary.pendingTasks--;
          0 === boundary.pendingTasks &&
            0 < boundary.nodes.length &&
            ((segment = logRecoverableError(request, error, errorInfo)),
            abortRemainingReplayNodes(
              request,
              null,
              boundary.nodes,
              boundary.slots,
              error,
              segment,
            ));
          request.pendingRootTasks--;
          0 === request.pendingRootTasks && completeShell(request);
        }
      } else {
        var trackedPostpones$63 = request.trackedPostpones;
        if (4 !== boundary.status) {
          if (null !== trackedPostpones$63 && null !== segment)
            return (
              logRecoverableError(request, error, errorInfo),
              trackPostpone(request, trackedPostpones$63, task, segment),
              boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
                return abortTask(fallbackTask, request, error);
              }),
              boundary.fallbackAbortableTasks.clear(),
              finishedTask(request, boundary, task.row, segment)
            );
          boundary.status = 4;
          segment = logRecoverableError(request, error, errorInfo);
          boundary.status = 4;
          boundary.errorDigest = segment;
          untrackBoundary(request, boundary);
          boundary.parentFlushed && request.clientRenderedBoundaries.push(boundary);
        }
        boundary.pendingTasks--;
        segment = boundary.row;
        null !== segment && 0 === --segment.pendingTasks && finishSuspenseListRow(request, segment);
        boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
          return abortTask(fallbackTask, request, error);
        });
        boundary.fallbackAbortableTasks.clear();
      }
      task = task.row;
      null !== task && 0 === --task.pendingTasks && finishSuspenseListRow(request, task);
      request.allPendingTasks--;
      0 === request.allPendingTasks && completeAll(request);
    }
    function safelyEmitEarlyPreloads(request, shellComplete) {
      try {
        var renderState = request.renderState,
          onHeaders = renderState.onHeaders;
        if (onHeaders) {
          var headers = renderState.headers;
          if (headers) {
            renderState.headers = null;
            var linkHeader = headers.preconnects;
            headers.fontPreloads &&
              (linkHeader && (linkHeader += ", "), (linkHeader += headers.fontPreloads));
            headers.highImagePreloads &&
              (linkHeader && (linkHeader += ", "), (linkHeader += headers.highImagePreloads));
            if (!shellComplete) {
              var queueIter = renderState.styles.values(),
                queueStep = queueIter.next();
              b: for (
                ;
                0 < headers.remainingCapacity && !queueStep.done;
                queueStep = queueIter.next()
              )
                for (
                  var sheetIter = queueStep.value.sheets.values(), sheetStep = sheetIter.next();
                  0 < headers.remainingCapacity && !sheetStep.done;
                  sheetStep = sheetIter.next()
                ) {
                  var sheet = sheetStep.value,
                    props = sheet.props,
                    key = props.href,
                    props$jscomp$0 = sheet.props,
                    header = getPreloadAsHeader(props$jscomp$0.href, "style", {
                      crossOrigin: props$jscomp$0.crossOrigin,
                      integrity: props$jscomp$0.integrity,
                      nonce: props$jscomp$0.nonce,
                      type: props$jscomp$0.type,
                      fetchPriority: props$jscomp$0.fetchPriority,
                      referrerPolicy: props$jscomp$0.referrerPolicy,
                      media: props$jscomp$0.media,
                    });
                  if (0 <= (headers.remainingCapacity -= header.length + 2))
                    ((renderState.resets.style[key] = PRELOAD_NO_CREDS),
                      linkHeader && (linkHeader += ", "),
                      (linkHeader += header),
                      (renderState.resets.style[key] =
                        "string" === typeof props.crossOrigin || "string" === typeof props.integrity
                          ? [props.crossOrigin, props.integrity]
                          : PRELOAD_NO_CREDS));
                  else break b;
                }
            }
            linkHeader ? onHeaders({ Link: linkHeader }) : onHeaders({});
          }
        }
      } catch (error) {
        logRecoverableError(request, error, {});
      }
    }
    function completeShell(request) {
      null === request.trackedPostpones && safelyEmitEarlyPreloads(request, !0);
      null === request.trackedPostpones && preparePreamble(request);
      request.onShellError = noop;
      request = request.onShellReady;
      request();
    }
    function completeAll(request) {
      safelyEmitEarlyPreloads(
        request,
        null === request.trackedPostpones
          ? !0
          : null === request.completedRootSegment || 5 !== request.completedRootSegment.status,
      );
      preparePreamble(request);
      request = request.onAllReady;
      request();
    }
    function queueCompletedSegment(boundary, segment) {
      if (
        0 === segment.chunks.length &&
        1 === segment.children.length &&
        null === segment.children[0].boundary &&
        -1 === segment.children[0].id
      ) {
        var childSegment = segment.children[0];
        childSegment.id = segment.id;
        childSegment.parentFlushed = !0;
        (1 !== childSegment.status && 3 !== childSegment.status && 4 !== childSegment.status) ||
          queueCompletedSegment(boundary, childSegment);
      } else boundary.completedSegments.push(segment);
    }
    function finishedTask(request, boundary, row, segment) {
      null !== row &&
        (0 === --row.pendingTasks
          ? finishSuspenseListRow(request, row)
          : row.together && tryToResolveTogetherRow(request, row));
      request.allPendingTasks--;
      if (null === boundary) {
        if (null !== segment && segment.parentFlushed) {
          if (null !== request.completedRootSegment) throw Error(formatProdErrorMessage(389));
          request.completedRootSegment = segment;
        }
        request.pendingRootTasks--;
        0 === request.pendingRootTasks && completeShell(request);
      } else if ((boundary.pendingTasks--, 4 !== boundary.status))
        if (0 === boundary.pendingTasks) {
          if (
            (0 === boundary.status && (boundary.status = 1),
            null !== segment &&
              segment.parentFlushed &&
              (1 === segment.status || 3 === segment.status) &&
              queueCompletedSegment(boundary, segment),
            boundary.parentFlushed && request.completedBoundaries.push(boundary),
            1 === boundary.status)
          )
            ((row = boundary.row),
              null !== row && hoistHoistables(row.hoistables, boundary.contentState),
              isEligibleForOutlining(request, boundary) ||
                (boundary.fallbackAbortableTasks.forEach(abortTaskSoft, request),
                boundary.fallbackAbortableTasks.clear(),
                null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row)),
              0 === request.pendingRootTasks &&
                null === request.trackedPostpones &&
                null !== boundary.contentPreamble &&
                preparePreamble(request));
          else if (5 === boundary.status && ((boundary = boundary.row), null !== boundary)) {
            if (null !== request.trackedPostpones) {
              row = request.trackedPostpones;
              var postponedRow = boundary.next;
              if (null !== postponedRow && ((segment = postponedRow.boundaries), null !== segment))
                for (
                  postponedRow.boundaries = null, postponedRow = 0;
                  postponedRow < segment.length;
                  postponedRow++
                ) {
                  var postponedBoundary = segment[postponedRow];
                  trackPostponedBoundary(request, row, postponedBoundary);
                  finishedTask(request, postponedBoundary, null, null);
                }
            }
            0 === --boundary.pendingTasks && finishSuspenseListRow(request, boundary);
          }
        } else
          (null === segment ||
            !segment.parentFlushed ||
            (1 !== segment.status && 3 !== segment.status) ||
            (queueCompletedSegment(boundary, segment),
            1 === boundary.completedSegments.length &&
              boundary.parentFlushed &&
              request.partialBoundaries.push(boundary)),
            (boundary = boundary.row),
            null !== boundary && boundary.together && tryToResolveTogetherRow(request, boundary));
      0 === request.allPendingTasks && completeAll(request);
    }
    function performWork(request$jscomp$2) {
      if (14 !== request$jscomp$2.status && 13 !== request$jscomp$2.status) {
        var prevContext = currentActiveSnapshot,
          prevDispatcher = ReactSharedInternals.H;
        ReactSharedInternals.H = HooksDispatcher;
        var prevAsyncDispatcher = ReactSharedInternals.A;
        ReactSharedInternals.A = DefaultAsyncDispatcher;
        var prevRequest = currentRequest;
        currentRequest = request$jscomp$2;
        var prevResumableState = currentResumableState;
        currentResumableState = request$jscomp$2.resumableState;
        try {
          var pingedTasks = request$jscomp$2.pingedTasks,
            i;
          for (i = 0; i < pingedTasks.length; i++) {
            var task = pingedTasks[i],
              request = request$jscomp$2,
              segment = task.blockedSegment;
            if (null === segment) {
              var request$jscomp$0 = request;
              if (0 !== task.replay.pendingTasks) {
                switchContext(task.context);
                try {
                  "number" === typeof task.replay.slots
                    ? resumeNode(
                        request$jscomp$0,
                        task,
                        task.replay.slots,
                        task.node,
                        task.childIndex,
                      )
                    : retryNode(request$jscomp$0, task);
                  if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                    throw Error(formatProdErrorMessage(488));
                  task.replay.pendingTasks--;
                  task.abortSet.delete(task);
                  finishedTask(request$jscomp$0, task.blockedBoundary, task.row, null);
                } catch (thrownValue) {
                  resetHooksState();
                  var x = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue;
                  if ("object" === typeof x && null !== x && "function" === typeof x.then) {
                    var ping = task.ping;
                    x.then(ping, ping);
                    task.thenableState =
                      thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                  } else {
                    task.replay.pendingTasks--;
                    task.abortSet.delete(task);
                    var errorInfo = getThrownInfo(task.componentStack);
                    request = void 0;
                    var request$jscomp$1 = request$jscomp$0,
                      boundary = task.blockedBoundary,
                      error$jscomp$0 =
                        12 === request$jscomp$0.status ? request$jscomp$0.fatalError : x,
                      replayNodes = task.replay.nodes,
                      resumeSlots = task.replay.slots;
                    request = logRecoverableError(request$jscomp$1, error$jscomp$0, errorInfo);
                    abortRemainingReplayNodes(
                      request$jscomp$1,
                      boundary,
                      replayNodes,
                      resumeSlots,
                      error$jscomp$0,
                      request,
                    );
                    request$jscomp$0.pendingRootTasks--;
                    0 === request$jscomp$0.pendingRootTasks && completeShell(request$jscomp$0);
                    request$jscomp$0.allPendingTasks--;
                    0 === request$jscomp$0.allPendingTasks && completeAll(request$jscomp$0);
                  }
                }
              }
            } else if (
              ((request$jscomp$0 = void 0),
              (request$jscomp$1 = segment),
              0 === request$jscomp$1.status)
            ) {
              request$jscomp$1.status = 6;
              switchContext(task.context);
              var childrenLength = request$jscomp$1.children.length,
                chunkLength = request$jscomp$1.chunks.length;
              try {
                (retryNode(request, task),
                  pushSegmentFinale(
                    request$jscomp$1.chunks,
                    request.renderState,
                    request$jscomp$1.lastPushedText,
                    request$jscomp$1.textEmbedded,
                  ),
                  task.abortSet.delete(task),
                  (request$jscomp$1.status = 1),
                  finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1));
              } catch (thrownValue) {
                resetHooksState();
                request$jscomp$1.children.length = childrenLength;
                request$jscomp$1.chunks.length = chunkLength;
                var x$jscomp$0 =
                  thrownValue === SuspenseException
                    ? getSuspendedThenable()
                    : 12 === request.status
                      ? request.fatalError
                      : thrownValue;
                if (12 === request.status && null !== request.trackedPostpones) {
                  var trackedPostpones = request.trackedPostpones,
                    thrownInfo = getThrownInfo(task.componentStack);
                  task.abortSet.delete(task);
                  logRecoverableError(request, x$jscomp$0, thrownInfo);
                  trackPostpone(request, trackedPostpones, task, request$jscomp$1);
                  finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1);
                } else if (
                  "object" === typeof x$jscomp$0 &&
                  null !== x$jscomp$0 &&
                  "function" === typeof x$jscomp$0.then
                ) {
                  request$jscomp$1.status = 0;
                  task.thenableState =
                    thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                  var ping$jscomp$0 = task.ping;
                  x$jscomp$0.then(ping$jscomp$0, ping$jscomp$0);
                } else {
                  var errorInfo$jscomp$0 = getThrownInfo(task.componentStack);
                  task.abortSet.delete(task);
                  request$jscomp$1.status = 4;
                  var boundary$jscomp$0 = task.blockedBoundary,
                    row = task.row;
                  null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
                  request.allPendingTasks--;
                  request$jscomp$0 = logRecoverableError(request, x$jscomp$0, errorInfo$jscomp$0);
                  if (null === boundary$jscomp$0) fatalError(request, x$jscomp$0);
                  else if ((boundary$jscomp$0.pendingTasks--, 4 !== boundary$jscomp$0.status)) {
                    boundary$jscomp$0.status = 4;
                    boundary$jscomp$0.errorDigest = request$jscomp$0;
                    untrackBoundary(request, boundary$jscomp$0);
                    var boundaryRow = boundary$jscomp$0.row;
                    null !== boundaryRow &&
                      0 === --boundaryRow.pendingTasks &&
                      finishSuspenseListRow(request, boundaryRow);
                    boundary$jscomp$0.parentFlushed &&
                      request.clientRenderedBoundaries.push(boundary$jscomp$0);
                    0 === request.pendingRootTasks &&
                      null === request.trackedPostpones &&
                      null !== boundary$jscomp$0.contentPreamble &&
                      preparePreamble(request);
                  }
                  0 === request.allPendingTasks && completeAll(request);
                }
              }
            }
          }
          pingedTasks.splice(0, i);
          null !== request$jscomp$2.destination &&
            flushCompletedQueues(request$jscomp$2, request$jscomp$2.destination);
        } catch (error) {
          (logRecoverableError(request$jscomp$2, error, {}), fatalError(request$jscomp$2, error));
        } finally {
          ((currentResumableState = prevResumableState),
            (ReactSharedInternals.H = prevDispatcher),
            (ReactSharedInternals.A = prevAsyncDispatcher),
            prevDispatcher === HooksDispatcher && switchContext(prevContext),
            (currentRequest = prevRequest));
        }
      }
    }
    function preparePreambleFromSubtree(request, segment, collectedPreambleSegments) {
      segment.preambleChildren.length && collectedPreambleSegments.push(segment.preambleChildren);
      for (var pendingPreambles = !1, i = 0; i < segment.children.length; i++)
        pendingPreambles =
          preparePreambleFromSegment(request, segment.children[i], collectedPreambleSegments) ||
          pendingPreambles;
      return pendingPreambles;
    }
    function preparePreambleFromSegment(request, segment, collectedPreambleSegments) {
      var boundary = segment.boundary;
      if (null === boundary)
        return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
      var preamble = boundary.contentPreamble,
        fallbackPreamble = boundary.fallbackPreamble;
      if (null === preamble || null === fallbackPreamble) return !1;
      switch (boundary.status) {
        case 1:
          hoistPreambleState(request.renderState, preamble);
          request.byteSize += boundary.byteSize;
          segment = boundary.completedSegments[0];
          if (!segment) throw Error(formatProdErrorMessage(391));
          return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
        case 5:
          if (null !== request.trackedPostpones) return !0;
        case 4:
          if (1 === segment.status)
            return (
              hoistPreambleState(request.renderState, fallbackPreamble),
              preparePreambleFromSubtree(request, segment, collectedPreambleSegments)
            );
        default:
          return !0;
      }
    }
    function preparePreamble(request) {
      if (request.completedRootSegment && null === request.completedPreambleSegments) {
        var collectedPreambleSegments = [],
          originalRequestByteSize = request.byteSize,
          hasPendingPreambles = preparePreambleFromSegment(
            request,
            request.completedRootSegment,
            collectedPreambleSegments,
          ),
          preamble = request.renderState.preamble;
        !1 === hasPendingPreambles || (preamble.headChunks && preamble.bodyChunks)
          ? (request.completedPreambleSegments = collectedPreambleSegments)
          : (request.byteSize = originalRequestByteSize);
      }
    }
    function flushSubtree(request, destination, segment, hoistableState) {
      segment.parentFlushed = !0;
      switch (segment.status) {
        case 0:
          segment.id = request.nextSegmentId++;
        case 5:
          return (
            (hoistableState = segment.id),
            (segment.lastPushedText = !1),
            (segment.textEmbedded = !1),
            (request = request.renderState),
            destination.push('<template id="'),
            destination.push(request.placeholderPrefix),
            (request = hoistableState.toString(16)),
            destination.push(request),
            destination.push('"></template>')
          );
        case 1:
          segment.status = 2;
          var r = !0,
            chunks = segment.chunks,
            chunkIdx = 0;
          segment = segment.children;
          for (var childIdx = 0; childIdx < segment.length; childIdx++) {
            for (r = segment[childIdx]; chunkIdx < r.index; chunkIdx++)
              destination.push(chunks[chunkIdx]);
            r = flushSegment(request, destination, r, hoistableState);
          }
          for (; chunkIdx < chunks.length - 1; chunkIdx++) destination.push(chunks[chunkIdx]);
          chunkIdx < chunks.length && (r = destination.push(chunks[chunkIdx]));
          return r;
        case 3:
          return !0;
        default:
          throw Error(formatProdErrorMessage(390));
      }
    }
    var flushedByteSize = 0;
    function flushSegment(request, destination, segment, hoistableState) {
      var boundary = segment.boundary;
      if (null === boundary) return flushSubtree(request, destination, segment, hoistableState);
      boundary.parentFlushed = !0;
      if (4 === boundary.status) {
        var row = boundary.row;
        null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
        request.renderState.generateStaticMarkup ||
          ((boundary = boundary.errorDigest),
          destination.push("<!--$!-->"),
          destination.push("<template"),
          boundary &&
            (destination.push(' data-dgst="'),
            (boundary = escapeTextForBrowser(boundary)),
            destination.push(boundary),
            destination.push('"')),
          destination.push("></template>"));
        flushSubtree(request, destination, segment, hoistableState);
        request = request.renderState.generateStaticMarkup ? !0 : destination.push("<!--/$-->");
        return request;
      }
      if (1 !== boundary.status)
        return (
          0 === boundary.status && (boundary.rootSegmentID = request.nextSegmentId++),
          0 < boundary.completedSegments.length && request.partialBoundaries.push(boundary),
          writeStartPendingSuspenseBoundary(
            destination,
            request.renderState,
            boundary.rootSegmentID,
          ),
          hoistableState && hoistHoistables(hoistableState, boundary.fallbackState),
          flushSubtree(request, destination, segment, hoistableState),
          destination.push("<!--/$-->")
        );
      if (
        !flushingPartialBoundaries &&
        isEligibleForOutlining(request, boundary) &&
        flushedByteSize + boundary.byteSize > request.progressiveChunkSize
      )
        return (
          (boundary.rootSegmentID = request.nextSegmentId++),
          request.completedBoundaries.push(boundary),
          writeStartPendingSuspenseBoundary(
            destination,
            request.renderState,
            boundary.rootSegmentID,
          ),
          flushSubtree(request, destination, segment, hoistableState),
          destination.push("<!--/$-->")
        );
      flushedByteSize += boundary.byteSize;
      hoistableState && hoistHoistables(hoistableState, boundary.contentState);
      segment = boundary.row;
      null !== segment &&
        isEligibleForOutlining(request, boundary) &&
        0 === --segment.pendingTasks &&
        finishSuspenseListRow(request, segment);
      request.renderState.generateStaticMarkup || destination.push("<!--$-->");
      segment = boundary.completedSegments;
      if (1 !== segment.length) throw Error(formatProdErrorMessage(391));
      flushSegment(request, destination, segment[0], hoistableState);
      request = request.renderState.generateStaticMarkup ? !0 : destination.push("<!--/$-->");
      return request;
    }
    function flushSegmentContainer(request, destination, segment, hoistableState) {
      writeStartSegment(destination, request.renderState, segment.parentFormatContext, segment.id);
      flushSegment(request, destination, segment, hoistableState);
      return writeEndSegment(destination, segment.parentFormatContext);
    }
    function flushCompletedBoundary(request, destination, boundary) {
      flushedByteSize = boundary.byteSize;
      for (
        var completedSegments = boundary.completedSegments, i = 0;
        i < completedSegments.length;
        i++
      )
        flushPartiallyCompletedSegment(request, destination, boundary, completedSegments[i]);
      completedSegments.length = 0;
      completedSegments = boundary.row;
      null !== completedSegments &&
        isEligibleForOutlining(request, boundary) &&
        0 === --completedSegments.pendingTasks &&
        finishSuspenseListRow(request, completedSegments);
      writeHoistablesForBoundary(destination, boundary.contentState, request.renderState);
      completedSegments = request.resumableState;
      request = request.renderState;
      i = boundary.rootSegmentID;
      boundary = boundary.contentState;
      var requiresStyleInsertion = request.stylesToHoist;
      request.stylesToHoist = !1;
      destination.push(request.startInlineScript);
      destination.push(">");
      requiresStyleInsertion
        ? (0 === (completedSegments.instructions & 4) &&
            ((completedSegments.instructions |= 4),
            destination.push(
              '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};',
            )),
          0 === (completedSegments.instructions & 2) &&
            ((completedSegments.instructions |= 2),
            destination.push(
              '$RB=[];$RV=function(a){$RT=performance.now();for(var b=0;b<a.length;b+=2){var c=a[b],e=a[b+1];null!==e.parentNode&&e.parentNode.removeChild(e);var f=c.parentNode;if(f){var g=c.previousSibling,h=0;do{if(c&&8===c.nodeType){var d=c.data;if("/$"===d||"/&"===d)if(0===h)break;else h--;else"$"!==d&&"$?"!==d&&"$~"!==d&&"$!"!==d&&"&"!==d||h++}d=c.nextSibling;f.removeChild(c);c=d}while(c);for(;e.firstChild;)f.insertBefore(e.firstChild,c);g.data="$";g._reactRetry&&requestAnimationFrame(g._reactRetry)}}a.length=0};\n$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))?(a.previousSibling.data="$~",$RB.push(a,b),2===$RB.length&&("number"!==typeof $RT?requestAnimationFrame($RV.bind(null,$RB)):(a=performance.now(),setTimeout($RV.bind(null,$RB),2300>a&&2E3<a?2300-a:$RT+300-a)))):b.parentNode.removeChild(b)};',
            )),
          0 === (completedSegments.instructions & 8)
            ? ((completedSegments.instructions |= 8),
              destination.push(
                '$RM=new Map;$RR=function(n,w,p){function u(q){this._p=null;q()}for(var r=new Map,t=document,h,b,e=t.querySelectorAll("link[data-precedence],style[data-precedence]"),v=[],k=0;b=e[k++];)"not all"===b.getAttribute("media")?v.push(b):("LINK"===b.tagName&&$RM.set(b.getAttribute("href"),b),r.set(b.dataset.precedence,h=b));e=0;b=[];var l,a;for(k=!0;;){if(k){var f=p[e++];if(!f){k=!1;e=0;continue}var c=!1,m=0;var d=f[m++];if(a=$RM.get(d)){var g=a._p;c=!0}else{a=t.createElement("link");a.href=d;a.rel=\n"stylesheet";for(a.dataset.precedence=l=f[m++];g=f[m++];)a.setAttribute(g,f[m++]);g=a._p=new Promise(function(q,x){a.onload=u.bind(a,q);a.onerror=u.bind(a,x)});$RM.set(d,a)}d=a.getAttribute("media");!g||d&&!matchMedia(d).matches||b.push(g);if(c)continue}else{a=v[e++];if(!a)break;l=a.getAttribute("data-precedence");a.removeAttribute("media")}c=r.get(l)||h;c===h&&(h=a);r.set(l,a);c?c.parentNode.insertBefore(a,c.nextSibling):(c=t.head,c.insertBefore(a,c.firstChild))}if(p=document.getElementById(n))p.previousSibling.data=\n"$~";Promise.all(b).then($RC.bind(null,n,w),$RX.bind(null,n,"CSS failed to load"))};$RR("',
              ))
            : destination.push('$RR("'))
        : (0 === (completedSegments.instructions & 2) &&
            ((completedSegments.instructions |= 2),
            destination.push(
              '$RB=[];$RV=function(a){$RT=performance.now();for(var b=0;b<a.length;b+=2){var c=a[b],e=a[b+1];null!==e.parentNode&&e.parentNode.removeChild(e);var f=c.parentNode;if(f){var g=c.previousSibling,h=0;do{if(c&&8===c.nodeType){var d=c.data;if("/$"===d||"/&"===d)if(0===h)break;else h--;else"$"!==d&&"$?"!==d&&"$~"!==d&&"$!"!==d&&"&"!==d||h++}d=c.nextSibling;f.removeChild(c);c=d}while(c);for(;e.firstChild;)f.insertBefore(e.firstChild,c);g.data="$";g._reactRetry&&requestAnimationFrame(g._reactRetry)}}a.length=0};\n$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))?(a.previousSibling.data="$~",$RB.push(a,b),2===$RB.length&&("number"!==typeof $RT?requestAnimationFrame($RV.bind(null,$RB)):(a=performance.now(),setTimeout($RV.bind(null,$RB),2300>a&&2E3<a?2300-a:$RT+300-a)))):b.parentNode.removeChild(b)};',
            )),
          destination.push('$RC("'));
      completedSegments = i.toString(16);
      destination.push(request.boundaryPrefix);
      destination.push(completedSegments);
      destination.push('","');
      destination.push(request.segmentPrefix);
      destination.push(completedSegments);
      requiresStyleInsertion
        ? (destination.push('",'), writeStyleResourceDependenciesInJS(destination, boundary))
        : destination.push('"');
      boundary = destination.push(")<\/script>");
      return writeBootstrap(destination, request) && boundary;
    }
    function flushPartiallyCompletedSegment(request, destination, boundary, segment) {
      if (2 === segment.status) return !0;
      var hoistableState = boundary.contentState,
        segmentID = segment.id;
      if (-1 === segmentID) {
        if (-1 === (segment.id = boundary.rootSegmentID)) throw Error(formatProdErrorMessage(392));
        return flushSegmentContainer(request, destination, segment, hoistableState);
      }
      if (segmentID === boundary.rootSegmentID)
        return flushSegmentContainer(request, destination, segment, hoistableState);
      flushSegmentContainer(request, destination, segment, hoistableState);
      boundary = request.resumableState;
      request = request.renderState;
      destination.push(request.startInlineScript);
      destination.push(">");
      0 === (boundary.instructions & 1)
        ? ((boundary.instructions |= 1),
          destination.push(
            '$RS=function(a,b){a=document.getElementById(a);b=document.getElementById(b);for(a.parentNode.removeChild(a);a.firstChild;)b.parentNode.insertBefore(a.firstChild,b);b.parentNode.removeChild(b)};$RS("',
          ))
        : destination.push('$RS("');
      destination.push(request.segmentPrefix);
      segmentID = segmentID.toString(16);
      destination.push(segmentID);
      destination.push('","');
      destination.push(request.placeholderPrefix);
      destination.push(segmentID);
      destination = destination.push('")<\/script>');
      return destination;
    }
    var flushingPartialBoundaries = !1;
    function flushCompletedQueues(request, destination) {
      try {
        if (!(0 < request.pendingRootTasks)) {
          var i,
            completedRootSegment = request.completedRootSegment;
          if (null !== completedRootSegment) {
            if (5 === completedRootSegment.status) return;
            var completedPreambleSegments = request.completedPreambleSegments;
            if (null === completedPreambleSegments) return;
            flushedByteSize = request.byteSize;
            var resumableState = request.resumableState,
              renderState = request.renderState,
              preamble = renderState.preamble,
              htmlChunks = preamble.htmlChunks,
              headChunks = preamble.headChunks,
              i$jscomp$0;
            if (htmlChunks) {
              for (i$jscomp$0 = 0; i$jscomp$0 < htmlChunks.length; i$jscomp$0++)
                destination.push(htmlChunks[i$jscomp$0]);
              if (headChunks)
                for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
                  destination.push(headChunks[i$jscomp$0]);
              else {
                var chunk = startChunkForTag("head");
                destination.push(chunk);
                destination.push(">");
              }
            } else if (headChunks)
              for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
                destination.push(headChunks[i$jscomp$0]);
            var charsetChunks = renderState.charsetChunks;
            for (i$jscomp$0 = 0; i$jscomp$0 < charsetChunks.length; i$jscomp$0++)
              destination.push(charsetChunks[i$jscomp$0]);
            charsetChunks.length = 0;
            renderState.preconnects.forEach(flushResource, destination);
            renderState.preconnects.clear();
            var viewportChunks = renderState.viewportChunks;
            for (i$jscomp$0 = 0; i$jscomp$0 < viewportChunks.length; i$jscomp$0++)
              destination.push(viewportChunks[i$jscomp$0]);
            viewportChunks.length = 0;
            renderState.fontPreloads.forEach(flushResource, destination);
            renderState.fontPreloads.clear();
            renderState.highImagePreloads.forEach(flushResource, destination);
            renderState.highImagePreloads.clear();
            currentlyFlushingRenderState = renderState;
            renderState.styles.forEach(flushStylesInPreamble, destination);
            currentlyFlushingRenderState = null;
            var importMapChunks = renderState.importMapChunks;
            for (i$jscomp$0 = 0; i$jscomp$0 < importMapChunks.length; i$jscomp$0++)
              destination.push(importMapChunks[i$jscomp$0]);
            importMapChunks.length = 0;
            renderState.bootstrapScripts.forEach(flushResource, destination);
            renderState.scripts.forEach(flushResource, destination);
            renderState.scripts.clear();
            renderState.bulkPreloads.forEach(flushResource, destination);
            renderState.bulkPreloads.clear();
            resumableState.instructions |= 32;
            var hoistableChunks = renderState.hoistableChunks;
            for (i$jscomp$0 = 0; i$jscomp$0 < hoistableChunks.length; i$jscomp$0++)
              destination.push(hoistableChunks[i$jscomp$0]);
            for (
              resumableState = hoistableChunks.length = 0;
              resumableState < completedPreambleSegments.length;
              resumableState++
            ) {
              var segments = completedPreambleSegments[resumableState];
              for (renderState = 0; renderState < segments.length; renderState++)
                flushSegment(request, destination, segments[renderState], null);
            }
            var preamble$jscomp$0 = request.renderState.preamble,
              headChunks$jscomp$0 = preamble$jscomp$0.headChunks;
            if (preamble$jscomp$0.htmlChunks || headChunks$jscomp$0) {
              var chunk$jscomp$0 = endChunkForTag("head");
              destination.push(chunk$jscomp$0);
            }
            var bodyChunks = preamble$jscomp$0.bodyChunks;
            if (bodyChunks)
              for (
                completedPreambleSegments = 0;
                completedPreambleSegments < bodyChunks.length;
                completedPreambleSegments++
              )
                destination.push(bodyChunks[completedPreambleSegments]);
            flushSegment(request, destination, completedRootSegment, null);
            request.completedRootSegment = null;
            var renderState$jscomp$0 = request.renderState;
            if (
              0 !== request.allPendingTasks ||
              0 !== request.clientRenderedBoundaries.length ||
              0 !== request.completedBoundaries.length ||
              (null !== request.trackedPostpones &&
                (0 !== request.trackedPostpones.rootNodes.length ||
                  null !== request.trackedPostpones.rootSlots))
            ) {
              var resumableState$jscomp$0 = request.resumableState;
              if (0 === (resumableState$jscomp$0.instructions & 64)) {
                resumableState$jscomp$0.instructions |= 64;
                destination.push(renderState$jscomp$0.startInlineScript);
                if (0 === (resumableState$jscomp$0.instructions & 32)) {
                  resumableState$jscomp$0.instructions |= 32;
                  var shellId = "_" + resumableState$jscomp$0.idPrefix + "R_";
                  destination.push(' id="');
                  var chunk$jscomp$1 = escapeTextForBrowser(shellId);
                  destination.push(chunk$jscomp$1);
                  destination.push('"');
                }
                destination.push(">");
                destination.push("requestAnimationFrame(function(){$RT=performance.now()});");
                destination.push("<\/script>");
              }
            }
            writeBootstrap(destination, renderState$jscomp$0);
          }
          var renderState$jscomp$1 = request.renderState;
          completedRootSegment = 0;
          var viewportChunks$jscomp$0 = renderState$jscomp$1.viewportChunks;
          for (
            completedRootSegment = 0;
            completedRootSegment < viewportChunks$jscomp$0.length;
            completedRootSegment++
          )
            destination.push(viewportChunks$jscomp$0[completedRootSegment]);
          viewportChunks$jscomp$0.length = 0;
          renderState$jscomp$1.preconnects.forEach(flushResource, destination);
          renderState$jscomp$1.preconnects.clear();
          renderState$jscomp$1.fontPreloads.forEach(flushResource, destination);
          renderState$jscomp$1.fontPreloads.clear();
          renderState$jscomp$1.highImagePreloads.forEach(flushResource, destination);
          renderState$jscomp$1.highImagePreloads.clear();
          renderState$jscomp$1.styles.forEach(preloadLateStyles, destination);
          renderState$jscomp$1.scripts.forEach(flushResource, destination);
          renderState$jscomp$1.scripts.clear();
          renderState$jscomp$1.bulkPreloads.forEach(flushResource, destination);
          renderState$jscomp$1.bulkPreloads.clear();
          var hoistableChunks$jscomp$0 = renderState$jscomp$1.hoistableChunks;
          for (
            completedRootSegment = 0;
            completedRootSegment < hoistableChunks$jscomp$0.length;
            completedRootSegment++
          )
            destination.push(hoistableChunks$jscomp$0[completedRootSegment]);
          hoistableChunks$jscomp$0.length = 0;
          var clientRenderedBoundaries = request.clientRenderedBoundaries;
          for (i = 0; i < clientRenderedBoundaries.length; i++) {
            var boundary = clientRenderedBoundaries[i];
            renderState$jscomp$1 = destination;
            var resumableState$jscomp$1 = request.resumableState,
              renderState$jscomp$2 = request.renderState,
              id = boundary.rootSegmentID,
              errorDigest = boundary.errorDigest;
            renderState$jscomp$1.push(renderState$jscomp$2.startInlineScript);
            renderState$jscomp$1.push(">");
            0 === (resumableState$jscomp$1.instructions & 4)
              ? ((resumableState$jscomp$1.instructions |= 4),
                renderState$jscomp$1.push(
                  '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};;$RX("',
                ))
              : renderState$jscomp$1.push('$RX("');
            renderState$jscomp$1.push(renderState$jscomp$2.boundaryPrefix);
            var chunk$jscomp$2 = id.toString(16);
            renderState$jscomp$1.push(chunk$jscomp$2);
            renderState$jscomp$1.push('"');
            if (errorDigest) {
              renderState$jscomp$1.push(",");
              var chunk$jscomp$3 = escapeJSStringsForInstructionScripts(errorDigest || "");
              renderState$jscomp$1.push(chunk$jscomp$3);
            }
            var JSCompiler_inline_result = renderState$jscomp$1.push(")<\/script>");
            if (!JSCompiler_inline_result) {
              request.destination = null;
              i++;
              clientRenderedBoundaries.splice(0, i);
              return;
            }
          }
          clientRenderedBoundaries.splice(0, i);
          var completedBoundaries = request.completedBoundaries;
          for (i = 0; i < completedBoundaries.length; i++)
            if (!flushCompletedBoundary(request, destination, completedBoundaries[i])) {
              request.destination = null;
              i++;
              completedBoundaries.splice(0, i);
              return;
            }
          completedBoundaries.splice(0, i);
          flushingPartialBoundaries = !0;
          var partialBoundaries = request.partialBoundaries;
          for (i = 0; i < partialBoundaries.length; i++) {
            var boundary$69 = partialBoundaries[i];
            a: {
              clientRenderedBoundaries = request;
              boundary = destination;
              flushedByteSize = boundary$69.byteSize;
              var completedSegments = boundary$69.completedSegments;
              for (
                JSCompiler_inline_result = 0;
                JSCompiler_inline_result < completedSegments.length;
                JSCompiler_inline_result++
              )
                if (
                  !flushPartiallyCompletedSegment(
                    clientRenderedBoundaries,
                    boundary,
                    boundary$69,
                    completedSegments[JSCompiler_inline_result],
                  )
                ) {
                  JSCompiler_inline_result++;
                  completedSegments.splice(0, JSCompiler_inline_result);
                  var JSCompiler_inline_result$jscomp$0 = !1;
                  break a;
                }
              completedSegments.splice(0, JSCompiler_inline_result);
              var row = boundary$69.row;
              null !== row &&
                row.together &&
                1 === boundary$69.pendingTasks &&
                (1 === row.pendingTasks
                  ? unblockSuspenseListRow(clientRenderedBoundaries, row, row.hoistables)
                  : row.pendingTasks--);
              JSCompiler_inline_result$jscomp$0 = writeHoistablesForBoundary(
                boundary,
                boundary$69.contentState,
                clientRenderedBoundaries.renderState,
              );
            }
            if (!JSCompiler_inline_result$jscomp$0) {
              request.destination = null;
              i++;
              partialBoundaries.splice(0, i);
              return;
            }
          }
          partialBoundaries.splice(0, i);
          flushingPartialBoundaries = !1;
          var largeBoundaries = request.completedBoundaries;
          for (i = 0; i < largeBoundaries.length; i++)
            if (!flushCompletedBoundary(request, destination, largeBoundaries[i])) {
              request.destination = null;
              i++;
              largeBoundaries.splice(0, i);
              return;
            }
          largeBoundaries.splice(0, i);
        }
      } finally {
        ((flushingPartialBoundaries = !1),
          0 === request.allPendingTasks &&
            0 === request.clientRenderedBoundaries.length &&
            0 === request.completedBoundaries.length &&
            ((request.flushScheduled = !1),
            (i = request.resumableState),
            i.hasBody &&
              ((partialBoundaries = endChunkForTag("body")), destination.push(partialBoundaries)),
            i.hasHtml && ((i = endChunkForTag("html")), destination.push(i)),
            (request.status = 14),
            destination.push(null),
            (request.destination = null)));
      }
    }
    function enqueueFlush(request) {
      if (
        !1 === request.flushScheduled &&
        0 === request.pingedTasks.length &&
        null !== request.destination
      ) {
        request.flushScheduled = !0;
        var destination = request.destination;
        destination ? flushCompletedQueues(request, destination) : (request.flushScheduled = !1);
      }
    }
    function startFlowing(request, destination) {
      if (13 === request.status) ((request.status = 14), destination.destroy(request.fatalError));
      else if (14 !== request.status && null === request.destination) {
        request.destination = destination;
        try {
          flushCompletedQueues(request, destination);
        } catch (error) {
          (logRecoverableError(request, error, {}), fatalError(request, error));
        }
      }
    }
    function abort(request, reason) {
      if (11 === request.status || 10 === request.status) request.status = 12;
      try {
        var abortableTasks = request.abortableTasks;
        if (0 < abortableTasks.size) {
          var error =
            void 0 === reason
              ? Error(formatProdErrorMessage(432))
              : "object" === typeof reason && null !== reason && "function" === typeof reason.then
                ? Error(formatProdErrorMessage(530))
                : reason;
          request.fatalError = error;
          abortableTasks.forEach(function (task) {
            return abortTask(task, request, error);
          });
          abortableTasks.clear();
        }
        null !== request.destination && flushCompletedQueues(request, request.destination);
      } catch (error$71) {
        (logRecoverableError(request, error$71, {}), fatalError(request, error$71));
      }
    }
    function addToReplayParent(node, parentKeyPath, trackedPostpones) {
      if (null === parentKeyPath) trackedPostpones.rootNodes.push(node);
      else {
        var workingMap = trackedPostpones.workingMap,
          parentNode = workingMap.get(parentKeyPath);
        void 0 === parentNode &&
          ((parentNode = [parentKeyPath[1], parentKeyPath[2], [], null]),
          workingMap.set(parentKeyPath, parentNode),
          addToReplayParent(parentNode, parentKeyPath[0], trackedPostpones));
        parentNode[2].push(node);
      }
    }
    function onError() {}
    function renderToStringImpl(children, options, generateStaticMarkup, abortReason) {
      var didFatal = !1,
        fatalError = null,
        result = "",
        readyToStream = !1;
      options = createResumableState(options ? options.identifierPrefix : void 0);
      children = createRequest(
        children,
        options,
        createRenderState(options, generateStaticMarkup),
        createFormatContext(0, null, 0, null),
        Infinity,
        onError,
        void 0,
        function () {
          readyToStream = !0;
        },
        void 0,
        void 0,
        void 0,
      );
      children.flushScheduled = null !== children.destination;
      performWork(children);
      10 === children.status && (children.status = 11);
      null === children.trackedPostpones &&
        safelyEmitEarlyPreloads(children, 0 === children.pendingRootTasks);
      abort(children, abortReason);
      startFlowing(children, {
        push: function (chunk) {
          null !== chunk && (result += chunk);
          return !0;
        },
        destroy: function (error) {
          didFatal = !0;
          fatalError = error;
        },
      });
      if (didFatal && fatalError !== abortReason) throw fatalError;
      if (!readyToStream) throw Error(formatProdErrorMessage(426));
      return result;
    }
    exports.renderToStaticMarkup = function (children, options) {
      return renderToStringImpl(
        children,
        options,
        !0,
        'The server used "renderToStaticMarkup" which does not support Suspense. If you intended to have the server wait for the suspended component please switch to "renderToReadableStream" which supports Suspense on the server',
      );
    };
    exports.renderToString = function (children, options) {
      return renderToStringImpl(
        children,
        options,
        !1,
        'The server used "renderToString" which does not support Suspense. If you intended for this Suspense boundary to render the fallback content on the server consider throwing an Error somewhere within the Suspense boundary. If you intended to have the server wait for the suspended component please switch to "renderToReadableStream" which supports Suspense on the server',
      );
    };
    exports.version = "19.2.5";
  },
);
//#endregion
//#region node_modules/react-dom/server.edge.js
var require_server_edge = /* @__PURE__ */ __commonJSMin((exports) => {
  var b;
  var l;
  b = require_react_dom_server_edge_production();
  l = require_react_dom_server_legacy_browser_production();
  exports.version = b.version;
  exports.renderToReadableStream = b.renderToReadableStream;
  exports.renderToString = l.renderToString;
  exports.renderToStaticMarkup = l.renderToStaticMarkup;
  exports.resume = b.resume;
});
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/ssr-match-id.js
function dehydrateSsrMatchId(id) {
  return id.replaceAll("/", "\0");
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/tsrScript.js
var tsrScript_default =
  "self.$_TSR={h(){this.hydrated=!0,this.c()},e(){this.streamEnded=!0,this.c()},c(){this.hydrated&&this.streamEnded&&(delete self.$_TSR,delete self.$R.tsr)},p(e){this.initialized?e():this.buffer.push(e)},buffer:[]}";
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/ssr-server.js
var SCOPE_ID = "tsr";
var TSR_PREFIX = GLOBAL_TSR + ".router=";
var P_PREFIX = GLOBAL_TSR + ".p(()=>";
var P_SUFFIX = ")";
function dehydrateMatch(match) {
  const dehydratedMatch = {
    i: dehydrateSsrMatchId(match.id),
    u: match.updatedAt,
    s: match.status,
  };
  for (const [key, shorthand] of [
    ["__beforeLoadContext", "b"],
    ["loaderData", "l"],
    ["error", "e"],
    ["ssr", "ssr"],
  ])
    if (match[key] !== void 0) dehydratedMatch[shorthand] = match[key];
  if (match.globalNotFound) dehydratedMatch.g = true;
  return dehydratedMatch;
}
var INITIAL_SCRIPTS = [mn(SCOPE_ID), tsrScript_default];
var ScriptBuffer = class {
  constructor(router) {
    this._scriptBarrierLifted = false;
    this._cleanedUp = false;
    this._pendingMicrotask = false;
    this.router = router;
    this._queue = INITIAL_SCRIPTS.slice();
  }
  enqueue(script) {
    if (this._cleanedUp) return;
    this._queue.push(script);
    if (this._scriptBarrierLifted && !this._pendingMicrotask) {
      this._pendingMicrotask = true;
      queueMicrotask(() => {
        this._pendingMicrotask = false;
        this.injectBufferedScripts();
      });
    }
  }
  liftBarrier() {
    if (this._scriptBarrierLifted || this._cleanedUp) return;
    this._scriptBarrierLifted = true;
    if (this._queue.length > 0 && !this._pendingMicrotask) {
      this._pendingMicrotask = true;
      queueMicrotask(() => {
        this._pendingMicrotask = false;
        this.injectBufferedScripts();
      });
    }
  }
  /**
   * Flushes any pending scripts synchronously.
   * Call this before emitting onSerializationFinished to ensure all scripts are injected.
   *
   * IMPORTANT: Only injects if the barrier has been lifted. Before the barrier is lifted,
   * scripts should remain in the queue so takeBufferedScripts() can retrieve them
   */
  flush() {
    if (!this._scriptBarrierLifted) return;
    if (this._cleanedUp) return;
    this._pendingMicrotask = false;
    const scriptsToInject = this.takeAll();
    if (scriptsToInject && this.router?.serverSsr)
      this.router.serverSsr.injectScript(scriptsToInject);
  }
  takeAll() {
    const bufferedScripts = this._queue;
    this._queue = [];
    if (bufferedScripts.length === 0) return;
    if (bufferedScripts.length === 1)
      return bufferedScripts[0] + ";document.currentScript.remove()";
    return bufferedScripts.join(";") + ";document.currentScript.remove()";
  }
  injectBufferedScripts() {
    if (this._cleanedUp) return;
    if (this._queue.length === 0) return;
    const scriptsToInject = this.takeAll();
    if (scriptsToInject && this.router?.serverSsr)
      this.router.serverSsr.injectScript(scriptsToInject);
  }
  cleanup() {
    this._cleanedUp = true;
    this._queue = [];
    this.router = void 0;
  }
};
var isProd = true;
var MANIFEST_CACHE_SIZE = 100;
var manifestCaches = /* @__PURE__ */ new WeakMap();
function getManifestCache(manifest) {
  const cache = manifestCaches.get(manifest);
  if (cache) return cache;
  const newCache = createLRUCache(MANIFEST_CACHE_SIZE);
  manifestCaches.set(manifest, newCache);
  return newCache;
}
function attachRouterServerSsrUtils({
  router,
  manifest,
  getRequestAssets,
  includeUnmatchedRouteAssets = true,
}) {
  router.ssr = {
    get manifest() {
      const requestAssets = getRequestAssets?.();
      if (!requestAssets?.length) return manifest;
      return {
        ...manifest,
        routes: {
          ...manifest?.routes,
          [rootRouteId]: {
            ...manifest?.routes?.[rootRouteId],
            assets: [...requestAssets, ...(manifest?.routes?.["__root__"]?.assets ?? [])],
          },
        },
      };
    },
  };
  let _dehydrated = false;
  let _serializationFinished = false;
  const renderFinishedListeners = [];
  const serializationFinishedListeners = [];
  const scriptBuffer = new ScriptBuffer(router);
  let injectedHtmlBuffer = "";
  router.serverSsr = {
    injectHtml: (html) => {
      if (!html) return;
      injectedHtmlBuffer += html;
      router.emit({ type: "onInjectedHtml" });
    },
    injectScript: (script) => {
      if (!script) return;
      const html = `<script${router.options.ssr?.nonce ? ` nonce='${router.options.ssr.nonce}'` : ""}>${script}<\/script>`;
      router.serverSsr.injectHtml(html);
    },
    dehydrate: async (opts) => {
      if (_dehydrated) invariant();
      let matchesToDehydrate = router.stores.matches.get();
      if (router.isShell()) matchesToDehydrate = matchesToDehydrate.slice(0, 1);
      const matches = matchesToDehydrate.map(dehydrateMatch);
      let manifestToDehydrate = void 0;
      if (manifest) {
        const currentRouteIdsList = matchesToDehydrate.map((m) => m.routeId);
        const manifestCacheKey = `${currentRouteIdsList.join("\0")}\0includeUnmatchedRouteAssets=${includeUnmatchedRouteAssets}`;
        let filteredRoutes;
        if (isProd) filteredRoutes = getManifestCache(manifest).get(manifestCacheKey);
        if (!filteredRoutes) {
          const currentRouteIds = new Set(currentRouteIdsList);
          const nextFilteredRoutes = {};
          for (const routeId in manifest.routes) {
            const routeManifest = manifest.routes[routeId];
            if (currentRouteIds.has(routeId)) nextFilteredRoutes[routeId] = routeManifest;
            else if (
              includeUnmatchedRouteAssets &&
              routeManifest.assets &&
              routeManifest.assets.length > 0
            )
              nextFilteredRoutes[routeId] = { assets: routeManifest.assets };
          }
          if (isProd) getManifestCache(manifest).set(manifestCacheKey, nextFilteredRoutes);
          filteredRoutes = nextFilteredRoutes;
        }
        manifestToDehydrate = { routes: filteredRoutes };
        if (opts?.requestAssets?.length) {
          const existingRoot = manifestToDehydrate.routes[rootRouteId];
          manifestToDehydrate.routes[rootRouteId] = {
            ...existingRoot,
            assets: [...opts.requestAssets, ...(existingRoot?.assets ?? [])],
          };
        }
      }
      const dehydratedRouter = {
        manifest: manifestToDehydrate,
        matches,
      };
      const lastMatchId = matchesToDehydrate[matchesToDehydrate.length - 1]?.id;
      if (lastMatchId) dehydratedRouter.lastMatchId = dehydrateSsrMatchId(lastMatchId);
      const dehydratedData = await router.options.dehydrate?.();
      if (dehydratedData) dehydratedRouter.dehydratedData = dehydratedData;
      _dehydrated = true;
      const trackPlugins = { didRun: false };
      const serializationAdapters = router.options.serializationAdapters;
      const plugins = serializationAdapters
        ? serializationAdapters
            .map((t) => /* @__PURE__ */ makeSsrSerovalPlugin(t, trackPlugins))
            .concat(defaultSerovalPlugins)
        : defaultSerovalPlugins;
      const signalSerializationComplete = () => {
        _serializationFinished = true;
        try {
          serializationFinishedListeners.forEach((l) => l());
          router.emit({ type: "onSerializationFinished" });
        } catch (err) {
          console.error("Serialization listener error:", err);
        } finally {
          serializationFinishedListeners.length = 0;
          renderFinishedListeners.length = 0;
        }
      };
      cn(dehydratedRouter, {
        refs: /* @__PURE__ */ new Map(),
        plugins,
        onSerialize: (data, initial) => {
          let serialized = initial ? TSR_PREFIX + data : data;
          if (trackPlugins.didRun) serialized = P_PREFIX + serialized + P_SUFFIX;
          scriptBuffer.enqueue(serialized);
        },
        onError: (err) => {
          console.error("Serialization error:", err);
          if (err && err.stack) console.error(err.stack);
          signalSerializationComplete();
        },
        scopeId: SCOPE_ID,
        onDone: () => {
          scriptBuffer.enqueue(GLOBAL_TSR + ".e()");
          scriptBuffer.flush();
          signalSerializationComplete();
        },
      });
    },
    isDehydrated() {
      return _dehydrated;
    },
    isSerializationFinished() {
      return _serializationFinished;
    },
    onRenderFinished: (listener) => renderFinishedListeners.push(listener),
    onSerializationFinished: (listener) => serializationFinishedListeners.push(listener),
    setRenderFinished: () => {
      try {
        renderFinishedListeners.forEach((l) => l());
      } catch (err) {
        console.error("Error in render finished listener:", err);
      } finally {
        renderFinishedListeners.length = 0;
      }
      scriptBuffer.liftBarrier();
    },
    takeBufferedScripts() {
      const scripts = scriptBuffer.takeAll();
      return {
        tag: "script",
        attrs: {
          nonce: router.options.ssr?.nonce,
          className: "$tsr",
          id: TSR_SCRIPT_BARRIER_ID,
        },
        children: scripts,
      };
    },
    liftScriptBarrier() {
      scriptBuffer.liftBarrier();
    },
    takeBufferedHtml() {
      if (!injectedHtmlBuffer) return;
      const buffered = injectedHtmlBuffer;
      injectedHtmlBuffer = "";
      return buffered;
    },
    cleanup() {
      if (!router.serverSsr) return;
      renderFinishedListeners.length = 0;
      serializationFinishedListeners.length = 0;
      injectedHtmlBuffer = "";
      scriptBuffer.cleanup();
      router.serverSsr = void 0;
    },
  };
}
/**
 * Get the origin for the request.
 *
 * SECURITY: We intentionally do NOT trust the Origin header for determining
 * the router's origin. The Origin header can be spoofed by attackers, which
 * could lead to SSRF-like vulnerabilities where redirects are constructed
 * using a malicious origin (CVE-2024-34351).
 *
 * Instead, we derive the origin from request.url, which is typically set by
 * the server infrastructure (not client-controlled headers).
 *
 * For applications behind proxies that need to trust forwarded headers,
 * use the router's `origin` option to explicitly configure a trusted origin.
 */
function getOrigin(request) {
  try {
    return new URL(request.url).origin;
  } catch {}
  return "http://localhost";
}
function getNormalizedURL(url, base) {
  if (typeof url === "string") url = url.replace("\\", "%5C");
  const rawUrl = new URL(url, base);
  const { path: decodedPathname, handledProtocolRelativeURL } = decodePath(rawUrl.pathname);
  const searchParams = new URLSearchParams(rawUrl.search);
  const normalizedHref =
    decodedPathname + (searchParams.size > 0 ? "?" : "") + searchParams.toString() + rawUrl.hash;
  return {
    url: new URL(normalizedHref, rawUrl.origin),
    handledProtocolRelativeURL,
  };
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/handlerCallback.js
function defineHandlerCallback(handler) {
  return handler;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/transformStreamWithRouter.js
function transformReadableStreamWithRouter(router, routerStream) {
  return transformStreamWithRouter(router, routerStream);
}
function transformPipeableStreamWithRouter(router, routerStream) {
  return Readable.fromWeb(transformStreamWithRouter(router, Readable.toWeb(routerStream)));
}
var BODY_END_TAG = "</body>";
var HTML_END_TAG = "</html>";
var MIN_CLOSING_TAG_LENGTH = 4;
var DEFAULT_SERIALIZATION_TIMEOUT_MS = 6e4;
var DEFAULT_LIFETIME_TIMEOUT_MS = 6e4;
var textEncoder$1 = new TextEncoder();
/**
 * Finds the position just after the last valid HTML closing tag in the string.
 *
 * Valid closing tags match the pattern: </[a-zA-Z][\w:.-]*>
 * Examples: </div>, </my-component>, </slot:name.nested>
 *
 * @returns Position after the last closing tag, or -1 if none found
 */
function findLastClosingTagEnd(str) {
  const len = str.length;
  if (len < MIN_CLOSING_TAG_LENGTH) return -1;
  let i = len - 1;
  while (i >= MIN_CLOSING_TAG_LENGTH - 1) {
    if (str.charCodeAt(i) === 62) {
      let j = i - 1;
      while (j >= 1) {
        const code = str.charCodeAt(j);
        if (
          (code >= 97 && code <= 122) ||
          (code >= 65 && code <= 90) ||
          (code >= 48 && code <= 57) ||
          code === 95 ||
          code === 58 ||
          code === 46 ||
          code === 45
        )
          j--;
        else break;
      }
      const tagNameStart = j + 1;
      if (tagNameStart < i) {
        const startCode = str.charCodeAt(tagNameStart);
        if ((startCode >= 97 && startCode <= 122) || (startCode >= 65 && startCode <= 90)) {
          if (j >= 1 && str.charCodeAt(j) === 47 && str.charCodeAt(j - 1) === 60) return i + 1;
        }
      }
    }
    i--;
  }
  return -1;
}
function transformStreamWithRouter(router, appStream, opts) {
  const serializationAlreadyFinished = router.serverSsr?.isSerializationFinished() ?? false;
  const initialBufferedHtml = router.serverSsr?.takeBufferedHtml();
  if (serializationAlreadyFinished && !initialBufferedHtml) {
    let cleanedUp = false;
    let controller;
    let isStreamClosed = false;
    let lifetimeTimeoutHandle;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (lifetimeTimeoutHandle !== void 0) {
        clearTimeout(lifetimeTimeoutHandle);
        lifetimeTimeoutHandle = void 0;
      }
      router.serverSsr?.cleanup();
    };
    const safeClose = () => {
      if (isStreamClosed) return;
      isStreamClosed = true;
      try {
        controller?.close();
      } catch {}
    };
    const safeError = (error) => {
      if (isStreamClosed) return;
      isStreamClosed = true;
      try {
        controller?.error(error);
      } catch {}
    };
    const lifetimeMs = opts?.lifetimeMs ?? DEFAULT_LIFETIME_TIMEOUT_MS;
    lifetimeTimeoutHandle = setTimeout(() => {
      if (!cleanedUp && !isStreamClosed) {
        console.warn(
          `SSR stream transform exceeded maximum lifetime (${lifetimeMs}ms), forcing cleanup`,
        );
        safeError(/* @__PURE__ */ new Error("Stream lifetime exceeded"));
        cleanup();
      }
    }, lifetimeMs);
    const stream = new ReadableStream$1({
      start(c) {
        controller = c;
      },
      cancel() {
        isStreamClosed = true;
        cleanup();
      },
    });
    (async () => {
      const reader = appStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cleanedUp || isStreamClosed) return;
          controller?.enqueue(value);
        }
        if (cleanedUp || isStreamClosed) return;
        router.serverSsr?.setRenderFinished();
        safeClose();
        cleanup();
      } catch (error) {
        if (cleanedUp) return;
        console.error("Error reading appStream:", error);
        router.serverSsr?.setRenderFinished();
        safeError(error);
        cleanup();
      } finally {
        reader.releaseLock();
      }
    })().catch((error) => {
      if (cleanedUp) return;
      console.error("Error in stream transform:", error);
      safeError(error);
      cleanup();
    });
    return stream;
  }
  let stopListeningToInjectedHtml;
  let stopListeningToSerializationFinished;
  let serializationTimeoutHandle;
  let lifetimeTimeoutHandle;
  let cleanedUp = false;
  let controller;
  let isStreamClosed = false;
  const textDecoder = new TextDecoder();
  let pendingRouterHtml = initialBufferedHtml ?? "";
  let leftover = "";
  let pendingClosingTags = "";
  const MAX_LEFTOVER_CHARS = 2048;
  let isAppRendering = true;
  let streamBarrierLifted = false;
  let serializationFinished = serializationAlreadyFinished;
  function safeEnqueue(chunk) {
    if (isStreamClosed) return;
    if (typeof chunk === "string") controller.enqueue(textEncoder$1.encode(chunk));
    else controller.enqueue(chunk);
  }
  function safeClose() {
    if (isStreamClosed) return;
    isStreamClosed = true;
    try {
      controller.close();
    } catch {}
  }
  function safeError(error) {
    if (isStreamClosed) return;
    isStreamClosed = true;
    try {
      controller.error(error);
    } catch {}
  }
  /**
   * Cleanup with guards; must be idempotent.
   */
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      stopListeningToInjectedHtml?.();
      stopListeningToSerializationFinished?.();
    } catch {}
    stopListeningToInjectedHtml = void 0;
    stopListeningToSerializationFinished = void 0;
    if (serializationTimeoutHandle !== void 0) {
      clearTimeout(serializationTimeoutHandle);
      serializationTimeoutHandle = void 0;
    }
    if (lifetimeTimeoutHandle !== void 0) {
      clearTimeout(lifetimeTimeoutHandle);
      lifetimeTimeoutHandle = void 0;
    }
    pendingRouterHtml = "";
    leftover = "";
    pendingClosingTags = "";
    router.serverSsr?.cleanup();
  }
  const stream = new ReadableStream$1({
    start(c) {
      controller = c;
    },
    cancel() {
      isStreamClosed = true;
      cleanup();
    },
  });
  function flushPendingRouterHtml() {
    if (!pendingRouterHtml) return;
    safeEnqueue(pendingRouterHtml);
    pendingRouterHtml = "";
  }
  function appendRouterHtml(html) {
    if (!html) return;
    pendingRouterHtml += html;
  }
  /**
   * Finish only when app done and serialization complete.
   */
  function tryFinish() {
    if (isAppRendering || !serializationFinished) return;
    if (cleanedUp || isStreamClosed) return;
    if (serializationTimeoutHandle !== void 0) {
      clearTimeout(serializationTimeoutHandle);
      serializationTimeoutHandle = void 0;
    }
    const decoderRemainder = textDecoder.decode();
    if (leftover) safeEnqueue(leftover);
    if (decoderRemainder) safeEnqueue(decoderRemainder);
    flushPendingRouterHtml();
    if (pendingClosingTags) safeEnqueue(pendingClosingTags);
    safeClose();
    cleanup();
  }
  const lifetimeMs = opts?.lifetimeMs ?? DEFAULT_LIFETIME_TIMEOUT_MS;
  lifetimeTimeoutHandle = setTimeout(() => {
    if (!cleanedUp && !isStreamClosed) {
      console.warn(
        `SSR stream transform exceeded maximum lifetime (${lifetimeMs}ms), forcing cleanup`,
      );
      safeError(/* @__PURE__ */ new Error("Stream lifetime exceeded"));
      cleanup();
    }
  }, lifetimeMs);
  if (!serializationAlreadyFinished) {
    stopListeningToInjectedHtml = router.subscribe("onInjectedHtml", () => {
      if (cleanedUp || isStreamClosed) return;
      const html = router.serverSsr?.takeBufferedHtml();
      if (!html) return;
      if (isAppRendering || leftover || pendingClosingTags) appendRouterHtml(html);
      else {
        flushPendingRouterHtml();
        safeEnqueue(html);
      }
    });
    stopListeningToSerializationFinished = router.subscribe("onSerializationFinished", () => {
      serializationFinished = true;
      tryFinish();
    });
  }
  (async () => {
    const reader = appStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (cleanedUp || isStreamClosed) return;
        const text =
          value instanceof Uint8Array ? textDecoder.decode(value, { stream: true }) : String(value);
        const chunkString = leftover ? leftover + text : text;
        if (!streamBarrierLifted) {
          if (chunkString.includes("$tsr-stream-barrier")) {
            streamBarrierLifted = true;
            router.serverSsr?.liftScriptBarrier();
          }
        }
        if (pendingClosingTags) {
          pendingClosingTags += chunkString;
          leftover = "";
          continue;
        }
        const bodyEndIndex = chunkString.indexOf(BODY_END_TAG);
        const htmlEndIndex = chunkString.indexOf(HTML_END_TAG);
        if (bodyEndIndex !== -1 && htmlEndIndex !== -1 && bodyEndIndex < htmlEndIndex) {
          pendingClosingTags = chunkString.slice(bodyEndIndex);
          safeEnqueue(chunkString.slice(0, bodyEndIndex));
          flushPendingRouterHtml();
          leftover = "";
          continue;
        }
        const lastClosingTagEnd = findLastClosingTagEnd(chunkString);
        if (lastClosingTagEnd > 0) {
          safeEnqueue(chunkString.slice(0, lastClosingTagEnd));
          flushPendingRouterHtml();
          leftover = chunkString.slice(lastClosingTagEnd);
          if (leftover.length > MAX_LEFTOVER_CHARS) {
            safeEnqueue(leftover.slice(0, leftover.length - MAX_LEFTOVER_CHARS));
            leftover = leftover.slice(-MAX_LEFTOVER_CHARS);
          }
        } else {
          const combined = chunkString;
          if (combined.length > MAX_LEFTOVER_CHARS) {
            const flushUpto = combined.length - MAX_LEFTOVER_CHARS;
            safeEnqueue(combined.slice(0, flushUpto));
            leftover = combined.slice(flushUpto);
          } else leftover = combined;
        }
      }
      if (cleanedUp || isStreamClosed) return;
      isAppRendering = false;
      router.serverSsr?.setRenderFinished();
      if (serializationFinished) tryFinish();
      else {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_SERIALIZATION_TIMEOUT_MS;
        serializationTimeoutHandle = setTimeout(() => {
          if (!cleanedUp && !isStreamClosed) {
            console.error("Serialization timeout after app render finished");
            safeError(/* @__PURE__ */ new Error("Serialization timeout after app render finished"));
            cleanup();
          }
        }, timeoutMs);
      }
    } catch (error) {
      if (cleanedUp) return;
      console.error("Error reading appStream:", error);
      isAppRendering = false;
      router.serverSsr?.setRenderFinished();
      safeError(error);
      cleanup();
    } finally {
      reader.releaseLock();
    }
  })().catch((error) => {
    if (cleanedUp) return;
    console.error("Error in stream transform:", error);
    safeError(error);
    cleanup();
  });
  return stream;
}
//#endregion
//#region node_modules/isbot/index.mjs
var fullPattern =
  " daum[ /]| deusu/|(?:^|[^g])news(?!sapphire)|(?<! (?:channel/|google/))google(?!(app|/google| pixel))|(?<! cu)bots?(?:\\b|_)|(?<!(?:lib))http|(?<!cam)scan|24x7|@[a-z][\\w-]+\\.|\\(\\)|\\.com\\b|\\b\\w+\\.ai|\\bcursor/|\\bmanus-user/|\\bort/|\\bperl\\b|\\bplaywright\\b|\\bsecurityheaders\\b|\\bselenium\\b|\\btime/|\\||^[\\w \\.\\-\\(?:\\):%]+(?:/v?\\d+(?:\\.\\d+)?(?:\\.\\d{1,10})*?)?(?:,|$)|^[\\w\\-]+/[\\w]+$|^[^ ]{50,}$|^\\d+\\b|^\\W|^\\w*search\\b|^\\w+/[\\w\\(\\)]*$|^\\w+/\\d\\.\\d\\s\\([\\w@]+\\)$|^active|^ad muncher|^amaya|^apache/|^avsdevicesdk/|^azure|^biglotron|^bot|^bw/|^clamav[ /]|^claude-code/|^client/|^cobweb/|^custom|^ddg[_-]android|^discourse|^dispatch/\\d|^downcast/|^duckduckgo|^email|^facebook|^getright/|^gozilla/|^hobbit|^hotzonu|^hwcdn/|^igetter/|^jeode/|^jetty/|^jigsaw|^microsoft bits|^movabletype|^mozilla/\\d\\.\\d\\s[\\w\\.-]+$|^mozilla/\\d\\.\\d\\s\\((?:compatible;)?(?:\\s?[\\w\\d-.]+\\/\\d+\\.\\d+)?\\)$|^navermailapp|^netsurf|^offline|^openai/|^owler|^php|^postman|^python|^rank|^read|^reed|^rest|^rss|^snapchat|^space bison|^svn|^swcd |^taringa|^thumbor/|^track|^w3c|^webbandit/|^webcopier|^wget|^whatsapp|^wordpress|^xenu link sleuth|^yahoo|^yandex|^zdm/\\d|^zoom marketplace/|advisor|agent\\b|analyzer|archive|ask jeeves/teoma|audit|bit\\.ly/|bluecoat drtr|browsex|burpcollaborator|capture|catch|check\\b|checker|chrome-lighthouse|chromeframe|classifier|cloudflare|convertify|crawl|cypress/|dareboost|datanyze|dejaclick|detect|dmbrowser|download|exaleadcloudview|feed|fetcher|firephp|functionize|grab|headless|httrack|hubspot marketing grader|ibisbrowser|infrawatch|insight|inspect|iplabel|java(?!;)|library|linkcheck|mail\\.ru/|manager|measure|monitor\\b|neustar wpm|node\\b|nutch|offbyone|onetrust|optimize|pageburst|pagespeed|parser|phantomjs|pingdom|powermarks|preview|proxy|ptst[ /]\\d|retriever|rexx;|rigor|rss\\b|scrape|server|sogou|sparkler/|speedcurve|spider|splash|statuscake|supercleaner|synapse|synthetic|tools|torrent|transcoder|url|validator|virtuoso|wappalyzer|webglance|webkit2png|whatcms/|xtate/";
var naivePattern = /bot|crawl|http|lighthouse|scan|search|spider/i;
var pattern;
function getPattern() {
  if (pattern instanceof RegExp) return pattern;
  try {
    pattern = new RegExp(fullPattern, "i");
  } catch (error) {
    pattern = naivePattern;
  }
  return pattern;
}
var isNonEmptyString = (value) => typeof value === "string" && value !== "";
function isbot(userAgent) {
  return isNonEmptyString(userAgent) && getPattern().test(userAgent);
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/ssr/renderRouterToStream.js
var import_server_edge = /* @__PURE__ */ __toESM(require_server_edge(), 1);
var renderRouterToStream = async ({ request, router, responseHeaders, children }) => {
  if (typeof import_server_edge.renderToReadableStream === "function") {
    const stream = await import_server_edge.renderToReadableStream(children, {
      signal: request.signal,
      nonce: router.options.ssr?.nonce,
      progressiveChunkSize: Number.POSITIVE_INFINITY,
    });
    if (isbot(request.headers.get("User-Agent"))) await stream.allReady;
    const responseStream = transformReadableStreamWithRouter(router, stream);
    return new Response(responseStream, {
      status: router.stores.statusCode.get(),
      headers: responseHeaders,
    });
  }
  if (typeof import_server_edge.default.renderToPipeableStream === "function") {
    const reactAppPassthrough = new PassThrough();
    try {
      const pipeable = import_server_edge.default.renderToPipeableStream(children, {
        nonce: router.options.ssr?.nonce,
        progressiveChunkSize: Number.POSITIVE_INFINITY,
        ...(isbot(request.headers.get("User-Agent"))
          ? {
              onAllReady() {
                pipeable.pipe(reactAppPassthrough);
              },
            }
          : {
              onShellReady() {
                pipeable.pipe(reactAppPassthrough);
              },
            }),
        onError: (error, info) => {
          console.error("Error in renderToPipeableStream:", error, info);
          if (!reactAppPassthrough.destroyed)
            reactAppPassthrough.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      });
    } catch (e) {
      console.error("Error in renderToPipeableStream:", e);
      reactAppPassthrough.destroy(e instanceof Error ? e : new Error(String(e)));
    }
    const responseStream = transformPipeableStreamWithRouter(router, reactAppPassthrough);
    return new Response(responseStream, {
      status: router.stores.statusCode.get(),
      headers: responseHeaders,
    });
  }
  throw new Error(
    "No renderToReadableStream or renderToPipeableStream found in react-dom/server. Ensure you are using a version of react-dom that supports streaming.",
  );
};
//#endregion
//#region node_modules/@tanstack/react-start-server/dist/esm/defaultStreamHandler.js
var defaultStreamHandler = defineHandlerCallback(({ request, router, responseHeaders }) =>
  renderRouterToStream({
    request,
    router,
    responseHeaders,
    children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StartServer, { router }),
  }),
);
//#endregion
//#region node_modules/rou3/dist/index.mjs
var NullProtoObj = /* @__PURE__ */ (() => {
  const e = function () {};
  return ((e.prototype = Object.create(null)), Object.freeze(e.prototype), e);
})();
//#endregion
//#region node_modules/srvx/dist/adapters/cloudflare.mjs
var FastURL = URL;
var FastResponse = Response;
//#endregion
//#region node_modules/h3-v2/dist/h3-Bz4OPZv_.mjs
function decodePathname(pathname) {
  return decodeURI(pathname.includes("%25") ? pathname.replace(/%25/g, "%2525") : pathname);
}
var kEventNS = "h3.internal.event.";
var kEventRes = /* @__PURE__ */ Symbol.for(`${kEventNS}res`);
var kEventResHeaders = /* @__PURE__ */ Symbol.for(`${kEventNS}res.headers`);
var kEventResErrHeaders = /* @__PURE__ */ Symbol.for(`${kEventNS}res.err.headers`);
var H3Event = class {
  app;
  req;
  url;
  context;
  static __is_event__ = true;
  constructor(req, context, app) {
    this.context = context || req.context || new NullProtoObj();
    this.req = req;
    this.app = app;
    const _url = req._url;
    const url = _url && _url instanceof URL ? _url : new FastURL(req.url);
    if (url.pathname.includes("%")) url.pathname = decodePathname(url.pathname);
    this.url = url;
  }
  get res() {
    return (this[kEventRes] ||= new H3EventResponse());
  }
  get runtime() {
    return this.req.runtime;
  }
  waitUntil(promise) {
    this.req.waitUntil?.(promise);
  }
  toString() {
    return `[${this.req.method}] ${this.req.url}`;
  }
  toJSON() {
    return this.toString();
  }
  get node() {
    return this.req.runtime?.node;
  }
  get headers() {
    return this.req.headers;
  }
  get path() {
    return this.url.pathname + this.url.search;
  }
  get method() {
    return this.req.method;
  }
};
var H3EventResponse = class {
  status;
  statusText;
  get headers() {
    return (this[kEventResHeaders] ||= new Headers());
  }
  get errHeaders() {
    return (this[kEventResErrHeaders] ||= new Headers());
  }
};
var DISALLOWED_STATUS_CHARS = /[^\u0009\u0020-\u007E]/g;
function sanitizeStatusMessage(statusMessage = "") {
  return statusMessage.replace(DISALLOWED_STATUS_CHARS, "");
}
function sanitizeStatusCode(statusCode, defaultStatusCode = 200) {
  if (!statusCode) return defaultStatusCode;
  if (typeof statusCode === "string") statusCode = +statusCode;
  if (statusCode < 100 || statusCode > 599) return defaultStatusCode;
  return statusCode;
}
var HTTPError = class HTTPError extends Error {
  get name() {
    return "HTTPError";
  }
  status;
  statusText;
  headers;
  cause;
  data;
  body;
  unhandled;
  static isError(input) {
    return input instanceof Error && input?.name === "HTTPError";
  }
  static status(status, statusText, details) {
    return new HTTPError({
      ...details,
      statusText,
      status,
    });
  }
  constructor(arg1, arg2) {
    let messageInput;
    let details;
    if (typeof arg1 === "string") {
      messageInput = arg1;
      details = arg2;
    } else details = arg1;
    const status = sanitizeStatusCode(
      details?.status ||
        details?.statusCode ||
        details?.cause?.status ||
        details?.cause?.statusCode,
      500,
    );
    const statusText = sanitizeStatusMessage(
      details?.statusText ||
        details?.statusMessage ||
        details?.cause?.statusText ||
        details?.cause?.statusMessage,
    );
    const message =
      messageInput ||
      details?.message ||
      details?.cause?.message ||
      details?.statusText ||
      details?.statusMessage ||
      ["HTTPError", status, statusText].filter(Boolean).join(" ");
    super(message, { cause: details });
    this.cause = details;
    this.status = status;
    this.statusText = statusText || void 0;
    const rawHeaders = details?.headers || details?.cause?.headers;
    this.headers = rawHeaders ? new Headers(rawHeaders) : void 0;
    this.unhandled = details?.unhandled ?? details?.cause?.unhandled ?? void 0;
    this.data = details?.data;
    this.body = details?.body;
  }
  get statusCode() {
    return this.status;
  }
  get statusMessage() {
    return this.statusText;
  }
  toJSON() {
    const unhandled = this.unhandled;
    return {
      status: this.status,
      statusText: this.statusText,
      unhandled,
      message: unhandled ? "HTTPError" : this.message,
      data: unhandled ? void 0 : this.data,
      ...(unhandled ? void 0 : this.body),
    };
  }
};
function isJSONSerializable(value, _type) {
  if (value === null || value === void 0) return true;
  if (_type !== "object") return _type === "boolean" || _type === "number" || _type === "string";
  if (typeof value.toJSON === "function") return true;
  if (Array.isArray(value)) return true;
  if (typeof value.pipe === "function" || typeof value.pipeTo === "function") return false;
  if (value instanceof NullProtoObj) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
var kNotFound = /* @__PURE__ */ Symbol.for("h3.notFound");
var kHandled = /* @__PURE__ */ Symbol.for("h3.handled");
function toResponse(val, event, config = {}) {
  if (typeof val?.then === "function")
    return (val.catch?.((error) => error) || Promise.resolve(val)).then((resolvedVal) =>
      toResponse(resolvedVal, event, config),
    );
  const response = prepareResponse(val, event, config);
  if (typeof response?.then === "function") return toResponse(response, event, config);
  const { onResponse } = config;
  return onResponse ? Promise.resolve(onResponse(response, event)).then(() => response) : response;
}
var HTTPResponse = class {
  #headers;
  #init;
  body;
  constructor(body, init) {
    this.body = body;
    this.#init = init;
  }
  get status() {
    return this.#init?.status || 200;
  }
  get statusText() {
    return this.#init?.statusText || "OK";
  }
  get headers() {
    return (this.#headers ||= new Headers(this.#init?.headers));
  }
};
function prepareResponse(val, event, config, nested) {
  if (val === kHandled) return new FastResponse(null);
  if (val === kNotFound)
    val = new HTTPError({
      status: 404,
      message: `Cannot find any route matching [${event.req.method}] ${event.url}`,
    });
  if (val && val instanceof Error) {
    const isHTTPError = HTTPError.isError(val);
    const error = isHTTPError ? val : new HTTPError(val);
    if (!isHTTPError) {
      error.unhandled = true;
      if (val?.stack) error.stack = val.stack;
    }
    if (error.unhandled && !config.silent) console.error(error);
    const { onError } = config;
    const errHeaders = event[kEventRes]?.[kEventResErrHeaders];
    return onError && !nested
      ? Promise.resolve(onError(error, event))
          .catch((error) => error)
          .then((newVal) => prepareResponse(newVal ?? val, event, config, true))
      : errorResponse(error, config.debug, errHeaders);
  }
  const preparedRes = event[kEventRes];
  const preparedHeaders = preparedRes?.[kEventResHeaders];
  event[kEventRes] = void 0;
  if (!(val instanceof Response)) {
    const res = prepareResponseBody(val, event, config);
    const status = res.status || preparedRes?.status;
    return new FastResponse(nullBody(event.req.method, status) ? null : res.body, {
      status,
      statusText: res.statusText || preparedRes?.statusText,
      headers:
        res.headers && preparedHeaders
          ? mergeHeaders$1(res.headers, preparedHeaders)
          : res.headers || preparedHeaders,
    });
  }
  if (!preparedHeaders || nested || !val.ok) return val;
  try {
    mergeHeaders$1(val.headers, preparedHeaders, val.headers);
    return val;
  } catch {
    return new FastResponse(nullBody(event.req.method, val.status) ? null : val.body, {
      status: val.status,
      statusText: val.statusText,
      headers: mergeHeaders$1(val.headers, preparedHeaders),
    });
  }
}
function mergeHeaders$1(base, overrides, target = new Headers(base)) {
  for (const [name, value] of overrides)
    if (name === "set-cookie") target.append(name, value);
    else target.set(name, value);
  return target;
}
var frozen =
  (name) =>
  (...args) => {
    throw new Error(`Headers are frozen (${name} ${args.join(", ")})`);
  };
var FrozenHeaders = class extends Headers {
  set = frozen("set");
  append = frozen("append");
  delete = frozen("delete");
};
var emptyHeaders = /* @__PURE__ */ new FrozenHeaders({ "content-length": "0" });
var jsonHeaders = /* @__PURE__ */ new FrozenHeaders({
  "content-type": "application/json;charset=UTF-8",
});
function prepareResponseBody(val, event, config) {
  if (val === null || val === void 0)
    return {
      body: "",
      headers: emptyHeaders,
    };
  const valType = typeof val;
  if (valType === "string") return { body: val };
  if (val instanceof Uint8Array) {
    event.res.headers.set("content-length", val.byteLength.toString());
    return { body: val };
  }
  if (val instanceof HTTPResponse || val?.constructor?.name === "HTTPResponse") return val;
  if (isJSONSerializable(val, valType))
    return {
      body: JSON.stringify(val, void 0, config.debug ? 2 : void 0),
      headers: jsonHeaders,
    };
  if (valType === "bigint")
    return {
      body: val.toString(),
      headers: jsonHeaders,
    };
  if (val instanceof Blob) {
    const headers = new Headers({
      "content-type": val.type,
      "content-length": val.size.toString(),
    });
    let filename = val.name;
    if (filename) {
      filename = encodeURIComponent(filename);
      headers.set("content-disposition", `filename="${filename}"; filename*=UTF-8''${filename}`);
    }
    return {
      body: val.stream(),
      headers,
    };
  }
  if (valType === "symbol") return { body: val.toString() };
  if (valType === "function") return { body: `${val.name}()` };
  return { body: val };
}
function nullBody(method, status) {
  return (
    method === "HEAD" ||
    status === 100 ||
    status === 101 ||
    status === 102 ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}
function errorResponse(error, debug, errHeaders) {
  let headers = error.headers
    ? mergeHeaders$1(jsonHeaders, error.headers)
    : new Headers(jsonHeaders);
  if (errHeaders) headers = mergeHeaders$1(headers, errHeaders);
  return new FastResponse(
    JSON.stringify(
      {
        ...error.toJSON(),
        stack: debug && error.stack ? error.stack.split("\n").map((l) => l.trim()) : void 0,
      },
      void 0,
      debug ? 2 : void 0,
    ),
    {
      status: error.status,
      statusText: error.statusText,
      headers,
    },
  );
}
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/request-response.js
var GLOBAL_EVENT_STORAGE_KEY = Symbol.for("tanstack-start:event-storage");
var globalObj = globalThis;
if (!globalObj[GLOBAL_EVENT_STORAGE_KEY])
  globalObj[GLOBAL_EVENT_STORAGE_KEY] = new AsyncLocalStorage$1();
var eventStorage = globalObj[GLOBAL_EVENT_STORAGE_KEY];
function isPromiseLike(value) {
  return typeof value.then === "function";
}
function getSetCookieValues(headers) {
  const headersWithSetCookie = headers;
  if (typeof headersWithSetCookie.getSetCookie === "function")
    return headersWithSetCookie.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}
function mergeEventResponseHeaders(response, event) {
  if (response.ok) return;
  const eventSetCookies = getSetCookieValues(event.res.headers);
  if (eventSetCookies.length === 0) return;
  const responseSetCookies = getSetCookieValues(response.headers);
  response.headers.delete("set-cookie");
  for (const cookie of responseSetCookies) response.headers.append("set-cookie", cookie);
  for (const cookie of eventSetCookies) response.headers.append("set-cookie", cookie);
}
function attachResponseHeaders(value, event) {
  if (isPromiseLike(value))
    return value.then((resolved) => {
      if (resolved instanceof Response) mergeEventResponseHeaders(resolved, event);
      return resolved;
    });
  if (value instanceof Response) mergeEventResponseHeaders(value, event);
  return value;
}
function requestHandler(handler) {
  return (request, requestOpts) => {
    let h3Event;
    try {
      h3Event = new H3Event(request);
    } catch (error) {
      if (error instanceof URIError)
        return new Response(null, {
          status: 400,
          statusText: "Bad Request",
        });
      throw error;
    }
    return toResponse(
      attachResponseHeaders(
        eventStorage.run({ h3Event }, () => handler(request, requestOpts)),
        h3Event,
      ),
      h3Event,
    );
  };
}
function getH3Event() {
  const event = eventStorage.getStore();
  if (!event)
    throw new Error(
      `No StartEvent found in AsyncLocalStorage. Make sure you are using the function within the server runtime.`,
    );
  return event.h3Event;
}
function getResponse() {
  return getH3Event().res;
}
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/constants.js
var HEADERS = { TSS_SHELL: "X-TSS_SHELL" };
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/router-manifest.js
/**
 * @description Returns the router manifest data that should be sent to the client.
 * This includes only the assets and preloads for the current route and any
 * special assets that are needed for the client. It does not include relationships
 * between routes or any other data that is not needed for the client.
 *
 * The client entry URL is returned separately so that it can be transformed
 * (e.g. for CDN rewriting) before being embedded into the `<script>` tag.
 *
 * @param matchedRoutes - In dev mode, the matched routes are used to build
 * the dev styles URL for route-scoped CSS collection.
 */
async function getStartManifest(matchedRoutes) {
  const { tsrStartManifest } = await import("./assets/_tanstack-start-manifest_v-ClDokl-_.js");
  const startManifest = tsrStartManifest();
  const rootRoute = (startManifest.routes[rootRouteId] = startManifest.routes["__root__"] || {});
  rootRoute.assets = rootRoute.assets || [];
  let injectedHeadScripts;
  return {
    manifest: {
      routes: Object.fromEntries(
        Object.entries(startManifest.routes).flatMap(([k, v]) => {
          const result = {};
          let hasData = false;
          if (v.preloads && v.preloads.length > 0) {
            result["preloads"] = v.preloads;
            hasData = true;
          }
          if (v.assets && v.assets.length > 0) {
            result["assets"] = v.assets;
            hasData = true;
          }
          if (!hasData) return [];
          return [[k, result]];
        }),
      ),
    },
    clientEntry: startManifest.clientEntry,
    injectedHeadScripts,
  };
}
//#endregion
//#region node_modules/@tanstack/start-client-core/dist/esm/getDefaultSerovalPlugins.js
function getDefaultSerovalPlugins() {
  return [
    ...(getStartOptions()?.serializationAdapters?.map(makeSerovalPlugin) ?? []),
    ...defaultSerovalPlugins,
  ];
}
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/frame-protocol.js
/**
 * Binary frame protocol for multiplexing JSON and raw streams over HTTP.
 *
 * Frame format: [type:1][streamId:4][length:4][payload:length]
 * - type: 1 byte - frame type (JSON, CHUNK, END, ERROR)
 * - streamId: 4 bytes big-endian uint32 - stream identifier
 * - length: 4 bytes big-endian uint32 - payload length
 * - payload: variable length bytes
 */
/** Cached TextEncoder for frame encoding */
var textEncoder = new TextEncoder();
/** Shared empty payload for END frames - avoids allocation per call */
var EMPTY_PAYLOAD = new Uint8Array(0);
/**
 * Encodes a single frame with header and payload.
 */
function encodeFrame(type, streamId, payload) {
  const frame = new Uint8Array(9 + payload.length);
  frame[0] = type;
  frame[1] = (streamId >>> 24) & 255;
  frame[2] = (streamId >>> 16) & 255;
  frame[3] = (streamId >>> 8) & 255;
  frame[4] = streamId & 255;
  frame[5] = (payload.length >>> 24) & 255;
  frame[6] = (payload.length >>> 16) & 255;
  frame[7] = (payload.length >>> 8) & 255;
  frame[8] = payload.length & 255;
  frame.set(payload, 9);
  return frame;
}
/**
 * Encodes a JSON frame (type 0, streamId 0).
 */
function encodeJSONFrame(json) {
  return encodeFrame(FrameType.JSON, 0, textEncoder.encode(json));
}
/**
 * Encodes a raw stream chunk frame.
 */
function encodeChunkFrame(streamId, chunk) {
  return encodeFrame(FrameType.CHUNK, streamId, chunk);
}
/**
 * Encodes a raw stream end frame.
 */
function encodeEndFrame(streamId) {
  return encodeFrame(FrameType.END, streamId, EMPTY_PAYLOAD);
}
/**
 * Encodes a raw stream error frame.
 */
function encodeErrorFrame(streamId, error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return encodeFrame(FrameType.ERROR, streamId, textEncoder.encode(message));
}
/**
 * Creates a multiplexed ReadableStream from JSON stream and raw streams.
 *
 * The JSON stream emits NDJSON lines (from seroval's toCrossJSONStream).
 * Raw streams are pumped concurrently, interleaved with JSON frames.
 *
 * Supports late stream registration for RawStreams discovered after initial
 * serialization (e.g., from resolved Promises).
 *
 * @param jsonStream Stream of JSON strings (each string is one NDJSON line)
 * @param rawStreams Map of stream IDs to raw binary streams (known at start)
 * @param lateStreamSource Optional stream of late registrations for streams discovered later
 */
function createMultiplexedStream(jsonStream, rawStreams, lateStreamSource) {
  let controller;
  let cancelled = false;
  const readers = [];
  const enqueue = (frame) => {
    if (cancelled) return false;
    try {
      controller.enqueue(frame);
      return true;
    } catch {
      return false;
    }
  };
  const errorOutput = (error) => {
    if (cancelled) return;
    cancelled = true;
    try {
      controller.error(error);
    } catch {}
    for (const reader of readers) reader.cancel().catch(() => {});
  };
  async function pumpRawStream(streamId, stream) {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) {
          enqueue(encodeEndFrame(streamId));
          return;
        }
        if (!enqueue(encodeChunkFrame(streamId, value))) return;
      }
    } catch (error) {
      enqueue(encodeErrorFrame(streamId, error));
    } finally {
      reader.releaseLock();
    }
  }
  async function pumpJSON() {
    const reader = jsonStream.getReader();
    readers.push(reader);
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) return;
        if (!enqueue(encodeJSONFrame(value))) return;
      }
    } catch (error) {
      errorOutput(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  async function pumpLateStreams() {
    if (!lateStreamSource) return [];
    const lateStreamPumps = [];
    const reader = lateStreamSource.getReader();
    readers.push(reader);
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        lateStreamPumps.push(pumpRawStream(value.id, value.stream));
      }
    } finally {
      reader.releaseLock();
    }
    return lateStreamPumps;
  }
  return new ReadableStream({
    async start(ctrl) {
      controller = ctrl;
      const pumps = [pumpJSON()];
      for (const [streamId, stream] of rawStreams) pumps.push(pumpRawStream(streamId, stream));
      if (lateStreamSource) pumps.push(pumpLateStreams());
      try {
        const latePumps = (await Promise.all(pumps)).find(Array.isArray);
        if (latePumps && latePumps.length > 0) await Promise.all(latePumps);
        if (!cancelled)
          try {
            controller.close();
          } catch {}
      } catch {}
    },
    cancel() {
      cancelled = true;
      for (const reader of readers) reader.cancel().catch(() => {});
      readers.length = 0;
    },
  });
}
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/server-functions-handler.js
var serovalPlugins = void 0;
var FORM_DATA_CONTENT_TYPES = ["multipart/form-data", "application/x-www-form-urlencoded"];
var MAX_PAYLOAD_SIZE = 1e6;
var handleServerAction = async ({ request, context, serverFnId }) => {
  const methodUpper = request.method.toUpperCase();
  const url = new URL(request.url);
  const action = await getServerFnById(serverFnId, { origin: "client" });
  if (action.method && methodUpper !== action.method)
    return new Response(`expected ${action.method} method. Got ${methodUpper}`, {
      status: 405,
      headers: { Allow: action.method },
    });
  const isServerFn = request.headers.get("x-tsr-serverFn") === "true";
  if (!serovalPlugins) serovalPlugins = getDefaultSerovalPlugins();
  const contentType = request.headers.get("Content-Type");
  function parsePayload(payload) {
    return Iu(payload, { plugins: serovalPlugins });
  }
  return await (async () => {
    try {
      let res = await (async () => {
        if (FORM_DATA_CONTENT_TYPES.some((type) => contentType && contentType.includes(type))) {
          if (methodUpper === "GET") invariant();
          const formData = await request.formData();
          const serializedContext = formData.get(TSS_FORMDATA_CONTEXT);
          formData.delete(TSS_FORMDATA_CONTEXT);
          const params = {
            context,
            data: formData,
            method: methodUpper,
          };
          if (typeof serializedContext === "string")
            try {
              const deserializedContext = Iu(JSON.parse(serializedContext), {
                plugins: serovalPlugins,
              });
              if (typeof deserializedContext === "object" && deserializedContext)
                params.context = safeObjectMerge(deserializedContext, context);
            } catch (e) {}
          return await action(params);
        }
        if (methodUpper === "GET") {
          const payloadParam = url.searchParams.get("payload");
          if (payloadParam && payloadParam.length > MAX_PAYLOAD_SIZE)
            throw new Error("Payload too large");
          const payload = payloadParam ? parsePayload(JSON.parse(payloadParam)) : {};
          payload.context = safeObjectMerge(payload.context, context);
          payload.method = methodUpper;
          return await action(payload);
        }
        let jsonPayload;
        if (contentType?.includes("application/json")) jsonPayload = await request.json();
        const payload = jsonPayload ? parsePayload(jsonPayload) : {};
        payload.context = safeObjectMerge(payload.context, context);
        payload.method = methodUpper;
        return await action(payload);
      })();
      const unwrapped = res.result || res.error;
      if (isNotFound(res)) res = isNotFoundResponse(res);
      if (!isServerFn) return unwrapped;
      if (unwrapped instanceof Response) {
        if (isRedirect(unwrapped)) return unwrapped;
        unwrapped.headers.set(X_TSS_RAW_RESPONSE, "true");
        return unwrapped;
      }
      return serializeResult(res);
      function serializeResult(res) {
        let nonStreamingBody = void 0;
        const alsResponse = getResponse();
        if (res !== void 0) {
          const rawStreams = /* @__PURE__ */ new Map();
          let initialPhase = true;
          let lateStreamWriter;
          let lateStreamReadable = void 0;
          const pendingLateStreams = [];
          const plugins = [
            /* @__PURE__ */ createRawStreamRPCPlugin((id, stream) => {
              if (initialPhase) {
                rawStreams.set(id, stream);
                return;
              }
              if (lateStreamWriter) {
                lateStreamWriter
                  .write({
                    id,
                    stream,
                  })
                  .catch(() => {});
                return;
              }
              pendingLateStreams.push({
                id,
                stream,
              });
            }),
            ...(serovalPlugins || []),
          ];
          let done = false;
          const callbacks = {
            onParse: (value) => {
              nonStreamingBody = value;
            },
            onDone: () => {
              done = true;
            },
            onError: (error) => {
              throw error;
            },
          };
          au(res, {
            refs: /* @__PURE__ */ new Map(),
            plugins,
            onParse(value) {
              callbacks.onParse(value);
            },
            onDone() {
              callbacks.onDone();
            },
            onError: (error) => {
              callbacks.onError(error);
            },
          });
          initialPhase = false;
          if (done && rawStreams.size === 0)
            return new Response(nonStreamingBody ? JSON.stringify(nonStreamingBody) : void 0, {
              status: alsResponse.status,
              statusText: alsResponse.statusText,
              headers: {
                "Content-Type": "application/json",
                [X_TSS_SERIALIZED]: "true",
              },
            });
          const { readable, writable } = new TransformStream();
          lateStreamReadable = readable;
          lateStreamWriter = writable.getWriter();
          for (const registration of pendingLateStreams)
            lateStreamWriter.write(registration).catch(() => {});
          pendingLateStreams.length = 0;
          const multiplexedStream = createMultiplexedStream(
            new ReadableStream({
              start(controller) {
                callbacks.onParse = (value) => {
                  controller.enqueue(JSON.stringify(value) + "\n");
                };
                callbacks.onDone = () => {
                  try {
                    controller.close();
                  } catch {}
                  lateStreamWriter
                    ?.close()
                    .catch(() => {})
                    .finally(() => {
                      lateStreamWriter = void 0;
                    });
                };
                callbacks.onError = (error) => {
                  controller.error(error);
                  lateStreamWriter
                    ?.abort(error)
                    .catch(() => {})
                    .finally(() => {
                      lateStreamWriter = void 0;
                    });
                };
                if (nonStreamingBody !== void 0) callbacks.onParse(nonStreamingBody);
                if (done) callbacks.onDone();
              },
              cancel() {
                lateStreamWriter?.abort().catch(() => {});
                lateStreamWriter = void 0;
              },
            }),
            rawStreams,
            lateStreamReadable,
          );
          return new Response(multiplexedStream, {
            status: alsResponse.status,
            statusText: alsResponse.statusText,
            headers: {
              "Content-Type": TSS_CONTENT_TYPE_FRAMED_VERSIONED,
              [X_TSS_SERIALIZED]: "true",
            },
          });
        }
        return new Response(void 0, {
          status: alsResponse.status,
          statusText: alsResponse.statusText,
        });
      }
    } catch (error) {
      if (error instanceof Response) return error;
      if (isNotFound(error)) return isNotFoundResponse(error);
      console.info();
      console.info("Server Fn Error!");
      console.info();
      console.error(error);
      console.info();
      const serializedError = JSON.stringify(
        await Promise.resolve(
          ou(error, {
            refs: /* @__PURE__ */ new Map(),
            plugins: serovalPlugins,
          }),
        ),
      );
      const response = getResponse();
      return new Response(serializedError, {
        status: response.status ?? 500,
        statusText: response.statusText,
        headers: {
          "Content-Type": "application/json",
          [X_TSS_SERIALIZED]: "true",
        },
      });
    }
  })();
};
function isNotFoundResponse(error) {
  const { headers, ...rest } = error;
  return new Response(JSON.stringify(rest), {
    status: 404,
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
  });
}
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/transformAssetUrls.js
function warnDeprecatedTransformAssetUrls() {}
function normalizeTransformAssetResult(result) {
  if (typeof result === "string") return { href: result };
  return result;
}
function resolveTransformAssetsCrossOrigin(config, kind) {
  if (!config) return void 0;
  if (typeof config === "string") return config;
  return config[kind];
}
function isObjectShorthand(transform) {
  return "prefix" in transform;
}
function resolveTransformAssetsConfig(transform) {
  if (typeof transform === "string") {
    const prefix = transform;
    return {
      type: "transform",
      transformFn: ({ url }) => ({ href: `${prefix}${url}` }),
      cache: true,
    };
  }
  if (typeof transform === "function")
    return {
      type: "transform",
      transformFn: transform,
      cache: true,
    };
  if (isObjectShorthand(transform)) {
    const { prefix, crossOrigin } = transform;
    return {
      type: "transform",
      transformFn: ({ url, kind }) => {
        const href = `${prefix}${url}`;
        if (kind === "clientEntry") return { href };
        const co = resolveTransformAssetsCrossOrigin(crossOrigin, kind);
        return co
          ? {
              href,
              crossOrigin: co,
            }
          : { href };
      },
      cache: true,
    };
  }
  if ("createTransform" in transform && transform.createTransform)
    return {
      type: "createTransform",
      createTransform: transform.createTransform,
      cache: transform.cache !== false,
    };
  return {
    type: "transform",
    transformFn:
      typeof transform.transform === "string"
        ? ({ url }) => ({ href: `${transform.transform}${url}` })
        : transform.transform,
    cache: transform.cache !== false,
  };
}
function adaptTransformAssetUrlsToTransformAssets(transformFn) {
  return async ({ url, kind }) => ({
    href: await transformFn({
      url,
      type: kind,
    }),
  });
}
function adaptTransformAssetUrlsConfigToTransformAssets(transform) {
  warnDeprecatedTransformAssetUrls();
  if (typeof transform === "string") return transform;
  if (typeof transform === "function") return adaptTransformAssetUrlsToTransformAssets(transform);
  if ("createTransform" in transform && transform.createTransform)
    return {
      createTransform: async (ctx) =>
        adaptTransformAssetUrlsToTransformAssets(await transform.createTransform(ctx)),
      cache: transform.cache,
      warmup: transform.warmup,
    };
  return {
    transform:
      typeof transform.transform === "string"
        ? transform.transform
        : adaptTransformAssetUrlsToTransformAssets(transform.transform),
    cache: transform.cache,
    warmup: transform.warmup,
  };
}
/**
 * Builds the client entry `<script>` tag from a (possibly transformed) client
 * entry URL and optional injected head scripts.
 */
function buildClientEntryScriptTag(clientEntry, injectedHeadScripts) {
  let script = `import(${JSON.stringify(clientEntry)})`;
  if (injectedHeadScripts) script = `${injectedHeadScripts};${script}`;
  return {
    tag: "script",
    attrs: {
      type: "module",
      async: true,
    },
    children: script,
  };
}
function assignManifestAssetLink(link, next) {
  if (typeof link === "string") return next.crossOrigin ? next : next.href;
  return next.crossOrigin ? next : { href: next.href };
}
async function transformManifestAssets(source, transformFn, _opts) {
  const manifest = structuredClone(source.manifest);
  for (const route of Object.values(manifest.routes)) {
    if (route.preloads)
      route.preloads = await Promise.all(
        route.preloads.map(async (link) => {
          const result = normalizeTransformAssetResult(
            await transformFn({
              url: resolveManifestAssetLink(link).href,
              kind: "modulepreload",
            }),
          );
          return assignManifestAssetLink(link, {
            href: result.href,
            crossOrigin: result.crossOrigin,
          });
        }),
      );
    if (route.assets) {
      for (const asset of route.assets)
        if (asset.tag === "link" && asset.attrs?.href) {
          const rel = asset.attrs.rel;
          if (!(typeof rel === "string" ? rel.split(/\s+/) : []).includes("stylesheet")) continue;
          const result = normalizeTransformAssetResult(
            await transformFn({
              url: asset.attrs.href,
              kind: "stylesheet",
            }),
          );
          asset.attrs.href = result.href;
          if (result.crossOrigin) asset.attrs.crossOrigin = result.crossOrigin;
          else delete asset.attrs.crossOrigin;
        }
    }
  }
  const transformedClientEntry = normalizeTransformAssetResult(
    await transformFn({
      url: source.clientEntry,
      kind: "clientEntry",
    }),
  );
  const rootRoute = (manifest.routes[rootRouteId] = manifest.routes["__root__"] || {});
  rootRoute.assets = rootRoute.assets || [];
  rootRoute.assets.push(
    buildClientEntryScriptTag(transformedClientEntry.href, source.injectedHeadScripts),
  );
  return manifest;
}
/**
 * Builds a final Manifest from a StartManifestWithClientEntry without any
 * URL transforms. Used when no transformAssetUrls option is provided.
 *
 * Returns a new manifest object so the cached base manifest is never mutated.
 */
function buildManifestWithClientEntry(source) {
  const scriptTag = buildClientEntryScriptTag(source.clientEntry, source.injectedHeadScripts);
  const baseRootRoute = source.manifest.routes[rootRouteId];
  return {
    routes: {
      ...source.manifest.routes,
      [rootRouteId]: {
        ...baseRootRoute,
        assets: [...(baseRootRoute?.assets || []), scriptTag],
      },
    },
  };
}
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/serializer/ServerFunctionSerializationAdapter.js
var ServerFunctionSerializationAdapter = createSerializationAdapter({
  key: "$TSS/serverfn",
  test: (v) => {
    if (typeof v !== "function") return false;
    if (!(TSS_SERVER_FUNCTION in v)) return false;
    return !!v[TSS_SERVER_FUNCTION];
  },
  toSerializable: ({ serverFnMeta }) => ({ functionId: serverFnMeta.id }),
  fromSerializable: ({ functionId }) => {
    const fn = async (opts, signal) => {
      return (await (await getServerFnById(functionId, { origin: "client" }))(opts ?? {}, signal))
        .result;
    };
    return fn;
  },
});
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/createStartHandler.js
function getStartResponseHeaders(opts) {
  return mergeHeaders(
    { "Content-Type": "text/html; charset=utf-8" },
    ...opts.router.stores.matches.get().map((match) => {
      return match.headers;
    }),
  );
}
var entriesPromise;
var baseManifestPromise;
/**
 * Cached final manifest (with client entry script tag). In production,
 * this is computed once and reused for every request when caching is enabled.
 */
var cachedFinalManifestPromise;
async function loadEntries() {
  const [routerEntry, startEntry, pluginAdapters] = await Promise.all([
    import("./assets/router-CABDRgLO.js"),
    import("./assets/start-BnVKbPDK.js"),
    import("./assets/__23tanstack-start-plugin-adapters-BV8ZItq6.js"),
  ]);
  return {
    routerEntry,
    startEntry,
    pluginAdapters,
  };
}
function getEntries() {
  if (!entriesPromise) entriesPromise = loadEntries();
  return entriesPromise;
}
/**
 * Returns the raw manifest data (without client entry script tag baked in).
 * In dev mode, always returns fresh data. In prod, cached.
 */
function getBaseManifest(matchedRoutes) {
  if (!baseManifestPromise) baseManifestPromise = getStartManifest();
  return baseManifestPromise;
}
/**
 * Resolves a final Manifest for a given request.
 *
 * - No transform: builds client entry script tag and returns (cached in prod).
 * - Cached transform: transforms all URLs + builds script tag, caches result.
 * - Per-request transform: deep-clones base manifest, transforms per-request.
 */
async function resolveManifest(matchedRoutes, transformFn, cache) {
  const base = await getBaseManifest(matchedRoutes);
  const computeFinalManifest = async () => {
    return transformFn
      ? await transformManifestAssets(base, transformFn, { clone: !cache })
      : buildManifestWithClientEntry(base);
  };
  if (!transformFn || cache) {
    if (!cachedFinalManifestPromise) cachedFinalManifestPromise = computeFinalManifest();
    return cachedFinalManifestPromise;
  }
  return computeFinalManifest();
}
var ROUTER_BASEPATH = "/";
var SERVER_FN_BASE = "/_serverFn/";
var IS_PRERENDERING = process.env.TSS_PRERENDERING === "true";
var IS_SHELL_ENV = process.env.TSS_SHELL === "true";
var IS_DEV = false;
var ERR_NO_RESPONSE = IS_DEV
  ? `It looks like you forgot to return a response from your server route handler. If you want to defer to the app router, make sure to have a component set in this route.`
  : "Internal Server Error";
var ERR_NO_DEFER = IS_DEV
  ? `You cannot defer to the app router if there is no component defined on this route.`
  : "Internal Server Error";
function throwRouteHandlerError() {
  throw new Error(ERR_NO_RESPONSE);
}
function throwIfMayNotDefer() {
  throw new Error(ERR_NO_DEFER);
}
/**
 * Check if a value is a special response (Response or Redirect)
 */
function isSpecialResponse(value) {
  return value instanceof Response || isRedirect(value);
}
/**
 * Normalize middleware result to context shape
 */
function handleCtxResult(result) {
  if (isSpecialResponse(result)) return { response: result };
  return result;
}
/**
 * Execute a middleware chain
 */
function executeMiddleware(middlewares, ctx) {
  let index = -1;
  const next = async (nextCtx) => {
    if (nextCtx) {
      if (nextCtx.context) ctx.context = safeObjectMerge(ctx.context, nextCtx.context);
      for (const key of Object.keys(nextCtx)) if (key !== "context") ctx[key] = nextCtx[key];
    }
    index++;
    const middleware = middlewares[index];
    if (!middleware) return ctx;
    let result;
    try {
      result = await middleware({
        ...ctx,
        next,
      });
    } catch (err) {
      if (isSpecialResponse(err)) {
        ctx.response = err;
        return ctx;
      }
      throw err;
    }
    const normalized = handleCtxResult(result);
    if (normalized) {
      if (normalized.response !== void 0) ctx.response = normalized.response;
      if (normalized.context) ctx.context = safeObjectMerge(ctx.context, normalized.context);
    }
    return ctx;
  };
  return next();
}
/**
 * Wrap a route handler as middleware
 */
function handlerToMiddleware(handler, mayDefer = false) {
  if (mayDefer) return handler;
  return async (ctx) => {
    const response = await handler({
      ...ctx,
      next: throwIfMayNotDefer,
    });
    if (!response) throwRouteHandlerError();
    return response;
  };
}
/**
 * Creates the TanStack Start request handler.
 *
 * @example Backwards-compatible usage (handler callback only):
 * ```ts
 * export default createStartHandler(defaultStreamHandler)
 * ```
 *
 * @example With CDN URL rewriting:
 * ```ts
 * export default createStartHandler({
 *   handler: defaultStreamHandler,
 *   transformAssets: 'https://cdn.example.com',
 * })
 * ```
 *
 * @example With per-request URL rewriting:
 * ```ts
 * export default createStartHandler({
 *   handler: defaultStreamHandler,
 *   transformAssets: {
 *     transform: ({ url }) => {
 *       const cdnBase = getRequest().headers.get('x-cdn-base') || ''
 *       return { href: `${cdnBase}${url}` }
 *     },
 *     cache: false,
 *   },
 * })
 * ```
 */
function createStartHandler(cbOrOptions) {
  const cb = typeof cbOrOptions === "function" ? cbOrOptions : cbOrOptions.handler;
  const transformAssetsOption =
    typeof cbOrOptions === "function" ? void 0 : cbOrOptions.transformAssets;
  const transformAssetUrlsOption =
    typeof cbOrOptions === "function" ? void 0 : cbOrOptions.transformAssetUrls;
  const transformOption =
    transformAssetsOption !== void 0
      ? resolveTransformAssetsConfig(transformAssetsOption)
      : transformAssetUrlsOption !== void 0
        ? resolveTransformAssetsConfig(
            adaptTransformAssetUrlsConfigToTransformAssets(transformAssetUrlsOption),
          )
        : void 0;
  const warmupTransformManifest =
    (!!transformAssetsOption &&
      typeof transformAssetsOption === "object" &&
      "warmup" in transformAssetsOption &&
      transformAssetsOption.warmup === true) ||
    (!!transformAssetUrlsOption &&
      typeof transformAssetUrlsOption === "object" &&
      transformAssetUrlsOption.warmup === true);
  const resolvedTransformConfig = transformOption;
  const cache = resolvedTransformConfig ? resolvedTransformConfig.cache : true;
  const shouldCacheCreateTransform = cache && true;
  let cachedCreateTransformPromise;
  const getTransformFn = async (opts) => {
    if (!resolvedTransformConfig) return void 0;
    if (resolvedTransformConfig.type === "createTransform") {
      if (shouldCacheCreateTransform) {
        if (!cachedCreateTransformPromise)
          cachedCreateTransformPromise = Promise.resolve(
            resolvedTransformConfig.createTransform(opts),
          ).catch((error) => {
            cachedCreateTransformPromise = void 0;
            throw error;
          });
        return cachedCreateTransformPromise;
      }
      return resolvedTransformConfig.createTransform(opts);
    }
    return resolvedTransformConfig.transformFn;
  };
  if (warmupTransformManifest && cache && !cachedFinalManifestPromise) {
    const warmupPromise = (async () => {
      const base = await getBaseManifest(void 0);
      const transformFn = await getTransformFn({ warmup: true });
      return transformFn
        ? await transformManifestAssets(base, transformFn, { clone: false })
        : buildManifestWithClientEntry(base);
    })();
    cachedFinalManifestPromise = warmupPromise;
    warmupPromise.catch(() => {
      if (cachedFinalManifestPromise === warmupPromise) cachedFinalManifestPromise = void 0;
      cachedCreateTransformPromise = void 0;
    });
  }
  const startRequestResolver = async (request, requestOpts) => {
    let router = null;
    let cbWillCleanup = false;
    try {
      const { url, handledProtocolRelativeURL } = getNormalizedURL(request.url);
      const href = url.pathname + url.search + url.hash;
      const origin = getOrigin(request);
      if (handledProtocolRelativeURL) return Response.redirect(url, 308);
      const entries = await getEntries();
      const startOptions = (await entries.startEntry.startInstance?.getOptions()) || {};
      const { hasPluginAdapters, pluginSerializationAdapters } = entries.pluginAdapters;
      const serializationAdapters = [
        ...(startOptions.serializationAdapters || []),
        ...(hasPluginAdapters ? pluginSerializationAdapters : []),
        ServerFunctionSerializationAdapter,
      ];
      const requestStartOptions = {
        ...startOptions,
        serializationAdapters,
      };
      const flattenedRequestMiddlewares = startOptions.requestMiddleware
        ? flattenMiddlewares(startOptions.requestMiddleware)
        : [];
      const executedRequestMiddlewares = new Set(flattenedRequestMiddlewares);
      const getRouter = async () => {
        if (router) return router;
        router = await entries.routerEntry.getRouter();
        let isShell = IS_SHELL_ENV;
        if (IS_PRERENDERING && !isShell)
          isShell = request.headers.get(HEADERS.TSS_SHELL) === "true";
        const history = createMemoryHistory({ initialEntries: [href] });
        router.update({
          history,
          isShell,
          isPrerendering: IS_PRERENDERING,
          origin: router.options.origin ?? origin,
          defaultSsr: requestStartOptions.defaultSsr,
          serializationAdapters: [
            ...requestStartOptions.serializationAdapters,
            ...(router.options.serializationAdapters || []),
          ],
          basepath: ROUTER_BASEPATH,
        });
        return router;
      };
      if (SERVER_FN_BASE && url.pathname.startsWith(SERVER_FN_BASE)) {
        const serverFnId = url.pathname.slice(SERVER_FN_BASE.length).split("/")[0];
        if (!serverFnId) throw new Error("Invalid server action param for serverFnId");
        const serverFnHandler = async ({ context }) => {
          return runWithStartContext(
            {
              getRouter,
              startOptions: requestStartOptions,
              contextAfterGlobalMiddlewares: context,
              request,
              executedRequestMiddlewares,
              handlerType: "serverFn",
            },
            () =>
              handleServerAction({
                request,
                context: requestOpts?.context,
                serverFnId,
              }),
          );
        };
        return handleRedirectResponse(
          (
            await executeMiddleware(
              [...flattenedRequestMiddlewares.map((d) => d.options.server), serverFnHandler],
              {
                request,
                pathname: url.pathname,
                context: createNullProtoObject(requestOpts?.context),
              },
            )
          ).response,
          request,
          getRouter,
        );
      }
      const executeRouter = async (serverContext, matchedRoutes) => {
        const acceptParts = (request.headers.get("Accept") || "*/*").split(",");
        if (
          !["*/*", "text/html"].some((mimeType) =>
            acceptParts.some((part) => part.trim().startsWith(mimeType)),
          )
        )
          return Response.json({ error: "Only HTML requests are supported here" }, { status: 500 });
        const manifest = await resolveManifest(
          matchedRoutes,
          await getTransformFn({
            warmup: false,
            request,
          }),
          cache,
        );
        const routerInstance = await getRouter();
        attachRouterServerSsrUtils({
          router: routerInstance,
          manifest,
          getRequestAssets: () => getStartContext({ throwIfNotFound: false })?.requestAssets,
          includeUnmatchedRouteAssets: false,
        });
        routerInstance.update({ additionalContext: { serverContext } });
        await routerInstance.load();
        if (routerInstance.state.redirect) return routerInstance.state.redirect;
        const ctx = getStartContext({ throwIfNotFound: false });
        await routerInstance.serverSsr.dehydrate({ requestAssets: ctx?.requestAssets });
        const responseHeaders = getStartResponseHeaders({ router: routerInstance });
        cbWillCleanup = true;
        return cb({
          request,
          router: routerInstance,
          responseHeaders,
        });
      };
      const requestHandlerMiddleware = async ({ context }) => {
        return runWithStartContext(
          {
            getRouter,
            startOptions: requestStartOptions,
            contextAfterGlobalMiddlewares: context,
            request,
            executedRequestMiddlewares,
            handlerType: "router",
          },
          async () => {
            try {
              return await handleServerRoutes({
                getRouter,
                request,
                url,
                executeRouter,
                context,
                executedRequestMiddlewares,
              });
            } catch (err) {
              if (err instanceof Response) return err;
              throw err;
            }
          },
        );
      };
      return handleRedirectResponse(
        (
          await executeMiddleware(
            [...flattenedRequestMiddlewares.map((d) => d.options.server), requestHandlerMiddleware],
            {
              request,
              pathname: url.pathname,
              context: createNullProtoObject(requestOpts?.context),
            },
          )
        ).response,
        request,
        getRouter,
      );
    } finally {
      if (router && !cbWillCleanup) router.serverSsr?.cleanup();
      router = null;
    }
  };
  return requestHandler(startRequestResolver);
}
async function handleRedirectResponse(response, request, getRouter) {
  if (!isRedirect(response)) return response;
  if (isResolvedRedirect(response)) {
    if (request.headers.get("x-tsr-serverFn") === "true")
      return Response.json(
        {
          ...response.options,
          isSerializedRedirect: true,
        },
        { headers: response.headers },
      );
    return response;
  }
  const opts = response.options;
  if (opts.to && typeof opts.to === "string" && !opts.to.startsWith("/"))
    throw new Error(
      `Server side redirects must use absolute paths via the 'href' or 'to' options. The redirect() method's "to" property accepts an internal path only. Use the "href" property to provide an external URL. Received: ${JSON.stringify(opts)}`,
    );
  if (["params", "search", "hash"].some((d) => typeof opts[d] === "function"))
    throw new Error(
      `Server side redirects must use static search, params, and hash values and do not support functional values. Received functional values for: ${Object.keys(
        opts,
      )
        .filter((d) => typeof opts[d] === "function")
        .map((d) => `"${d}"`)
        .join(", ")}`,
    );
  const redirect = (await getRouter()).resolveRedirect(response);
  if (request.headers.get("x-tsr-serverFn") === "true")
    return Response.json(
      {
        ...response.options,
        isSerializedRedirect: true,
      },
      { headers: response.headers },
    );
  return redirect;
}
async function handleServerRoutes({
  getRouter,
  request,
  url,
  executeRouter,
  context,
  executedRequestMiddlewares,
}) {
  const router = await getRouter();
  const pathname = executeRewriteInput(router.rewrite, url).pathname;
  const { matchedRoutes, foundRoute, routeParams } = router.getMatchedRoutes(pathname);
  const isExactMatch = foundRoute && routeParams["**"] === void 0;
  const routeMiddlewares = [];
  for (const route of matchedRoutes) {
    const serverMiddleware = route.options.server?.middleware;
    if (serverMiddleware) {
      const flattened = flattenMiddlewares(serverMiddleware);
      for (const m of flattened)
        if (!executedRequestMiddlewares.has(m)) routeMiddlewares.push(m.options.server);
    }
  }
  const server = foundRoute?.options.server;
  if (server?.handlers && isExactMatch) {
    const handlers =
      typeof server.handlers === "function"
        ? server.handlers({ createHandlers: (d) => d })
        : server.handlers;
    const handler = handlers[request.method.toUpperCase()] ?? handlers["ANY"];
    if (handler) {
      const mayDefer = !!foundRoute.options.component;
      if (typeof handler === "function")
        routeMiddlewares.push(handlerToMiddleware(handler, mayDefer));
      else {
        if (handler.middleware?.length) {
          const handlerMiddlewares = flattenMiddlewares(handler.middleware);
          for (const m of handlerMiddlewares) routeMiddlewares.push(m.options.server);
        }
        if (handler.handler) routeMiddlewares.push(handlerToMiddleware(handler.handler, mayDefer));
      }
    }
  }
  routeMiddlewares.push((ctx) => executeRouter(ctx.context, matchedRoutes));
  return (
    await executeMiddleware(routeMiddlewares, {
      request,
      context,
      params: routeParams,
      pathname,
    })
  ).response;
}
//#endregion
//#region node_modules/@tanstack/react-start/dist/default-entry/esm/server.js
var fetch$1 = createStartHandler(defaultStreamHandler);
function createServerEntry(entry) {
  return {
    async fetch(...args) {
      return await entry.fetch(...args);
    },
  };
}
var server_default = createServerEntry({ fetch: fetch$1 });
//#endregion
//#region src/lib/ws-upgrade.ts
/** If a Route.server.handler returned a WebSocketResponse, upgrade the connection. */
function maybeUpgradeWebSocket(response) {
  if (!(response instanceof WebSocketResponse)) return response;
  const hooks = response.wsHooks;
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const peer = {
    send: (d) => server.send(d),
    close: (code, reason) => server.close(code, reason),
  };
  hooks.open?.(peer);
  server.addEventListener("message", (event) => {
    const data = event.data;
    const msg =
      typeof data === "string"
        ? {
            rawData: data,
            uint8Array: () => new TextEncoder().encode(data),
          }
        : {
            rawData: data,
            uint8Array: () => new Uint8Array(data),
          };
    hooks.message?.(peer, msg);
  });
  server.addEventListener("close", () => hooks.close?.(peer));
  server.addEventListener("error", () => hooks.error?.(peer));
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
//#endregion
//#region src/db/migrations.ts
var migrations_default = {
  journal: {
    version: "7",
    dialect: "sqlite",
    entries: [
      {
        idx: 0,
        version: "6",
        when: 1776945088492,
        tag: "0000_furry_franklin_richards",
        breakpoints: true,
      },
    ],
  },
  migrations: {
    m0000:
      "CREATE TABLE `things` (\n	`id` text PRIMARY KEY NOT NULL,\n	`name` text NOT NULL,\n	`created_at` text NOT NULL\n);\n--> statement-breakpoint\nCREATE INDEX `things_created_at_idx` ON `things` (`created_at`);",
  },
};
//#endregion
//#region src/entry.facet.ts
/**
 * Durable Object facet entrypoint.
 *
 * Exports `class App extends DurableObject` for the LOADER to instantiate.
 * Uses DO's built-in SQLite via drizzle-orm/durable-sqlite.
 * Runs Drizzle migrations on first request via blockConcurrencyWhile.
 */
var App = class extends DurableObject {
  db = drizzle(this.ctx.storage, { schema: schema_exports });
  constructor(ctx, env) {
    super(ctx, env);
    migrate(this.db, migrations_default);
  }
  async fetch(request) {
    const context = {
      db: this.db,
      pty: () => ({
        open(peer) {
          peer.send("\r\n\r\nTerminal is not available in the Cloudflare Worker runtime.\r\n");
          peer.close(4e3, "Terminal not implemented");
        },
      }),
    };
    return maybeUpgradeWebSocket(await server_default.fetch(request, { context }));
  }
};
//#endregion
//#region \0virtual:cloudflare/worker-entry
var worker_entry_default = {
  async fetch(request) {
    return maybeUpgradeWebSocket(await server_default.fetch(request));
  },
};
//#endregion
export { App, worker_entry_default as default };
