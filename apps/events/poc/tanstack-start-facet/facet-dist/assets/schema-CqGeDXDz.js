import {
  a as __toESM,
  i as __exportAll,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B8ri5dzN.js";
import {
  A as arraysEqual,
  B as isPromise,
  C as findRouteMatch,
  D as createLRUCache,
  E as processRouteTree,
  H as nullReplaceEqualDeep,
  I as functionalUpdate,
  L as isDangerousProtocol,
  M as decodePath,
  N as deepEqual,
  O as invariant,
  P as encodePathLikeUrl,
  S as findFlatMatch,
  T as processRouteMasks,
  U as replaceEqualDeep,
  V as last,
  a as matchContext,
  c as ClientOnly,
  d as isNotFound,
  f as cleanPath,
  g as joinPaths,
  h as interpolatePath,
  j as createControlledPromise,
  k as DEFAULT_PROTOCOL_ALLOWLIST,
  o as useRouter,
  p as compileDecodeCharMap,
  r as useStore,
  u as rootRouteId,
  v as resolvePath,
  w as findSingleMatch,
  x as trimPathRight,
  y as trimPath,
  z as isPlainObject,
} from "./__23tanstack-start-server-fn-resolver-CRZD-Up_.js";
import { _ as redirect, h as isRedirect } from "./createServerFn-Df2o8xb7.js";
//#region node_modules/drizzle-orm/entity.js
var entityKind = Symbol.for("drizzle:entityKind");
function is(value, type) {
  if (!value || typeof value !== "object") return false;
  if (value instanceof type) return true;
  if (!Object.prototype.hasOwnProperty.call(type, entityKind))
    throw new Error(
      `Class "${type.name ?? "<unknown>"}" doesn't look like a Drizzle entity. If this is incorrect and the class is provided by Drizzle, please report this as a bug.`,
    );
  let cls = Object.getPrototypeOf(value).constructor;
  if (cls)
    while (cls) {
      if (entityKind in cls && cls[entityKind] === type[entityKind]) return true;
      cls = Object.getPrototypeOf(cls);
    }
  return false;
}
//#endregion
//#region node_modules/drizzle-orm/table.utils.js
var TableName = Symbol.for("drizzle:Name");
//#endregion
//#region node_modules/drizzle-orm/table.js
var Schema = Symbol.for("drizzle:Schema");
var Columns = Symbol.for("drizzle:Columns");
var ExtraConfigColumns = Symbol.for("drizzle:ExtraConfigColumns");
var OriginalName = Symbol.for("drizzle:OriginalName");
var BaseName = Symbol.for("drizzle:BaseName");
var IsAlias = Symbol.for("drizzle:IsAlias");
var ExtraConfigBuilder = Symbol.for("drizzle:ExtraConfigBuilder");
var IsDrizzleTable = Symbol.for("drizzle:IsDrizzleTable");
var Table = class {
  static [entityKind] = "Table";
  /** @internal */
  static Symbol = {
    Name: TableName,
    Schema,
    OriginalName,
    Columns,
    ExtraConfigColumns,
    BaseName,
    IsAlias,
    ExtraConfigBuilder,
  };
  /**
   * @internal
   * Can be changed if the table is aliased.
   */
  [TableName];
  /**
   * @internal
   * Used to store the original name of the table, before any aliasing.
   */
  [OriginalName];
  /** @internal */
  [Schema];
  /** @internal */
  [Columns];
  /** @internal */
  [ExtraConfigColumns];
  /**
   *  @internal
   * Used to store the table name before the transformation via the `tableCreator` functions.
   */
  [BaseName];
  /** @internal */
  [IsAlias] = false;
  /** @internal */
  [IsDrizzleTable] = true;
  /** @internal */
  [ExtraConfigBuilder] = void 0;
  constructor(name, schema, baseName) {
    this[TableName] = this[OriginalName] = name;
    this[Schema] = schema;
    this[BaseName] = baseName;
  }
};
function getTableName(table) {
  return table[TableName];
}
function getTableUniqueName(table) {
  return `${table[Schema] ?? "public"}.${table[TableName]}`;
}
//#endregion
//#region node_modules/drizzle-orm/column.js
var Column = class {
  constructor(table, config) {
    this.table = table;
    this.config = config;
    this.name = config.name;
    this.keyAsName = config.keyAsName;
    this.notNull = config.notNull;
    this.default = config.default;
    this.defaultFn = config.defaultFn;
    this.onUpdateFn = config.onUpdateFn;
    this.hasDefault = config.hasDefault;
    this.primary = config.primaryKey;
    this.isUnique = config.isUnique;
    this.uniqueName = config.uniqueName;
    this.uniqueType = config.uniqueType;
    this.dataType = config.dataType;
    this.columnType = config.columnType;
    this.generated = config.generated;
    this.generatedIdentity = config.generatedIdentity;
  }
  static [entityKind] = "Column";
  name;
  keyAsName;
  primary;
  notNull;
  default;
  defaultFn;
  onUpdateFn;
  hasDefault;
  isUnique;
  uniqueName;
  uniqueType;
  dataType;
  columnType;
  enumValues = void 0;
  generated = void 0;
  generatedIdentity = void 0;
  config;
  mapFromDriverValue(value) {
    return value;
  }
  mapToDriverValue(value) {
    return value;
  }
  shouldDisableInsert() {
    return this.config.generated !== void 0 && this.config.generated.type !== "byDefault";
  }
};
//#endregion
//#region node_modules/drizzle-orm/column-builder.js
var ColumnBuilder = class {
  static [entityKind] = "ColumnBuilder";
  config;
  constructor(name, dataType, columnType) {
    this.config = {
      name,
      keyAsName: name === "",
      notNull: false,
      default: void 0,
      hasDefault: false,
      primaryKey: false,
      isUnique: false,
      uniqueName: void 0,
      uniqueType: void 0,
      dataType,
      columnType,
      generated: void 0,
    };
  }
  /**
   * Changes the data type of the column. Commonly used with `json` columns. Also, useful for branded types.
   *
   * @example
   * ```ts
   * const users = pgTable('users', {
   * 	id: integer('id').$type<UserId>().primaryKey(),
   * 	details: json('details').$type<UserDetails>().notNull(),
   * });
   * ```
   */
  $type() {
    return this;
  }
  /**
   * Adds a `not null` clause to the column definition.
   *
   * Affects the `select` model of the table - columns *without* `not null` will be nullable on select.
   */
  notNull() {
    this.config.notNull = true;
    return this;
  }
  /**
   * Adds a `default <value>` clause to the column definition.
   *
   * Affects the `insert` model of the table - columns *with* `default` are optional on insert.
   *
   * If you need to set a dynamic default value, use {@link $defaultFn} instead.
   */
  default(value) {
    this.config.default = value;
    this.config.hasDefault = true;
    return this;
  }
  /**
   * Adds a dynamic default value to the column.
   * The function will be called when the row is inserted, and the returned value will be used as the column value.
   *
   * **Note:** This value does not affect the `drizzle-kit` behavior, it is only used at runtime in `drizzle-orm`.
   */
  $defaultFn(fn) {
    this.config.defaultFn = fn;
    this.config.hasDefault = true;
    return this;
  }
  /**
   * Alias for {@link $defaultFn}.
   */
  $default = this.$defaultFn;
  /**
   * Adds a dynamic update value to the column.
   * The function will be called when the row is updated, and the returned value will be used as the column value if none is provided.
   * If no `default` (or `$defaultFn`) value is provided, the function will be called when the row is inserted as well, and the returned value will be used as the column value.
   *
   * **Note:** This value does not affect the `drizzle-kit` behavior, it is only used at runtime in `drizzle-orm`.
   */
  $onUpdateFn(fn) {
    this.config.onUpdateFn = fn;
    this.config.hasDefault = true;
    return this;
  }
  /**
   * Alias for {@link $onUpdateFn}.
   */
  $onUpdate = this.$onUpdateFn;
  /**
   * Adds a `primary key` clause to the column definition. This implicitly makes the column `not null`.
   *
   * In SQLite, `integer primary key` implicitly makes the column auto-incrementing.
   */
  primaryKey() {
    this.config.primaryKey = true;
    this.config.notNull = true;
    return this;
  }
  /** @internal Sets the name of the column to the key within the table definition if a name was not given. */
  setName(name) {
    if (this.config.name !== "") return;
    this.config.name = name;
  }
};
//#endregion
//#region node_modules/drizzle-orm/pg-core/columns/enum.js
var isPgEnumSym = Symbol.for("drizzle:isPgEnum");
function isPgEnum(obj) {
  return !!obj && typeof obj === "function" && isPgEnumSym in obj && obj[isPgEnumSym] === true;
}
//#endregion
//#region node_modules/drizzle-orm/subquery.js
var Subquery = class {
  static [entityKind] = "Subquery";
  constructor(sql, fields, alias, isWith = false, usedTables = []) {
    this._ = {
      brand: "Subquery",
      sql,
      selectedFields: fields,
      alias,
      isWith,
      usedTables,
    };
  }
};
var WithSubquery = class extends Subquery {
  static [entityKind] = "WithSubquery";
};
//#endregion
//#region node_modules/drizzle-orm/tracing.js
var tracer = {
  startActiveSpan(name, fn) {
    return fn();
  },
};
//#endregion
//#region node_modules/drizzle-orm/view-common.js
var ViewBaseConfig = Symbol.for("drizzle:ViewBaseConfig");
//#endregion
//#region node_modules/drizzle-orm/sql/sql.js
function isSQLWrapper(value) {
  return value !== null && value !== void 0 && typeof value.getSQL === "function";
}
function mergeQueries(queries) {
  const result = {
    sql: "",
    params: [],
  };
  for (const query of queries) {
    result.sql += query.sql;
    result.params.push(...query.params);
    if (query.typings?.length) {
      if (!result.typings) result.typings = [];
      result.typings.push(...query.typings);
    }
  }
  return result;
}
var StringChunk = class {
  static [entityKind] = "StringChunk";
  value;
  constructor(value) {
    this.value = Array.isArray(value) ? value : [value];
  }
  getSQL() {
    return new SQL([this]);
  }
};
var SQL = class SQL {
  constructor(queryChunks) {
    this.queryChunks = queryChunks;
    for (const chunk of queryChunks)
      if (is(chunk, Table)) {
        const schemaName = chunk[Table.Symbol.Schema];
        this.usedTables.push(
          schemaName === void 0
            ? chunk[Table.Symbol.Name]
            : schemaName + "." + chunk[Table.Symbol.Name],
        );
      }
  }
  static [entityKind] = "SQL";
  /** @internal */
  decoder = noopDecoder;
  shouldInlineParams = false;
  /** @internal */
  usedTables = [];
  append(query) {
    this.queryChunks.push(...query.queryChunks);
    return this;
  }
  toQuery(config) {
    return tracer.startActiveSpan("drizzle.buildSQL", (span) => {
      const query = this.buildQueryFromSourceParams(this.queryChunks, config);
      span?.setAttributes({
        "drizzle.query.text": query.sql,
        "drizzle.query.params": JSON.stringify(query.params),
      });
      return query;
    });
  }
  buildQueryFromSourceParams(chunks, _config) {
    const config = Object.assign({}, _config, {
      inlineParams: _config.inlineParams || this.shouldInlineParams,
      paramStartIndex: _config.paramStartIndex || { value: 0 },
    });
    const { casing, escapeName, escapeParam, prepareTyping, inlineParams, paramStartIndex } =
      config;
    return mergeQueries(
      chunks.map((chunk) => {
        if (is(chunk, StringChunk))
          return {
            sql: chunk.value.join(""),
            params: [],
          };
        if (is(chunk, Name))
          return {
            sql: escapeName(chunk.value),
            params: [],
          };
        if (chunk === void 0)
          return {
            sql: "",
            params: [],
          };
        if (Array.isArray(chunk)) {
          const result = [new StringChunk("(")];
          for (const [i, p] of chunk.entries()) {
            result.push(p);
            if (i < chunk.length - 1) result.push(new StringChunk(", "));
          }
          result.push(new StringChunk(")"));
          return this.buildQueryFromSourceParams(result, config);
        }
        if (is(chunk, SQL))
          return this.buildQueryFromSourceParams(chunk.queryChunks, {
            ...config,
            inlineParams: inlineParams || chunk.shouldInlineParams,
          });
        if (is(chunk, Table)) {
          const schemaName = chunk[Table.Symbol.Schema];
          const tableName = chunk[Table.Symbol.Name];
          return {
            sql:
              schemaName === void 0 || chunk[IsAlias]
                ? escapeName(tableName)
                : escapeName(schemaName) + "." + escapeName(tableName),
            params: [],
          };
        }
        if (is(chunk, Column)) {
          const columnName = casing.getColumnCasing(chunk);
          if (_config.invokeSource === "indexes")
            return {
              sql: escapeName(columnName),
              params: [],
            };
          const schemaName = chunk.table[Table.Symbol.Schema];
          return {
            sql:
              chunk.table[IsAlias] || schemaName === void 0
                ? escapeName(chunk.table[Table.Symbol.Name]) + "." + escapeName(columnName)
                : escapeName(schemaName) +
                  "." +
                  escapeName(chunk.table[Table.Symbol.Name]) +
                  "." +
                  escapeName(columnName),
            params: [],
          };
        }
        if (is(chunk, View)) {
          const schemaName = chunk[ViewBaseConfig].schema;
          const viewName = chunk[ViewBaseConfig].name;
          return {
            sql:
              schemaName === void 0 || chunk[ViewBaseConfig].isAlias
                ? escapeName(viewName)
                : escapeName(schemaName) + "." + escapeName(viewName),
            params: [],
          };
        }
        if (is(chunk, Param)) {
          if (is(chunk.value, Placeholder))
            return {
              sql: escapeParam(paramStartIndex.value++, chunk),
              params: [chunk],
              typings: ["none"],
            };
          const mappedValue =
            chunk.value === null ? null : chunk.encoder.mapToDriverValue(chunk.value);
          if (is(mappedValue, SQL)) return this.buildQueryFromSourceParams([mappedValue], config);
          if (inlineParams)
            return {
              sql: this.mapInlineParam(mappedValue, config),
              params: [],
            };
          let typings = ["none"];
          if (prepareTyping) typings = [prepareTyping(chunk.encoder)];
          return {
            sql: escapeParam(paramStartIndex.value++, mappedValue),
            params: [mappedValue],
            typings,
          };
        }
        if (is(chunk, Placeholder))
          return {
            sql: escapeParam(paramStartIndex.value++, chunk),
            params: [chunk],
            typings: ["none"],
          };
        if (is(chunk, SQL.Aliased) && chunk.fieldAlias !== void 0)
          return {
            sql: escapeName(chunk.fieldAlias),
            params: [],
          };
        if (is(chunk, Subquery)) {
          if (chunk._.isWith)
            return {
              sql: escapeName(chunk._.alias),
              params: [],
            };
          return this.buildQueryFromSourceParams(
            [new StringChunk("("), chunk._.sql, new StringChunk(") "), new Name(chunk._.alias)],
            config,
          );
        }
        if (isPgEnum(chunk)) {
          if (chunk.schema)
            return {
              sql: escapeName(chunk.schema) + "." + escapeName(chunk.enumName),
              params: [],
            };
          return {
            sql: escapeName(chunk.enumName),
            params: [],
          };
        }
        if (isSQLWrapper(chunk)) {
          if (chunk.shouldOmitSQLParens?.())
            return this.buildQueryFromSourceParams([chunk.getSQL()], config);
          return this.buildQueryFromSourceParams(
            [new StringChunk("("), chunk.getSQL(), new StringChunk(")")],
            config,
          );
        }
        if (inlineParams)
          return {
            sql: this.mapInlineParam(chunk, config),
            params: [],
          };
        return {
          sql: escapeParam(paramStartIndex.value++, chunk),
          params: [chunk],
          typings: ["none"],
        };
      }),
    );
  }
  mapInlineParam(chunk, { escapeString }) {
    if (chunk === null) return "null";
    if (typeof chunk === "number" || typeof chunk === "boolean") return chunk.toString();
    if (typeof chunk === "string") return escapeString(chunk);
    if (typeof chunk === "object") {
      const mappedValueAsString = chunk.toString();
      if (mappedValueAsString === "[object Object]") return escapeString(JSON.stringify(chunk));
      return escapeString(mappedValueAsString);
    }
    throw new Error("Unexpected param value: " + chunk);
  }
  getSQL() {
    return this;
  }
  as(alias) {
    if (alias === void 0) return this;
    return new SQL.Aliased(this, alias);
  }
  mapWith(decoder) {
    this.decoder = typeof decoder === "function" ? { mapFromDriverValue: decoder } : decoder;
    return this;
  }
  inlineParams() {
    this.shouldInlineParams = true;
    return this;
  }
  /**
   * This method is used to conditionally include a part of the query.
   *
   * @param condition - Condition to check
   * @returns itself if the condition is `true`, otherwise `undefined`
   */
  if(condition) {
    return condition ? this : void 0;
  }
};
var Name = class {
  constructor(value) {
    this.value = value;
  }
  static [entityKind] = "Name";
  brand;
  getSQL() {
    return new SQL([this]);
  }
};
function isDriverValueEncoder(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "mapToDriverValue" in value &&
    typeof value.mapToDriverValue === "function"
  );
}
var noopDecoder = { mapFromDriverValue: (value) => value };
var noopEncoder = { mapToDriverValue: (value) => value };
({
  ...noopDecoder,
  ...noopEncoder,
});
var Param = class {
  /**
   * @param value - Parameter value
   * @param encoder - Encoder to convert the value to a driver parameter
   */
  constructor(value, encoder = noopEncoder) {
    this.value = value;
    this.encoder = encoder;
  }
  static [entityKind] = "Param";
  brand;
  getSQL() {
    return new SQL([this]);
  }
};
function sql(strings, ...params) {
  const queryChunks = [];
  if (params.length > 0 || (strings.length > 0 && strings[0] !== ""))
    queryChunks.push(new StringChunk(strings[0]));
  for (const [paramIndex, param2] of params.entries())
    queryChunks.push(param2, new StringChunk(strings[paramIndex + 1]));
  return new SQL(queryChunks);
}
((sql2) => {
  function empty() {
    return new SQL([]);
  }
  sql2.empty = empty;
  function fromList(list) {
    return new SQL(list);
  }
  sql2.fromList = fromList;
  function raw(str) {
    return new SQL([new StringChunk(str)]);
  }
  sql2.raw = raw;
  function join(chunks, separator) {
    const result = [];
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0 && separator !== void 0) result.push(separator);
      result.push(chunk);
    }
    return new SQL(result);
  }
  sql2.join = join;
  function identifier(value) {
    return new Name(value);
  }
  sql2.identifier = identifier;
  function placeholder2(name2) {
    return new Placeholder(name2);
  }
  sql2.placeholder = placeholder2;
  function param2(value, encoder) {
    return new Param(value, encoder);
  }
  sql2.param = param2;
})(sql || (sql = {}));
((SQL2) => {
  class Aliased {
    constructor(sql2, fieldAlias) {
      this.sql = sql2;
      this.fieldAlias = fieldAlias;
    }
    static [entityKind] = "SQL.Aliased";
    /** @internal */
    isSelectionField = false;
    getSQL() {
      return this.sql;
    }
    /** @internal */
    clone() {
      return new Aliased(this.sql, this.fieldAlias);
    }
  }
  SQL2.Aliased = Aliased;
})(SQL || (SQL = {}));
var Placeholder = class {
  constructor(name2) {
    this.name = name2;
  }
  static [entityKind] = "Placeholder";
  getSQL() {
    return new SQL([this]);
  }
};
function fillPlaceholders(params, values) {
  return params.map((p) => {
    if (is(p, Placeholder)) {
      if (!(p.name in values)) throw new Error(`No value for placeholder "${p.name}" was provided`);
      return values[p.name];
    }
    if (is(p, Param) && is(p.value, Placeholder)) {
      if (!(p.value.name in values))
        throw new Error(`No value for placeholder "${p.value.name}" was provided`);
      return p.encoder.mapToDriverValue(values[p.value.name]);
    }
    return p;
  });
}
var IsDrizzleView = Symbol.for("drizzle:IsDrizzleView");
var View = class {
  static [entityKind] = "View";
  /** @internal */
  [ViewBaseConfig];
  /** @internal */
  [IsDrizzleView] = true;
  constructor({ name: name2, schema, selectedFields, query }) {
    this[ViewBaseConfig] = {
      name: name2,
      originalName: name2,
      schema,
      selectedFields,
      query,
      isExisting: !query,
      isAlias: false,
    };
  }
  getSQL() {
    return new SQL([this]);
  }
};
Column.prototype.getSQL = function () {
  return new SQL([this]);
};
Table.prototype.getSQL = function () {
  return new SQL([this]);
};
Subquery.prototype.getSQL = function () {
  return new SQL([this]);
};
//#endregion
//#region node_modules/drizzle-orm/utils.js
function mapResultRow(columns, row, joinsNotNullableMap) {
  const nullifyMap = {};
  const result = columns.reduce((result2, { path, field }, columnIndex) => {
    let decoder;
    if (is(field, Column)) decoder = field;
    else if (is(field, SQL)) decoder = field.decoder;
    else if (is(field, Subquery)) decoder = field._.sql.decoder;
    else decoder = field.sql.decoder;
    let node = result2;
    for (const [pathChunkIndex, pathChunk] of path.entries())
      if (pathChunkIndex < path.length - 1) {
        if (!(pathChunk in node)) node[pathChunk] = {};
        node = node[pathChunk];
      } else {
        const rawValue = row[columnIndex];
        const value = (node[pathChunk] =
          rawValue === null ? null : decoder.mapFromDriverValue(rawValue));
        if (joinsNotNullableMap && is(field, Column) && path.length === 2) {
          const objectName = path[0];
          if (!(objectName in nullifyMap))
            nullifyMap[objectName] = value === null ? getTableName(field.table) : false;
          else if (
            typeof nullifyMap[objectName] === "string" &&
            nullifyMap[objectName] !== getTableName(field.table)
          )
            nullifyMap[objectName] = false;
        }
      }
    return result2;
  }, {});
  if (joinsNotNullableMap && Object.keys(nullifyMap).length > 0) {
    for (const [objectName, tableName] of Object.entries(nullifyMap))
      if (typeof tableName === "string" && !joinsNotNullableMap[tableName])
        result[objectName] = null;
  }
  return result;
}
function orderSelectedFields(fields, pathPrefix) {
  return Object.entries(fields).reduce((result, [name, field]) => {
    if (typeof name !== "string") return result;
    const newPath = pathPrefix ? [...pathPrefix, name] : [name];
    if (is(field, Column) || is(field, SQL) || is(field, SQL.Aliased) || is(field, Subquery))
      result.push({
        path: newPath,
        field,
      });
    else if (is(field, Table))
      result.push(...orderSelectedFields(field[Table.Symbol.Columns], newPath));
    else result.push(...orderSelectedFields(field, newPath));
    return result;
  }, []);
}
function haveSameKeys(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const [index, key] of leftKeys.entries()) if (key !== rightKeys[index]) return false;
  return true;
}
function mapUpdateSet(table, values) {
  const entries = Object.entries(values)
    .filter(([, value]) => value !== void 0)
    .map(([key, value]) => {
      if (is(value, SQL) || is(value, Column)) return [key, value];
      else return [key, new Param(value, table[Table.Symbol.Columns][key])];
    });
  if (entries.length === 0) throw new Error("No values to set");
  return Object.fromEntries(entries);
}
function applyMixins(baseClass, extendedClasses) {
  for (const extendedClass of extendedClasses)
    for (const name of Object.getOwnPropertyNames(extendedClass.prototype)) {
      if (name === "constructor") continue;
      Object.defineProperty(
        baseClass.prototype,
        name,
        Object.getOwnPropertyDescriptor(extendedClass.prototype, name) ||
          /* @__PURE__ */ Object.create(null),
      );
    }
}
function getTableColumns(table) {
  return table[Table.Symbol.Columns];
}
function getTableLikeName(table) {
  return is(table, Subquery)
    ? table._.alias
    : is(table, View)
      ? table[ViewBaseConfig].name
      : is(table, SQL)
        ? void 0
        : table[Table.Symbol.IsAlias]
          ? table[Table.Symbol.Name]
          : table[Table.Symbol.BaseName];
}
function getColumnNameAndConfig(a, b) {
  return {
    name: typeof a === "string" && a.length > 0 ? a : "",
    config: typeof a === "object" ? a : b,
  };
}
var textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder();
//#endregion
//#region node_modules/drizzle-orm/sql/expressions/conditions.js
function bindIfParam(value, column) {
  if (
    isDriverValueEncoder(column) &&
    !isSQLWrapper(value) &&
    !is(value, Param) &&
    !is(value, Placeholder) &&
    !is(value, Column) &&
    !is(value, Table) &&
    !is(value, View)
  )
    return new Param(value, column);
  return value;
}
var eq = (left, right) => {
  return sql`${left} = ${bindIfParam(right, left)}`;
};
var ne = (left, right) => {
  return sql`${left} <> ${bindIfParam(right, left)}`;
};
function and(...unfilteredConditions) {
  const conditions = unfilteredConditions.filter((c) => c !== void 0);
  if (conditions.length === 0) return;
  if (conditions.length === 1) return new SQL(conditions);
  return new SQL([
    new StringChunk("("),
    sql.join(conditions, new StringChunk(" and ")),
    new StringChunk(")"),
  ]);
}
function or(...unfilteredConditions) {
  const conditions = unfilteredConditions.filter((c) => c !== void 0);
  if (conditions.length === 0) return;
  if (conditions.length === 1) return new SQL(conditions);
  return new SQL([
    new StringChunk("("),
    sql.join(conditions, new StringChunk(" or ")),
    new StringChunk(")"),
  ]);
}
function not(condition) {
  return sql`not ${condition}`;
}
var gt = (left, right) => {
  return sql`${left} > ${bindIfParam(right, left)}`;
};
var gte = (left, right) => {
  return sql`${left} >= ${bindIfParam(right, left)}`;
};
var lt = (left, right) => {
  return sql`${left} < ${bindIfParam(right, left)}`;
};
var lte = (left, right) => {
  return sql`${left} <= ${bindIfParam(right, left)}`;
};
function inArray(column, values) {
  if (Array.isArray(values)) {
    if (values.length === 0) return sql`false`;
    return sql`${column} in ${values.map((v) => bindIfParam(v, column))}`;
  }
  return sql`${column} in ${bindIfParam(values, column)}`;
}
function notInArray(column, values) {
  if (Array.isArray(values)) {
    if (values.length === 0) return sql`true`;
    return sql`${column} not in ${values.map((v) => bindIfParam(v, column))}`;
  }
  return sql`${column} not in ${bindIfParam(values, column)}`;
}
function isNull(value) {
  return sql`${value} is null`;
}
function isNotNull(value) {
  return sql`${value} is not null`;
}
function exists(subquery) {
  return sql`exists ${subquery}`;
}
function notExists(subquery) {
  return sql`not exists ${subquery}`;
}
function between(column, min, max) {
  return sql`${column} between ${bindIfParam(min, column)} and ${bindIfParam(max, column)}`;
}
function notBetween(column, min, max) {
  return sql`${column} not between ${bindIfParam(min, column)} and ${bindIfParam(max, column)}`;
}
function like(column, value) {
  return sql`${column} like ${value}`;
}
function notLike(column, value) {
  return sql`${column} not like ${value}`;
}
function ilike(column, value) {
  return sql`${column} ilike ${value}`;
}
function notIlike(column, value) {
  return sql`${column} not ilike ${value}`;
}
//#endregion
//#region node_modules/drizzle-orm/sql/expressions/select.js
function asc(column) {
  return sql`${column} asc`;
}
function desc(column) {
  return sql`${column} desc`;
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/foreign-keys.js
var ForeignKeyBuilder = class {
  static [entityKind] = "SQLiteForeignKeyBuilder";
  /** @internal */
  reference;
  /** @internal */
  _onUpdate;
  /** @internal */
  _onDelete;
  constructor(config, actions) {
    this.reference = () => {
      const { name, columns, foreignColumns } = config();
      return {
        name,
        columns,
        foreignTable: foreignColumns[0].table,
        foreignColumns,
      };
    };
    if (actions) {
      this._onUpdate = actions.onUpdate;
      this._onDelete = actions.onDelete;
    }
  }
  onUpdate(action) {
    this._onUpdate = action;
    return this;
  }
  onDelete(action) {
    this._onDelete = action;
    return this;
  }
  /** @internal */
  build(table) {
    return new ForeignKey(table, this);
  }
};
var ForeignKey = class {
  constructor(table, builder) {
    this.table = table;
    this.reference = builder.reference;
    this.onUpdate = builder._onUpdate;
    this.onDelete = builder._onDelete;
  }
  static [entityKind] = "SQLiteForeignKey";
  reference;
  onUpdate;
  onDelete;
  getName() {
    const { name, columns, foreignColumns } = this.reference();
    const columnNames = columns.map((column) => column.name);
    const foreignColumnNames = foreignColumns.map((column) => column.name);
    const chunks = [
      this.table[TableName],
      ...columnNames,
      foreignColumns[0].table[TableName],
      ...foreignColumnNames,
    ];
    return name ?? `${chunks.join("_")}_fk`;
  }
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/unique-constraint.js
function uniqueKeyName(table, columns) {
  return `${table[TableName]}_${columns.join("_")}_unique`;
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/common.js
var SQLiteColumnBuilder = class extends ColumnBuilder {
  static [entityKind] = "SQLiteColumnBuilder";
  foreignKeyConfigs = [];
  references(ref, actions = {}) {
    this.foreignKeyConfigs.push({
      ref,
      actions,
    });
    return this;
  }
  unique(name) {
    this.config.isUnique = true;
    this.config.uniqueName = name;
    return this;
  }
  generatedAlwaysAs(as, config) {
    this.config.generated = {
      as,
      type: "always",
      mode: config?.mode ?? "virtual",
    };
    return this;
  }
  /** @internal */
  buildForeignKeys(column, table) {
    return this.foreignKeyConfigs.map(({ ref, actions }) => {
      return ((ref2, actions2) => {
        const builder = new ForeignKeyBuilder(() => {
          const foreignColumn = ref2();
          return {
            columns: [column],
            foreignColumns: [foreignColumn],
          };
        });
        if (actions2.onUpdate) builder.onUpdate(actions2.onUpdate);
        if (actions2.onDelete) builder.onDelete(actions2.onDelete);
        return builder.build(table);
      })(ref, actions);
    });
  }
};
var SQLiteColumn = class extends Column {
  constructor(table, config) {
    if (!config.uniqueName) config.uniqueName = uniqueKeyName(table, [config.name]);
    super(table, config);
    this.table = table;
  }
  static [entityKind] = "SQLiteColumn";
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/blob.js
var SQLiteBigIntBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBigIntBuilder";
  constructor(name) {
    super(name, "bigint", "SQLiteBigInt");
  }
  /** @internal */
  build(table) {
    return new SQLiteBigInt(table, this.config);
  }
};
var SQLiteBigInt = class extends SQLiteColumn {
  static [entityKind] = "SQLiteBigInt";
  getSQLType() {
    return "blob";
  }
  mapFromDriverValue(value) {
    if (typeof Buffer !== "undefined" && Buffer.from) {
      const buf = Buffer.isBuffer(value)
        ? value
        : value instanceof ArrayBuffer
          ? Buffer.from(value)
          : value.buffer
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : Buffer.from(value);
      return BigInt(buf.toString("utf8"));
    }
    return BigInt(textDecoder.decode(value));
  }
  mapToDriverValue(value) {
    return Buffer.from(value.toString());
  }
};
var SQLiteBlobJsonBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBlobJsonBuilder";
  constructor(name) {
    super(name, "json", "SQLiteBlobJson");
  }
  /** @internal */
  build(table) {
    return new SQLiteBlobJson(table, this.config);
  }
};
var SQLiteBlobJson = class extends SQLiteColumn {
  static [entityKind] = "SQLiteBlobJson";
  getSQLType() {
    return "blob";
  }
  mapFromDriverValue(value) {
    if (typeof Buffer !== "undefined" && Buffer.from) {
      const buf = Buffer.isBuffer(value)
        ? value
        : value instanceof ArrayBuffer
          ? Buffer.from(value)
          : value.buffer
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : Buffer.from(value);
      return JSON.parse(buf.toString("utf8"));
    }
    return JSON.parse(textDecoder.decode(value));
  }
  mapToDriverValue(value) {
    return Buffer.from(JSON.stringify(value));
  }
};
var SQLiteBlobBufferBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBlobBufferBuilder";
  constructor(name) {
    super(name, "buffer", "SQLiteBlobBuffer");
  }
  /** @internal */
  build(table) {
    return new SQLiteBlobBuffer(table, this.config);
  }
};
var SQLiteBlobBuffer = class extends SQLiteColumn {
  static [entityKind] = "SQLiteBlobBuffer";
  mapFromDriverValue(value) {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value);
  }
  getSQLType() {
    return "blob";
  }
};
function blob(a, b) {
  const { name, config } = getColumnNameAndConfig(a, b);
  if (config?.mode === "json") return new SQLiteBlobJsonBuilder(name);
  if (config?.mode === "bigint") return new SQLiteBigIntBuilder(name);
  return new SQLiteBlobBufferBuilder(name);
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/custom.js
var SQLiteCustomColumnBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteCustomColumnBuilder";
  constructor(name, fieldConfig, customTypeParams) {
    super(name, "custom", "SQLiteCustomColumn");
    this.config.fieldConfig = fieldConfig;
    this.config.customTypeParams = customTypeParams;
  }
  /** @internal */
  build(table) {
    return new SQLiteCustomColumn(table, this.config);
  }
};
var SQLiteCustomColumn = class extends SQLiteColumn {
  static [entityKind] = "SQLiteCustomColumn";
  sqlName;
  mapTo;
  mapFrom;
  constructor(table, config) {
    super(table, config);
    this.sqlName = config.customTypeParams.dataType(config.fieldConfig);
    this.mapTo = config.customTypeParams.toDriver;
    this.mapFrom = config.customTypeParams.fromDriver;
  }
  getSQLType() {
    return this.sqlName;
  }
  mapFromDriverValue(value) {
    return typeof this.mapFrom === "function" ? this.mapFrom(value) : value;
  }
  mapToDriverValue(value) {
    return typeof this.mapTo === "function" ? this.mapTo(value) : value;
  }
};
function customType(customTypeParams) {
  return (a, b) => {
    const { name, config } = getColumnNameAndConfig(a, b);
    return new SQLiteCustomColumnBuilder(name, config, customTypeParams);
  };
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/integer.js
var SQLiteBaseIntegerBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBaseIntegerBuilder";
  constructor(name, dataType, columnType) {
    super(name, dataType, columnType);
    this.config.autoIncrement = false;
  }
  primaryKey(config) {
    if (config?.autoIncrement) this.config.autoIncrement = true;
    this.config.hasDefault = true;
    return super.primaryKey();
  }
};
var SQLiteBaseInteger = class extends SQLiteColumn {
  static [entityKind] = "SQLiteBaseInteger";
  autoIncrement = this.config.autoIncrement;
  getSQLType() {
    return "integer";
  }
};
var SQLiteIntegerBuilder = class extends SQLiteBaseIntegerBuilder {
  static [entityKind] = "SQLiteIntegerBuilder";
  constructor(name) {
    super(name, "number", "SQLiteInteger");
  }
  build(table) {
    return new SQLiteInteger(table, this.config);
  }
};
var SQLiteInteger = class extends SQLiteBaseInteger {
  static [entityKind] = "SQLiteInteger";
};
var SQLiteTimestampBuilder = class extends SQLiteBaseIntegerBuilder {
  static [entityKind] = "SQLiteTimestampBuilder";
  constructor(name, mode) {
    super(name, "date", "SQLiteTimestamp");
    this.config.mode = mode;
  }
  /**
   * @deprecated Use `default()` with your own expression instead.
   *
   * Adds `DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))` to the column, which is the current epoch timestamp in milliseconds.
   */
  defaultNow() {
    return this.default(sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`);
  }
  build(table) {
    return new SQLiteTimestamp(table, this.config);
  }
};
var SQLiteTimestamp = class extends SQLiteBaseInteger {
  static [entityKind] = "SQLiteTimestamp";
  mode = this.config.mode;
  mapFromDriverValue(value) {
    if (this.config.mode === "timestamp") return /* @__PURE__ */ new Date(value * 1e3);
    return new Date(value);
  }
  mapToDriverValue(value) {
    const unix = value.getTime();
    if (this.config.mode === "timestamp") return Math.floor(unix / 1e3);
    return unix;
  }
};
var SQLiteBooleanBuilder = class extends SQLiteBaseIntegerBuilder {
  static [entityKind] = "SQLiteBooleanBuilder";
  constructor(name, mode) {
    super(name, "boolean", "SQLiteBoolean");
    this.config.mode = mode;
  }
  build(table) {
    return new SQLiteBoolean(table, this.config);
  }
};
var SQLiteBoolean = class extends SQLiteBaseInteger {
  static [entityKind] = "SQLiteBoolean";
  mode = this.config.mode;
  mapFromDriverValue(value) {
    return Number(value) === 1;
  }
  mapToDriverValue(value) {
    return value ? 1 : 0;
  }
};
function integer(a, b) {
  const { name, config } = getColumnNameAndConfig(a, b);
  if (config?.mode === "timestamp" || config?.mode === "timestamp_ms")
    return new SQLiteTimestampBuilder(name, config.mode);
  if (config?.mode === "boolean") return new SQLiteBooleanBuilder(name, config.mode);
  return new SQLiteIntegerBuilder(name);
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/numeric.js
var SQLiteNumericBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteNumericBuilder";
  constructor(name) {
    super(name, "string", "SQLiteNumeric");
  }
  /** @internal */
  build(table) {
    return new SQLiteNumeric(table, this.config);
  }
};
var SQLiteNumeric = class extends SQLiteColumn {
  static [entityKind] = "SQLiteNumeric";
  mapFromDriverValue(value) {
    if (typeof value === "string") return value;
    return String(value);
  }
  getSQLType() {
    return "numeric";
  }
};
var SQLiteNumericNumberBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteNumericNumberBuilder";
  constructor(name) {
    super(name, "number", "SQLiteNumericNumber");
  }
  /** @internal */
  build(table) {
    return new SQLiteNumericNumber(table, this.config);
  }
};
var SQLiteNumericNumber = class extends SQLiteColumn {
  static [entityKind] = "SQLiteNumericNumber";
  mapFromDriverValue(value) {
    if (typeof value === "number") return value;
    return Number(value);
  }
  mapToDriverValue = String;
  getSQLType() {
    return "numeric";
  }
};
var SQLiteNumericBigIntBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteNumericBigIntBuilder";
  constructor(name) {
    super(name, "bigint", "SQLiteNumericBigInt");
  }
  /** @internal */
  build(table) {
    return new SQLiteNumericBigInt(table, this.config);
  }
};
var SQLiteNumericBigInt = class extends SQLiteColumn {
  static [entityKind] = "SQLiteNumericBigInt";
  mapFromDriverValue = BigInt;
  mapToDriverValue = String;
  getSQLType() {
    return "numeric";
  }
};
function numeric(a, b) {
  const { name, config } = getColumnNameAndConfig(a, b);
  const mode = config?.mode;
  return mode === "number"
    ? new SQLiteNumericNumberBuilder(name)
    : mode === "bigint"
      ? new SQLiteNumericBigIntBuilder(name)
      : new SQLiteNumericBuilder(name);
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/real.js
var SQLiteRealBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteRealBuilder";
  constructor(name) {
    super(name, "number", "SQLiteReal");
  }
  /** @internal */
  build(table) {
    return new SQLiteReal(table, this.config);
  }
};
var SQLiteReal = class extends SQLiteColumn {
  static [entityKind] = "SQLiteReal";
  getSQLType() {
    return "real";
  }
};
function real(name) {
  return new SQLiteRealBuilder(name ?? "");
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/text.js
var SQLiteTextBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteTextBuilder";
  constructor(name, config) {
    super(name, "string", "SQLiteText");
    this.config.enumValues = config.enum;
    this.config.length = config.length;
  }
  /** @internal */
  build(table) {
    return new SQLiteText(table, this.config);
  }
};
var SQLiteText = class extends SQLiteColumn {
  static [entityKind] = "SQLiteText";
  enumValues = this.config.enumValues;
  length = this.config.length;
  constructor(table, config) {
    super(table, config);
  }
  getSQLType() {
    return `text${this.config.length ? `(${this.config.length})` : ""}`;
  }
};
var SQLiteTextJsonBuilder = class extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteTextJsonBuilder";
  constructor(name) {
    super(name, "json", "SQLiteTextJson");
  }
  /** @internal */
  build(table) {
    return new SQLiteTextJson(table, this.config);
  }
};
var SQLiteTextJson = class extends SQLiteColumn {
  static [entityKind] = "SQLiteTextJson";
  getSQLType() {
    return "text";
  }
  mapFromDriverValue(value) {
    return JSON.parse(value);
  }
  mapToDriverValue(value) {
    return JSON.stringify(value);
  }
};
function text(a, b = {}) {
  const { name, config } = getColumnNameAndConfig(a, b);
  if (config.mode === "json") return new SQLiteTextJsonBuilder(name);
  return new SQLiteTextBuilder(name, config);
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/columns/all.js
function getSQLiteColumnBuilders() {
  return {
    blob,
    customType,
    integer,
    numeric,
    real,
    text,
  };
}
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/table.js
var InlineForeignKeys = Symbol.for("drizzle:SQLiteInlineForeignKeys");
var SQLiteTable = class extends Table {
  static [entityKind] = "SQLiteTable";
  /** @internal */
  static Symbol = Object.assign({}, Table.Symbol, { InlineForeignKeys });
  /** @internal */
  [Table.Symbol.Columns];
  /** @internal */
  [InlineForeignKeys] = [];
  /** @internal */
  [Table.Symbol.ExtraConfigBuilder] = void 0;
};
function sqliteTableBase(name, columns, extraConfig, schema, baseName = name) {
  const rawTable = new SQLiteTable(name, schema, baseName);
  const parsedColumns =
    typeof columns === "function" ? columns(getSQLiteColumnBuilders()) : columns;
  const builtColumns = Object.fromEntries(
    Object.entries(parsedColumns).map(([name2, colBuilderBase]) => {
      const colBuilder = colBuilderBase;
      colBuilder.setName(name2);
      const column = colBuilder.build(rawTable);
      rawTable[InlineForeignKeys].push(...colBuilder.buildForeignKeys(column, rawTable));
      return [name2, column];
    }),
  );
  const table = Object.assign(rawTable, builtColumns);
  table[Table.Symbol.Columns] = builtColumns;
  table[Table.Symbol.ExtraConfigColumns] = builtColumns;
  if (extraConfig) table[SQLiteTable.Symbol.ExtraConfigBuilder] = extraConfig;
  return table;
}
var sqliteTable = (name, columns, extraConfig) => {
  return sqliteTableBase(name, columns, extraConfig);
};
//#endregion
//#region node_modules/drizzle-orm/sqlite-core/indexes.js
var IndexBuilderOn = class {
  constructor(name, unique) {
    this.name = name;
    this.unique = unique;
  }
  static [entityKind] = "SQLiteIndexBuilderOn";
  on(...columns) {
    return new IndexBuilder(this.name, columns, this.unique);
  }
};
var IndexBuilder = class {
  static [entityKind] = "SQLiteIndexBuilder";
  /** @internal */
  config;
  constructor(name, columns, unique) {
    this.config = {
      name,
      columns,
      unique,
      where: void 0,
    };
  }
  /**
   * Condition for partial index.
   */
  where(condition) {
    this.config.where = condition;
    return this;
  }
  /** @internal */
  build(table) {
    return new Index(this.config, table);
  }
};
var Index = class {
  static [entityKind] = "SQLiteIndex";
  config;
  constructor(config, table) {
    this.config = {
      ...config,
      table,
    };
  }
};
function index(name) {
  return new IndexBuilderOn(name, false);
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/scroll-restoration.js
function getSafeSessionStorage() {
  try {
    return typeof window !== "undefined" && typeof window.sessionStorage === "object"
      ? window.sessionStorage
      : void 0;
  } catch {
    return;
  }
}
var storageKey = "tsr-scroll-restoration-v1_3";
function createScrollRestorationCache() {
  const safeSessionStorage = getSafeSessionStorage();
  if (!safeSessionStorage) return null;
  let state = {};
  try {
    const parsed = JSON.parse(safeSessionStorage.getItem("tsr-scroll-restoration-v1_3") || "{}");
    if (isPlainObject(parsed)) state = parsed;
  } catch {}
  const persist = () => {
    try {
      safeSessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {}
  };
  return {
    get state() {
      return state;
    },
    set: (updater) => {
      state = functionalUpdate(updater, state) || state;
    },
    persist,
  };
}
createScrollRestorationCache();
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/qss.js
/**
 * Program is a reimplementation of the `qss` package:
 * Copyright (c) Luke Edwards luke.edwards05@gmail.com, MIT License
 * https://github.com/lukeed/qss/blob/master/license.md
 *
 * This reimplementation uses modern browser APIs
 * (namely URLSearchParams) and TypeScript while still
 * maintaining the original functionality and interface.
 *
 * Update: this implementation has also been mangled to
 * fit exactly our use-case (single value per key in encoding).
 */
/**
 * Encodes an object into a query string.
 * @param obj - The object to encode into a query string.
 * @param stringify - An optional custom stringify function.
 * @returns The encoded query string.
 * @example
 * ```
 * // Example input: encode({ token: 'foo', key: 'value' })
 * // Expected output: "token=foo&key=value"
 * ```
 */
function encode(obj, stringify = String) {
  const result = new URLSearchParams();
  for (const key in obj) {
    const val = obj[key];
    if (val !== void 0) result.set(key, stringify(val));
  }
  return result.toString();
}
/**
 * Converts a string value to its appropriate type (string, number, boolean).
 * @param mix - The string value to convert.
 * @returns The converted value.
 * @example
 * // Example input: toValue("123")
 * // Expected output: 123
 */
function toValue(str) {
  if (!str) return "";
  if (str === "false") return false;
  if (str === "true") return true;
  return +str * 0 === 0 && +str + "" === str ? +str : str;
}
/**
 * Decodes a query string into an object.
 * @param str - The query string to decode.
 * @returns The decoded key-value pairs in an object format.
 * @example
 * // Example input: decode("token=foo&key=value")
 * // Expected output: { "token": "foo", "key": "value" }
 */
function decode(str) {
  const searchParams = new URLSearchParams(str);
  const result = Object.create(null);
  for (const [key, value] of searchParams.entries()) {
    const previousValue = result[key];
    if (previousValue == null) result[key] = toValue(value);
    else if (Array.isArray(previousValue)) previousValue.push(toValue(value));
    else result[key] = [previousValue, toValue(value)];
  }
  return result;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/searchParams.js
/** Default `parseSearch` that strips leading '?' and JSON-parses values. */
var defaultParseSearch = parseSearchWith(JSON.parse);
/** Default `stringifySearch` using JSON.stringify for complex values. */
var defaultStringifySearch = stringifySearchWith(JSON.stringify, JSON.parse);
/**
 * Build a `parseSearch` function using a provided JSON-like parser.
 *
 * The returned function strips a leading `?`, decodes values, and attempts to
 * JSON-parse string values using the given `parser`.
 *
 * @param parser Function to parse a string value (e.g. `JSON.parse`).
 * @returns A `parseSearch` function compatible with `Router` options.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization
 */
function parseSearchWith(parser) {
  return (searchStr) => {
    if (searchStr[0] === "?") searchStr = searchStr.substring(1);
    const query = decode(searchStr);
    for (const key in query) {
      const value = query[key];
      if (typeof value === "string")
        try {
          query[key] = parser(value);
        } catch (_err) {}
    }
    return query;
  };
}
/**
 * Build a `stringifySearch` function using a provided serializer.
 *
 * Non-primitive values are serialized with `stringify`. If a `parser` is
 * supplied, string values that are parseable are re-serialized to ensure
 * symmetry with `parseSearch`.
 *
 * @param stringify Function to serialize a value (e.g. `JSON.stringify`).
 * @param parser Optional parser to detect parseable strings.
 * @returns A `stringifySearch` function compatible with `Router` options.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization
 */
function stringifySearchWith(stringify, parser) {
  const hasParser = typeof parser === "function";
  function stringifyValue(val) {
    if (typeof val === "object" && val !== null)
      try {
        return stringify(val);
      } catch (_err) {}
    else if (hasParser && typeof val === "string")
      try {
        parser(val);
        return stringify(val);
      } catch (_err) {}
    return val;
  }
  return (search) => {
    const searchStr = encode(search, stringifyValue);
    return searchStr ? `?${searchStr}` : "";
  };
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/rewrite.js
/** Compose multiple rewrite pairs into a single in/out rewrite. */
/** Compose multiple rewrite pairs into a single in/out rewrite. */
function composeRewrites(rewrites) {
  return {
    input: ({ url }) => {
      for (const rewrite of rewrites) url = executeRewriteInput(rewrite, url);
      return url;
    },
    output: ({ url }) => {
      for (let i = rewrites.length - 1; i >= 0; i--) url = executeRewriteOutput(rewrites[i], url);
      return url;
    },
  };
}
/** Create a rewrite pair that strips/adds a basepath on input/output. */
/** Create a rewrite pair that strips/adds a basepath on input/output. */
function rewriteBasepath(opts) {
  const trimmedBasepath = trimPath(opts.basepath);
  const normalizedBasepath = `/${trimmedBasepath}`;
  const normalizedBasepathWithSlash = `${normalizedBasepath}/`;
  const checkBasepath = opts.caseSensitive ? normalizedBasepath : normalizedBasepath.toLowerCase();
  const checkBasepathWithSlash = opts.caseSensitive
    ? normalizedBasepathWithSlash
    : normalizedBasepathWithSlash.toLowerCase();
  return {
    input: ({ url }) => {
      const pathname = opts.caseSensitive ? url.pathname : url.pathname.toLowerCase();
      if (pathname === checkBasepath) url.pathname = "/";
      else if (pathname.startsWith(checkBasepathWithSlash))
        url.pathname = url.pathname.slice(normalizedBasepath.length);
      return url;
    },
    output: ({ url }) => {
      url.pathname = joinPaths(["/", trimmedBasepath, url.pathname]);
      return url;
    },
  };
}
/** Execute a location input rewrite if provided. */
/** Execute a location input rewrite if provided. */
function executeRewriteInput(rewrite, url) {
  const res = rewrite?.input?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}
/** Execute a location output rewrite if provided. */
/** Execute a location output rewrite if provided. */
function executeRewriteOutput(rewrite, url) {
  const res = rewrite?.output?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/stores.js
/** SSR non-reactive createMutableStore */
function createNonReactiveMutableStore(initialValue) {
  let value = initialValue;
  return {
    get() {
      return value;
    },
    set(nextOrUpdater) {
      value = functionalUpdate(nextOrUpdater, value);
    },
  };
}
/** SSR non-reactive createReadonlyStore */
function createNonReactiveReadonlyStore(read) {
  return {
    get() {
      return read();
    },
  };
}
function createRouterStores(initialState, config) {
  const { createMutableStore, createReadonlyStore, batch, init } = config;
  const matchStores = /* @__PURE__ */ new Map();
  const pendingMatchStores = /* @__PURE__ */ new Map();
  const cachedMatchStores = /* @__PURE__ */ new Map();
  const status = createMutableStore(initialState.status);
  const loadedAt = createMutableStore(initialState.loadedAt);
  const isLoading = createMutableStore(initialState.isLoading);
  const isTransitioning = createMutableStore(initialState.isTransitioning);
  const location = createMutableStore(initialState.location);
  const resolvedLocation = createMutableStore(initialState.resolvedLocation);
  const statusCode = createMutableStore(initialState.statusCode);
  const redirect = createMutableStore(initialState.redirect);
  const matchesId = createMutableStore([]);
  const pendingIds = createMutableStore([]);
  const cachedIds = createMutableStore([]);
  const matches = createReadonlyStore(() => readPoolMatches(matchStores, matchesId.get()));
  const pendingMatches = createReadonlyStore(() =>
    readPoolMatches(pendingMatchStores, pendingIds.get()),
  );
  const cachedMatches = createReadonlyStore(() =>
    readPoolMatches(cachedMatchStores, cachedIds.get()),
  );
  const firstId = createReadonlyStore(() => matchesId.get()[0]);
  const hasPending = createReadonlyStore(() =>
    matchesId.get().some((matchId) => {
      return matchStores.get(matchId)?.get().status === "pending";
    }),
  );
  const matchRouteDeps = createReadonlyStore(() => ({
    locationHref: location.get().href,
    resolvedLocationHref: resolvedLocation.get()?.href,
    status: status.get(),
  }));
  const __store = createReadonlyStore(() => ({
    status: status.get(),
    loadedAt: loadedAt.get(),
    isLoading: isLoading.get(),
    isTransitioning: isTransitioning.get(),
    matches: matches.get(),
    location: location.get(),
    resolvedLocation: resolvedLocation.get(),
    statusCode: statusCode.get(),
    redirect: redirect.get(),
  }));
  const matchStoreByRouteIdCache = createLRUCache(64);
  function getRouteMatchStore(routeId) {
    let cached = matchStoreByRouteIdCache.get(routeId);
    if (!cached) {
      cached = createReadonlyStore(() => {
        const ids = matchesId.get();
        for (const id of ids) {
          const matchStore = matchStores.get(id);
          if (matchStore && matchStore.routeId === routeId) return matchStore.get();
        }
      });
      matchStoreByRouteIdCache.set(routeId, cached);
    }
    return cached;
  }
  const store = {
    status,
    loadedAt,
    isLoading,
    isTransitioning,
    location,
    resolvedLocation,
    statusCode,
    redirect,
    matchesId,
    pendingIds,
    cachedIds,
    matches,
    pendingMatches,
    cachedMatches,
    firstId,
    hasPending,
    matchRouteDeps,
    matchStores,
    pendingMatchStores,
    cachedMatchStores,
    __store,
    getRouteMatchStore,
    setMatches,
    setPending,
    setCached,
  };
  setMatches(initialState.matches);
  init?.(store);
  function setMatches(nextMatches) {
    reconcileMatchPool(nextMatches, matchStores, matchesId, createMutableStore, batch);
  }
  function setPending(nextMatches) {
    reconcileMatchPool(nextMatches, pendingMatchStores, pendingIds, createMutableStore, batch);
  }
  function setCached(nextMatches) {
    reconcileMatchPool(nextMatches, cachedMatchStores, cachedIds, createMutableStore, batch);
  }
  return store;
}
function readPoolMatches(pool, ids) {
  const matches = [];
  for (const id of ids) {
    const matchStore = pool.get(id);
    if (matchStore) matches.push(matchStore.get());
  }
  return matches;
}
function reconcileMatchPool(nextMatches, pool, idStore, createMutableStore, batch) {
  const nextIds = nextMatches.map((d) => d.id);
  const nextIdSet = new Set(nextIds);
  batch(() => {
    for (const id of pool.keys()) if (!nextIdSet.has(id)) pool.delete(id);
    for (const nextMatch of nextMatches) {
      const existing = pool.get(nextMatch.id);
      if (!existing) {
        const matchStore = createMutableStore(nextMatch);
        matchStore.routeId = nextMatch.routeId;
        pool.set(nextMatch.id, matchStore);
        continue;
      }
      existing.routeId = nextMatch.routeId;
      if (existing.get() !== nextMatch) existing.set(nextMatch);
    }
    if (!arraysEqual(idStore.get(), nextIds)) idStore.set(nextIds);
  });
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/load-matches.js
var triggerOnReady = (inner) => {
  if (!inner.rendered) {
    inner.rendered = true;
    return inner.onReady?.();
  }
};
var resolvePreload = (inner, matchId) => {
  return !!(inner.preload && !inner.router.stores.matchStores.has(matchId));
};
/**
 * Builds the accumulated context from router options and all matches up to (and optionally including) the given index.
 * Merges __routeContext and __beforeLoadContext from each match.
 */
var buildMatchContext = (inner, index, includeCurrentMatch = true) => {
  const context = { ...(inner.router.options.context ?? {}) };
  const end = includeCurrentMatch ? index : index - 1;
  for (let i = 0; i <= end; i++) {
    const innerMatch = inner.matches[i];
    if (!innerMatch) continue;
    const m = inner.router.getMatch(innerMatch.id);
    if (!m) continue;
    Object.assign(context, m.__routeContext, m.__beforeLoadContext);
  }
  return context;
};
var getNotFoundBoundaryIndex = (inner, err) => {
  if (!inner.matches.length) return;
  const requestedRouteId = err.routeId;
  const matchedRootIndex = inner.matches.findIndex((m) => m.routeId === inner.router.routeTree.id);
  const rootIndex = matchedRootIndex >= 0 ? matchedRootIndex : 0;
  let startIndex = requestedRouteId
    ? inner.matches.findIndex((match) => match.routeId === requestedRouteId)
    : (inner.firstBadMatchIndex ?? inner.matches.length - 1);
  if (startIndex < 0) startIndex = rootIndex;
  for (let i = startIndex; i >= 0; i--) {
    const match = inner.matches[i];
    if (inner.router.looseRoutesById[match.routeId].options.notFoundComponent) return i;
  }
  return requestedRouteId ? startIndex : rootIndex;
};
var handleRedirectAndNotFound = (inner, match, err) => {
  if (!isRedirect(err) && !isNotFound(err)) return;
  if (isRedirect(err) && err.redirectHandled && !err.options.reloadDocument) throw err;
  if (match) {
    match._nonReactive.beforeLoadPromise?.resolve();
    match._nonReactive.loaderPromise?.resolve();
    match._nonReactive.beforeLoadPromise = void 0;
    match._nonReactive.loaderPromise = void 0;
    match._nonReactive.error = err;
    inner.updateMatch(match.id, (prev) => ({
      ...prev,
      status: isRedirect(err)
        ? "redirected"
        : isNotFound(err)
          ? "notFound"
          : prev.status === "pending"
            ? "success"
            : prev.status,
      context: buildMatchContext(inner, match.index),
      isFetching: false,
      error: err,
    }));
    if (isNotFound(err) && !err.routeId) err.routeId = match.routeId;
    match._nonReactive.loadPromise?.resolve();
  }
  if (isRedirect(err)) {
    inner.rendered = true;
    err.options._fromLocation = inner.location;
    err.redirectHandled = true;
    err = inner.router.resolveRedirect(err);
  }
  throw err;
};
var shouldSkipLoader = (inner, matchId) => {
  const match = inner.router.getMatch(matchId);
  if (!match) return true;
  if (match.ssr === false) return true;
  return false;
};
var syncMatchContext = (inner, matchId, index) => {
  const nextContext = buildMatchContext(inner, index);
  inner.updateMatch(matchId, (prev) => {
    return {
      ...prev,
      context: nextContext,
    };
  });
};
var handleSerialError = (inner, index, err, routerCode) => {
  const { id: matchId, routeId } = inner.matches[index];
  const route = inner.router.looseRoutesById[routeId];
  if (err instanceof Promise) throw err;
  err.routerCode = routerCode;
  inner.firstBadMatchIndex ??= index;
  handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), err);
  try {
    route.options.onError?.(err);
  } catch (errorHandlerErr) {
    err = errorHandlerErr;
    handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), err);
  }
  inner.updateMatch(matchId, (prev) => {
    prev._nonReactive.beforeLoadPromise?.resolve();
    prev._nonReactive.beforeLoadPromise = void 0;
    prev._nonReactive.loadPromise?.resolve();
    return {
      ...prev,
      error: err,
      status: "error",
      isFetching: false,
      updatedAt: Date.now(),
      abortController: new AbortController(),
    };
  });
  if (!inner.preload && !isRedirect(err) && !isNotFound(err)) inner.serialError ??= err;
};
var isBeforeLoadSsr = (inner, matchId, index, route) => {
  const existingMatch = inner.router.getMatch(matchId);
  const parentMatchId = inner.matches[index - 1]?.id;
  const parentMatch = parentMatchId ? inner.router.getMatch(parentMatchId) : void 0;
  if (inner.router.isShell()) {
    existingMatch.ssr = route.id === rootRouteId;
    return;
  }
  if (parentMatch?.ssr === false) {
    existingMatch.ssr = false;
    return;
  }
  const parentOverride = (tempSsr) => {
    if (tempSsr === true && parentMatch?.ssr === "data-only") return "data-only";
    return tempSsr;
  };
  const defaultSsr = inner.router.options.defaultSsr ?? true;
  if (route.options.ssr === void 0) {
    existingMatch.ssr = parentOverride(defaultSsr);
    return;
  }
  if (typeof route.options.ssr !== "function") {
    existingMatch.ssr = parentOverride(route.options.ssr);
    return;
  }
  const { search, params } = existingMatch;
  const ssrFnContext = {
    search: makeMaybe(search, existingMatch.searchError),
    params: makeMaybe(params, existingMatch.paramsError),
    location: inner.location,
    matches: inner.matches.map((match) => ({
      index: match.index,
      pathname: match.pathname,
      fullPath: match.fullPath,
      staticData: match.staticData,
      id: match.id,
      routeId: match.routeId,
      search: makeMaybe(match.search, match.searchError),
      params: makeMaybe(match.params, match.paramsError),
      ssr: match.ssr,
    })),
  };
  const tempSsr = route.options.ssr(ssrFnContext);
  if (isPromise(tempSsr))
    return tempSsr.then((ssr) => {
      existingMatch.ssr = parentOverride(ssr ?? defaultSsr);
    });
  existingMatch.ssr = parentOverride(tempSsr ?? defaultSsr);
};
var setupPendingTimeout = (inner, matchId, route, match) => {
  if (match._nonReactive.pendingTimeout !== void 0) return;
  route.options.pendingMs ?? inner.router.options.defaultPendingMs;
  if (!!(inner.onReady && false));
};
var preBeforeLoadSetup = (inner, matchId, route) => {
  const existingMatch = inner.router.getMatch(matchId);
  if (!existingMatch._nonReactive.beforeLoadPromise && !existingMatch._nonReactive.loaderPromise)
    return;
  setupPendingTimeout(inner, matchId, route, existingMatch);
  const then = () => {
    const match = inner.router.getMatch(matchId);
    if (match.preload && (match.status === "redirected" || match.status === "notFound"))
      handleRedirectAndNotFound(inner, match, match.error);
  };
  return existingMatch._nonReactive.beforeLoadPromise
    ? existingMatch._nonReactive.beforeLoadPromise.then(then)
    : then();
};
var executeBeforeLoad = (inner, matchId, index, route) => {
  const match = inner.router.getMatch(matchId);
  let prevLoadPromise = match._nonReactive.loadPromise;
  match._nonReactive.loadPromise = createControlledPromise(() => {
    prevLoadPromise?.resolve();
    prevLoadPromise = void 0;
  });
  const { paramsError, searchError } = match;
  if (paramsError) handleSerialError(inner, index, paramsError, "PARSE_PARAMS");
  if (searchError) handleSerialError(inner, index, searchError, "VALIDATE_SEARCH");
  setupPendingTimeout(inner, matchId, route, match);
  const abortController = new AbortController();
  let isPending = false;
  const pending = () => {
    if (isPending) return;
    isPending = true;
    inner.updateMatch(matchId, (prev) => ({
      ...prev,
      isFetching: "beforeLoad",
      fetchCount: prev.fetchCount + 1,
      abortController,
    }));
  };
  const resolve = () => {
    match._nonReactive.beforeLoadPromise?.resolve();
    match._nonReactive.beforeLoadPromise = void 0;
    inner.updateMatch(matchId, (prev) => ({
      ...prev,
      isFetching: false,
    }));
  };
  if (!route.options.beforeLoad) {
    inner.router.batch(() => {
      pending();
      resolve();
    });
    return;
  }
  match._nonReactive.beforeLoadPromise = createControlledPromise();
  const context = {
    ...buildMatchContext(inner, index, false),
    ...match.__routeContext,
  };
  const { search, params, cause } = match;
  const preload = resolvePreload(inner, matchId);
  const beforeLoadFnContext = {
    search,
    abortController,
    params,
    preload,
    context,
    location: inner.location,
    navigate: (opts) =>
      inner.router.navigate({
        ...opts,
        _fromLocation: inner.location,
      }),
    buildLocation: inner.router.buildLocation,
    cause: preload ? "preload" : cause,
    matches: inner.matches,
    routeId: route.id,
    ...inner.router.options.additionalContext,
  };
  const updateContext = (beforeLoadContext) => {
    if (beforeLoadContext === void 0) {
      inner.router.batch(() => {
        pending();
        resolve();
      });
      return;
    }
    if (isRedirect(beforeLoadContext) || isNotFound(beforeLoadContext)) {
      pending();
      handleSerialError(inner, index, beforeLoadContext, "BEFORE_LOAD");
    }
    inner.router.batch(() => {
      pending();
      inner.updateMatch(matchId, (prev) => ({
        ...prev,
        __beforeLoadContext: beforeLoadContext,
      }));
      resolve();
    });
  };
  let beforeLoadContext;
  try {
    beforeLoadContext = route.options.beforeLoad(beforeLoadFnContext);
    if (isPromise(beforeLoadContext)) {
      pending();
      return beforeLoadContext
        .catch((err) => {
          handleSerialError(inner, index, err, "BEFORE_LOAD");
        })
        .then(updateContext);
    }
  } catch (err) {
    pending();
    handleSerialError(inner, index, err, "BEFORE_LOAD");
  }
  updateContext(beforeLoadContext);
};
var handleBeforeLoad = (inner, index) => {
  const { id: matchId, routeId } = inner.matches[index];
  const route = inner.router.looseRoutesById[routeId];
  const serverSsr = () => {
    {
      const maybePromise = isBeforeLoadSsr(inner, matchId, index, route);
      if (isPromise(maybePromise)) return maybePromise.then(queueExecution);
    }
    return queueExecution();
  };
  const execute = () => executeBeforeLoad(inner, matchId, index, route);
  const queueExecution = () => {
    if (shouldSkipLoader(inner, matchId)) return;
    const result = preBeforeLoadSetup(inner, matchId, route);
    return isPromise(result) ? result.then(execute) : execute();
  };
  return serverSsr();
};
var executeHead = (inner, matchId, route) => {
  const match = inner.router.getMatch(matchId);
  if (!match) return;
  if (!route.options.head && !route.options.scripts && !route.options.headers) return;
  const assetContext = {
    ssr: inner.router.options.ssr,
    matches: inner.matches,
    match,
    params: match.params,
    loaderData: match.loaderData,
  };
  return Promise.all([
    route.options.head?.(assetContext),
    route.options.scripts?.(assetContext),
    route.options.headers?.(assetContext),
  ]).then(([headFnContent, scripts, headers]) => {
    return {
      meta: headFnContent?.meta,
      links: headFnContent?.links,
      headScripts: headFnContent?.scripts,
      headers,
      scripts,
      styles: headFnContent?.styles,
    };
  });
};
var getLoaderContext = (inner, matchPromises, matchId, index, route) => {
  const parentMatchPromise = matchPromises[index - 1];
  const { params, loaderDeps, abortController, cause } = inner.router.getMatch(matchId);
  const context = buildMatchContext(inner, index);
  const preload = resolvePreload(inner, matchId);
  return {
    params,
    deps: loaderDeps,
    preload: !!preload,
    parentMatchPromise,
    abortController,
    context,
    location: inner.location,
    navigate: (opts) =>
      inner.router.navigate({
        ...opts,
        _fromLocation: inner.location,
      }),
    cause: preload ? "preload" : cause,
    route,
    ...inner.router.options.additionalContext,
  };
};
var runLoader = async (inner, matchPromises, matchId, index, route) => {
  try {
    const match = inner.router.getMatch(matchId);
    try {
      if (match.ssr === true) loadRouteChunk(route);
      const routeLoader = route.options.loader;
      const loader = typeof routeLoader === "function" ? routeLoader : routeLoader?.handler;
      const loaderResult = loader?.(getLoaderContext(inner, matchPromises, matchId, index, route));
      const loaderResultIsPromise = !!loader && isPromise(loaderResult);
      if (
        !!(
          loaderResultIsPromise ||
          route._lazyPromise ||
          route._componentsPromise ||
          route.options.head ||
          route.options.scripts ||
          route.options.headers ||
          match._nonReactive.minPendingPromise
        )
      )
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          isFetching: "loader",
        }));
      if (loader) {
        const loaderData = loaderResultIsPromise ? await loaderResult : loaderResult;
        handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), loaderData);
        if (loaderData !== void 0)
          inner.updateMatch(matchId, (prev) => ({
            ...prev,
            loaderData,
          }));
      }
      if (route._lazyPromise) await route._lazyPromise;
      const pendingPromise = match._nonReactive.minPendingPromise;
      if (pendingPromise) await pendingPromise;
      if (route._componentsPromise) await route._componentsPromise;
      inner.updateMatch(matchId, (prev) => ({
        ...prev,
        error: void 0,
        context: buildMatchContext(inner, index),
        status: "success",
        isFetching: false,
        updatedAt: Date.now(),
      }));
    } catch (e) {
      let error = e;
      if (error?.name === "AbortError") {
        if (match.abortController.signal.aborted) {
          match._nonReactive.loaderPromise?.resolve();
          match._nonReactive.loaderPromise = void 0;
          return;
        }
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          status: prev.status === "pending" ? "success" : prev.status,
          isFetching: false,
          context: buildMatchContext(inner, index),
        }));
        return;
      }
      const pendingPromise = match._nonReactive.minPendingPromise;
      if (pendingPromise) await pendingPromise;
      if (isNotFound(e)) await route.options.notFoundComponent?.preload?.();
      handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), e);
      try {
        route.options.onError?.(e);
      } catch (onErrorError) {
        error = onErrorError;
        handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), onErrorError);
      }
      if (!isRedirect(error) && !isNotFound(error)) await loadRouteChunk(route, ["errorComponent"]);
      inner.updateMatch(matchId, (prev) => ({
        ...prev,
        error,
        context: buildMatchContext(inner, index),
        status: "error",
        isFetching: false,
      }));
    }
  } catch (err) {
    const match = inner.router.getMatch(matchId);
    if (match) match._nonReactive.loaderPromise = void 0;
    handleRedirectAndNotFound(inner, match, err);
  }
};
var loadRouteMatch = async (inner, matchPromises, index) => {
  async function handleLoader(preload, prevMatch, previousRouteMatchId, match, route) {
    const age = Date.now() - prevMatch.updatedAt;
    const staleAge = preload
      ? (route.options.preloadStaleTime ?? inner.router.options.defaultPreloadStaleTime ?? 3e4)
      : (route.options.staleTime ?? inner.router.options.defaultStaleTime ?? 0);
    const shouldReloadOption = route.options.shouldReload;
    const shouldReload =
      typeof shouldReloadOption === "function"
        ? shouldReloadOption(getLoaderContext(inner, matchPromises, matchId, index, route))
        : shouldReloadOption;
    const { status, invalid } = match;
    const staleMatchShouldReload =
      age >= staleAge &&
      (!!inner.forceStaleReload ||
        match.cause === "enter" ||
        (previousRouteMatchId !== void 0 && previousRouteMatchId !== match.id));
    loaderShouldRunAsync =
      status === "success" && (invalid || (shouldReload ?? staleMatchShouldReload));
    if (preload && route.options.preload === false) {
    } else if (loaderShouldRunAsync && !inner.sync && shouldReloadInBackground) {
      loaderIsRunningAsync = true;
      (async () => {
        try {
          await runLoader(inner, matchPromises, matchId, index, route);
          const match = inner.router.getMatch(matchId);
          match._nonReactive.loaderPromise?.resolve();
          match._nonReactive.loadPromise?.resolve();
          match._nonReactive.loaderPromise = void 0;
          match._nonReactive.loadPromise = void 0;
        } catch (err) {
          if (isRedirect(err)) await inner.router.navigate(err.options);
        }
      })();
    } else if (status !== "success" || loaderShouldRunAsync)
      await runLoader(inner, matchPromises, matchId, index, route);
    else syncMatchContext(inner, matchId, index);
  }
  const { id: matchId, routeId } = inner.matches[index];
  let loaderShouldRunAsync = false;
  let loaderIsRunningAsync = false;
  const route = inner.router.looseRoutesById[routeId];
  const routeLoader = route.options.loader;
  const shouldReloadInBackground =
    ((typeof routeLoader === "function" ? void 0 : routeLoader?.staleReloadMode) ??
      inner.router.options.defaultStaleReloadMode) !== "blocking";
  if (shouldSkipLoader(inner, matchId)) {
    if (!inner.router.getMatch(matchId)) return inner.matches[index];
    syncMatchContext(inner, matchId, index);
    return inner.router.getMatch(matchId);
  } else {
    const prevMatch = inner.router.getMatch(matchId);
    const activeIdAtIndex = inner.router.stores.matchesId.get()[index];
    const previousRouteMatchId =
      ((activeIdAtIndex && inner.router.stores.matchStores.get(activeIdAtIndex)) || null)
        ?.routeId === routeId
        ? activeIdAtIndex
        : inner.router.stores.matches.get().find((d) => d.routeId === routeId)?.id;
    const preload = resolvePreload(inner, matchId);
    if (prevMatch._nonReactive.loaderPromise) {
      if (
        prevMatch.status === "success" &&
        !inner.sync &&
        !prevMatch.preload &&
        shouldReloadInBackground
      )
        return prevMatch;
      await prevMatch._nonReactive.loaderPromise;
      const match = inner.router.getMatch(matchId);
      const error = match._nonReactive.error || match.error;
      if (error) handleRedirectAndNotFound(inner, match, error);
      if (match.status === "pending")
        await handleLoader(preload, prevMatch, previousRouteMatchId, match, route);
    } else {
      const nextPreload = preload && !inner.router.stores.matchStores.has(matchId);
      const match = inner.router.getMatch(matchId);
      match._nonReactive.loaderPromise = createControlledPromise();
      if (nextPreload !== match.preload)
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          preload: nextPreload,
        }));
      await handleLoader(preload, prevMatch, previousRouteMatchId, match, route);
    }
  }
  const match = inner.router.getMatch(matchId);
  if (!loaderIsRunningAsync) {
    match._nonReactive.loaderPromise?.resolve();
    match._nonReactive.loadPromise?.resolve();
    match._nonReactive.loadPromise = void 0;
  }
  clearTimeout(match._nonReactive.pendingTimeout);
  match._nonReactive.pendingTimeout = void 0;
  if (!loaderIsRunningAsync) match._nonReactive.loaderPromise = void 0;
  match._nonReactive.dehydrated = void 0;
  const nextIsFetching = loaderIsRunningAsync ? match.isFetching : false;
  if (nextIsFetching !== match.isFetching || match.invalid !== false) {
    inner.updateMatch(matchId, (prev) => ({
      ...prev,
      isFetching: nextIsFetching,
      invalid: false,
    }));
    return inner.router.getMatch(matchId);
  } else return match;
};
async function loadMatches(arg) {
  const inner = arg;
  const matchPromises = [];
  let beforeLoadNotFound;
  for (let i = 0; i < inner.matches.length; i++) {
    try {
      const beforeLoad = handleBeforeLoad(inner, i);
      if (isPromise(beforeLoad)) await beforeLoad;
    } catch (err) {
      if (isRedirect(err)) throw err;
      if (isNotFound(err)) beforeLoadNotFound = err;
      else if (!inner.preload) throw err;
      break;
    }
    if (inner.serialError || inner.firstBadMatchIndex != null) break;
  }
  const baseMaxIndexExclusive = inner.firstBadMatchIndex ?? inner.matches.length;
  const boundaryIndex =
    beforeLoadNotFound && !inner.preload
      ? getNotFoundBoundaryIndex(inner, beforeLoadNotFound)
      : void 0;
  const maxIndexExclusive =
    beforeLoadNotFound && inner.preload
      ? 0
      : boundaryIndex !== void 0
        ? Math.min(boundaryIndex + 1, baseMaxIndexExclusive)
        : baseMaxIndexExclusive;
  let firstNotFound;
  let firstUnhandledRejection;
  for (let i = 0; i < maxIndexExclusive; i++)
    matchPromises.push(loadRouteMatch(inner, matchPromises, i));
  try {
    await Promise.all(matchPromises);
  } catch {
    const settled = await Promise.allSettled(matchPromises);
    for (const result of settled) {
      if (result.status !== "rejected") continue;
      const reason = result.reason;
      if (isRedirect(reason)) throw reason;
      if (isNotFound(reason)) firstNotFound ??= reason;
      else firstUnhandledRejection ??= reason;
    }
    if (firstUnhandledRejection !== void 0) throw firstUnhandledRejection;
  }
  const notFoundToThrow =
    firstNotFound ?? (beforeLoadNotFound && !inner.preload ? beforeLoadNotFound : void 0);
  let headMaxIndex =
    inner.firstBadMatchIndex !== void 0 ? inner.firstBadMatchIndex : inner.matches.length - 1;
  if (!notFoundToThrow && beforeLoadNotFound && inner.preload) return inner.matches;
  if (notFoundToThrow) {
    const renderedBoundaryIndex = getNotFoundBoundaryIndex(inner, notFoundToThrow);
    if (renderedBoundaryIndex === void 0) invariant();
    const boundaryMatch = inner.matches[renderedBoundaryIndex];
    const boundaryRoute = inner.router.looseRoutesById[boundaryMatch.routeId];
    const defaultNotFoundComponent = inner.router.options?.defaultNotFoundComponent;
    if (!boundaryRoute.options.notFoundComponent && defaultNotFoundComponent)
      boundaryRoute.options.notFoundComponent = defaultNotFoundComponent;
    notFoundToThrow.routeId = boundaryMatch.routeId;
    const boundaryIsRoot = boundaryMatch.routeId === inner.router.routeTree.id;
    inner.updateMatch(boundaryMatch.id, (prev) => ({
      ...prev,
      ...(boundaryIsRoot
        ? {
            status: "success",
            globalNotFound: true,
            error: void 0,
          }
        : {
            status: "notFound",
            error: notFoundToThrow,
          }),
      isFetching: false,
    }));
    headMaxIndex = renderedBoundaryIndex;
    await loadRouteChunk(boundaryRoute, ["notFoundComponent"]);
  } else if (!inner.preload) {
    const rootMatch = inner.matches[0];
    if (!rootMatch.globalNotFound) {
      if (inner.router.getMatch(rootMatch.id)?.globalNotFound)
        inner.updateMatch(rootMatch.id, (prev) => ({
          ...prev,
          globalNotFound: false,
          error: void 0,
        }));
    }
  }
  if (inner.serialError && inner.firstBadMatchIndex !== void 0) {
    const errorRoute =
      inner.router.looseRoutesById[inner.matches[inner.firstBadMatchIndex].routeId];
    await loadRouteChunk(errorRoute, ["errorComponent"]);
  }
  for (let i = 0; i <= headMaxIndex; i++) {
    const { id: matchId, routeId } = inner.matches[i];
    const route = inner.router.looseRoutesById[routeId];
    try {
      const headResult = executeHead(inner, matchId, route);
      if (headResult) {
        const head = await headResult;
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          ...head,
        }));
      }
    } catch (err) {
      console.error(`Error executing head for route ${routeId}:`, err);
    }
  }
  const readyPromise = triggerOnReady(inner);
  if (isPromise(readyPromise)) await readyPromise;
  if (notFoundToThrow) throw notFoundToThrow;
  if (inner.serialError && !inner.preload && !inner.onReady) throw inner.serialError;
  return inner.matches;
}
function preloadRouteComponents(route, componentTypesToLoad) {
  const preloads = componentTypesToLoad
    .map((type) => route.options[type]?.preload?.())
    .filter(Boolean);
  if (preloads.length === 0) return void 0;
  return Promise.all(preloads);
}
function loadRouteChunk(route, componentTypesToLoad = componentTypes) {
  if (!route._lazyLoaded && route._lazyPromise === void 0)
    if (route.lazyFn)
      route._lazyPromise = route.lazyFn().then((lazyRoute) => {
        const { id: _id, ...options } = lazyRoute.options;
        Object.assign(route.options, options);
        route._lazyLoaded = true;
        route._lazyPromise = void 0;
      });
    else route._lazyLoaded = true;
  const runAfterLazy = () =>
    route._componentsLoaded
      ? void 0
      : componentTypesToLoad === componentTypes
        ? (() => {
            if (route._componentsPromise === void 0) {
              const componentsPromise = preloadRouteComponents(route, componentTypes);
              if (componentsPromise)
                route._componentsPromise = componentsPromise.then(() => {
                  route._componentsLoaded = true;
                  route._componentsPromise = void 0;
                });
              else route._componentsLoaded = true;
            }
            return route._componentsPromise;
          })()
        : preloadRouteComponents(route, componentTypesToLoad);
  return route._lazyPromise ? route._lazyPromise.then(runAfterLazy) : runAfterLazy();
}
function makeMaybe(value, error) {
  if (error)
    return {
      status: "error",
      error,
    };
  return {
    status: "success",
    value,
  };
}
function routeNeedsPreload(route) {
  for (const componentType of componentTypes)
    if (route.options[componentType]?.preload) return true;
  return false;
}
var componentTypes = ["component", "errorComponent", "pendingComponent", "notFoundComponent"];
//#endregion
//#region node_modules/@tanstack/history/dist/esm/index.js
var stateIndexKey = "__TSR_index";
function createHistory(opts) {
  let location = opts.getLocation();
  const subscribers = /* @__PURE__ */ new Set();
  const notify = (action) => {
    location = opts.getLocation();
    subscribers.forEach((subscriber) =>
      subscriber({
        location,
        action,
      }),
    );
  };
  const handleIndexChange = (action) => {
    if (opts.notifyOnIndexChange ?? true) notify(action);
    else location = opts.getLocation();
  };
  const tryNavigation = async ({ task, navigateOpts, ...actionInfo }) => {
    if (navigateOpts?.ignoreBlocker ?? false) {
      task();
      return;
    }
    const blockers = opts.getBlockers?.() ?? [];
    const isPushOrReplace = actionInfo.type === "PUSH" || actionInfo.type === "REPLACE";
    if (typeof document !== "undefined" && blockers.length && isPushOrReplace)
      for (const blocker of blockers) {
        const nextLocation = parseHref(actionInfo.path, actionInfo.state);
        if (
          await blocker.blockerFn({
            currentLocation: location,
            nextLocation,
            action: actionInfo.type,
          })
        ) {
          opts.onBlocked?.();
          return;
        }
      }
    task();
  };
  return {
    get location() {
      return location;
    },
    get length() {
      return opts.getLength();
    },
    subscribers,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    push: (path, state, navigateOpts) => {
      const currentIndex = location.state[stateIndexKey];
      state = assignKeyAndIndex(currentIndex + 1, state);
      tryNavigation({
        task: () => {
          opts.pushState(path, state);
          notify({ type: "PUSH" });
        },
        navigateOpts,
        type: "PUSH",
        path,
        state,
      });
    },
    replace: (path, state, navigateOpts) => {
      const currentIndex = location.state[stateIndexKey];
      state = assignKeyAndIndex(currentIndex, state);
      tryNavigation({
        task: () => {
          opts.replaceState(path, state);
          notify({ type: "REPLACE" });
        },
        navigateOpts,
        type: "REPLACE",
        path,
        state,
      });
    },
    go: (index, navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.go(index);
          handleIndexChange({
            type: "GO",
            index,
          });
        },
        navigateOpts,
        type: "GO",
      });
    },
    back: (navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.back(navigateOpts?.ignoreBlocker ?? false);
          handleIndexChange({ type: "BACK" });
        },
        navigateOpts,
        type: "BACK",
      });
    },
    forward: (navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.forward(navigateOpts?.ignoreBlocker ?? false);
          handleIndexChange({ type: "FORWARD" });
        },
        navigateOpts,
        type: "FORWARD",
      });
    },
    canGoBack: () => location.state[stateIndexKey] !== 0,
    createHref: (str) => opts.createHref(str),
    block: (blocker) => {
      if (!opts.setBlockers) return () => {};
      const blockers = opts.getBlockers?.() ?? [];
      opts.setBlockers([...blockers, blocker]);
      return () => {
        const blockers = opts.getBlockers?.() ?? [];
        opts.setBlockers?.(blockers.filter((b) => b !== blocker));
      };
    },
    flush: () => opts.flush?.(),
    destroy: () => opts.destroy?.(),
    notify,
  };
}
function assignKeyAndIndex(index, state) {
  if (!state) state = {};
  const key = createRandomKey();
  return {
    ...state,
    key,
    __TSR_key: key,
    [stateIndexKey]: index,
  };
}
/**
 * Create an in-memory history implementation.
 * Ideal for server rendering, tests, and non-DOM environments.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/history-types
 */
function createMemoryHistory(opts = { initialEntries: ["/"] }) {
  const entries = opts.initialEntries;
  let index = opts.initialIndex
    ? Math.min(Math.max(opts.initialIndex, 0), entries.length - 1)
    : entries.length - 1;
  const states = entries.map((_entry, index) => assignKeyAndIndex(index, void 0));
  const getLocation = () => parseHref(entries[index], states[index]);
  let blockers = [];
  const _getBlockers = () => blockers;
  const _setBlockers = (newBlockers) => (blockers = newBlockers);
  return createHistory({
    getLocation,
    getLength: () => entries.length,
    pushState: (path, state) => {
      if (index < entries.length - 1) {
        entries.splice(index + 1);
        states.splice(index + 1);
      }
      states.push(state);
      entries.push(path);
      index = Math.max(entries.length - 1, 0);
    },
    replaceState: (path, state) => {
      states[index] = state;
      entries[index] = path;
    },
    back: () => {
      index = Math.max(index - 1, 0);
    },
    forward: () => {
      index = Math.min(index + 1, entries.length - 1);
    },
    go: (n) => {
      index = Math.min(Math.max(index + n, 0), entries.length - 1);
    },
    createHref: (path) => path,
    getBlockers: _getBlockers,
    setBlockers: _setBlockers,
  });
}
/**
 * Sanitize a path to prevent open redirect vulnerabilities.
 * Removes control characters and collapses leading double slashes.
 */
function sanitizePath(path) {
  let sanitized = path.replace(/[\x00-\x1f\x7f]/g, "");
  if (sanitized.startsWith("//")) sanitized = "/" + sanitized.replace(/^\/+/, "");
  return sanitized;
}
function parseHref(href, state) {
  const sanitizedHref = sanitizePath(href);
  const hashIndex = sanitizedHref.indexOf("#");
  const searchIndex = sanitizedHref.indexOf("?");
  const addedKey = createRandomKey();
  return {
    href: sanitizedHref,
    pathname: sanitizedHref.substring(
      0,
      hashIndex > 0
        ? searchIndex > 0
          ? Math.min(hashIndex, searchIndex)
          : hashIndex
        : searchIndex > 0
          ? searchIndex
          : sanitizedHref.length,
    ),
    hash: hashIndex > -1 ? sanitizedHref.substring(hashIndex) : "",
    search:
      searchIndex > -1
        ? sanitizedHref.slice(searchIndex, hashIndex === -1 ? void 0 : hashIndex)
        : "",
    state: state || {
      [stateIndexKey]: 0,
      key: addedKey,
      __TSR_key: addedKey,
    },
  };
}
function createRandomKey() {
  return (Math.random() + 1).toString(36).substring(7);
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/router.js
/**
 * Compute whether path, href or hash changed between previous and current
 * resolved locations.
 */
function getLocationChangeInfo(location, resolvedLocation) {
  const fromLocation = resolvedLocation;
  const toLocation = location;
  return {
    fromLocation,
    toLocation,
    pathChanged: fromLocation?.pathname !== toLocation.pathname,
    hrefChanged: fromLocation?.href !== toLocation.href,
    hashChanged: fromLocation?.hash !== toLocation.hash,
  };
}
/**
 * Core, framework-agnostic router engine that powers TanStack Router.
 *
 * Provides navigation, matching, loading, preloading, caching and event APIs
 * used by framework adapters (React/Solid). Prefer framework helpers like
 * `createRouter` in app code.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/RouterType
 */
var RouterCore = class {
  /**
   * @deprecated Use the `createRouter` function instead
   */
  constructor(options, getStoreConfig) {
    this.tempLocationKey = `${Math.round(Math.random() * 1e7)}`;
    this.resetNextScroll = true;
    this.shouldViewTransition = void 0;
    this.isViewTransitionTypesSupported = void 0;
    this.subscribers = /* @__PURE__ */ new Set();
    this.isScrollRestoring = false;
    this.isScrollRestorationSetup = false;
    this.startTransition = (fn) => fn();
    this.update = (newOptions) => {
      const prevOptions = this.options;
      const prevBasepath = this.basepath ?? prevOptions?.basepath ?? "/";
      const basepathWasUnset = this.basepath === void 0;
      const prevRewriteOption = prevOptions?.rewrite;
      this.options = {
        ...prevOptions,
        ...newOptions,
      };
      this.isServer = this.options.isServer ?? typeof document === "undefined";
      this.protocolAllowlist = new Set(this.options.protocolAllowlist);
      if (this.options.pathParamsAllowedCharacters)
        this.pathParamsDecoder = compileDecodeCharMap(this.options.pathParamsAllowedCharacters);
      if (!this.history || (this.options.history && this.options.history !== this.history))
        if (!this.options.history) {
        } else this.history = this.options.history;
      this.origin = this.options.origin;
      if (!this.origin) this.origin = "http://localhost";
      if (this.history) this.updateLatestLocation();
      if (this.options.routeTree !== this.routeTree) {
        this.routeTree = this.options.routeTree;
        let processRouteTreeResult;
        if (globalThis.__TSR_CACHE__ && globalThis.__TSR_CACHE__.routeTree === this.routeTree) {
          const cached = globalThis.__TSR_CACHE__;
          this.resolvePathCache = cached.resolvePathCache;
          processRouteTreeResult = cached.processRouteTreeResult;
        } else {
          this.resolvePathCache = createLRUCache(1e3);
          processRouteTreeResult = this.buildRouteTree();
          if (globalThis.__TSR_CACHE__ === void 0)
            globalThis.__TSR_CACHE__ = {
              routeTree: this.routeTree,
              processRouteTreeResult,
              resolvePathCache: this.resolvePathCache,
            };
        }
        this.setRoutes(processRouteTreeResult);
      }
      if (!this.stores && this.latestLocation) {
        const config = this.getStoreConfig(this);
        this.batch = config.batch;
        this.stores = createRouterStores(getInitialRouterState(this.latestLocation), config);
      }
      let needsLocationUpdate = false;
      const nextBasepath = this.options.basepath ?? "/";
      const nextRewriteOption = this.options.rewrite;
      if (
        basepathWasUnset ||
        prevBasepath !== nextBasepath ||
        prevRewriteOption !== nextRewriteOption
      ) {
        this.basepath = nextBasepath;
        const rewrites = [];
        const trimmed = trimPath(nextBasepath);
        if (trimmed && trimmed !== "/") rewrites.push(rewriteBasepath({ basepath: nextBasepath }));
        if (nextRewriteOption) rewrites.push(nextRewriteOption);
        this.rewrite =
          rewrites.length === 0
            ? void 0
            : rewrites.length === 1
              ? rewrites[0]
              : composeRewrites(rewrites);
        if (this.history) this.updateLatestLocation();
        needsLocationUpdate = true;
      }
      if (needsLocationUpdate && this.stores) this.stores.location.set(this.latestLocation);
      if (
        typeof window !== "undefined" &&
        "CSS" in window &&
        typeof window.CSS?.supports === "function"
      )
        this.isViewTransitionTypesSupported = window.CSS.supports(
          "selector(:active-view-transition-type(a)",
        );
    };
    this.updateLatestLocation = () => {
      this.latestLocation = this.parseLocation(this.history.location, this.latestLocation);
    };
    this.buildRouteTree = () => {
      const result = processRouteTree(this.routeTree, this.options.caseSensitive, (route, i) => {
        route.init({ originalIndex: i });
      });
      if (this.options.routeMasks) processRouteMasks(this.options.routeMasks, result.processedTree);
      return result;
    };
    this.subscribe = (eventType, fn) => {
      const listener = {
        eventType,
        fn,
      };
      this.subscribers.add(listener);
      return () => {
        this.subscribers.delete(listener);
      };
    };
    this.emit = (routerEvent) => {
      this.subscribers.forEach((listener) => {
        if (listener.eventType === routerEvent.type) listener.fn(routerEvent);
      });
    };
    this.parseLocation = (locationToParse, previousLocation) => {
      const parse = ({ pathname, search, hash, href, state }) => {
        if (!this.rewrite && !/[ \x00-\x1f\x7f\u0080-\uffff]/.test(pathname)) {
          const parsedSearch = this.options.parseSearch(search);
          const searchStr = this.options.stringifySearch(parsedSearch);
          return {
            href: pathname + searchStr + hash,
            publicHref: pathname + searchStr + hash,
            pathname: decodePath(pathname).path,
            external: false,
            searchStr,
            search: nullReplaceEqualDeep(previousLocation?.search, parsedSearch),
            hash: decodePath(hash.slice(1)).path,
            state: replaceEqualDeep(previousLocation?.state, state),
          };
        }
        const fullUrl = new URL(href, this.origin);
        const url = executeRewriteInput(this.rewrite, fullUrl);
        const parsedSearch = this.options.parseSearch(url.search);
        const searchStr = this.options.stringifySearch(parsedSearch);
        url.search = searchStr;
        return {
          href: url.href.replace(url.origin, ""),
          publicHref: href,
          pathname: decodePath(url.pathname).path,
          external: !!this.rewrite && url.origin !== this.origin,
          searchStr,
          search: nullReplaceEqualDeep(previousLocation?.search, parsedSearch),
          hash: decodePath(url.hash.slice(1)).path,
          state: replaceEqualDeep(previousLocation?.state, state),
        };
      };
      const location = parse(locationToParse);
      const { __tempLocation, __tempKey } = location.state;
      if (__tempLocation && (!__tempKey || __tempKey === this.tempLocationKey)) {
        const parsedTempLocation = parse(__tempLocation);
        parsedTempLocation.state.key = location.state.key;
        parsedTempLocation.state.__TSR_key = location.state.__TSR_key;
        delete parsedTempLocation.state.__tempLocation;
        return {
          ...parsedTempLocation,
          maskedLocation: location,
        };
      }
      return location;
    };
    this.resolvePathWithBase = (from, path) => {
      return resolvePath({
        base: from,
        to: cleanPath(path),
        trailingSlash: this.options.trailingSlash,
        cache: this.resolvePathCache,
      });
    };
    this.matchRoutes = (pathnameOrNext, locationSearchOrOpts, opts) => {
      if (typeof pathnameOrNext === "string")
        return this.matchRoutesInternal(
          {
            pathname: pathnameOrNext,
            search: locationSearchOrOpts,
          },
          opts,
        );
      return this.matchRoutesInternal(pathnameOrNext, locationSearchOrOpts);
    };
    this.getMatchedRoutes = (pathname) => {
      return getMatchedRoutes({
        pathname,
        routesById: this.routesById,
        processedTree: this.processedTree,
      });
    };
    this.cancelMatch = (id) => {
      const match = this.getMatch(id);
      if (!match) return;
      match.abortController.abort();
      clearTimeout(match._nonReactive.pendingTimeout);
      match._nonReactive.pendingTimeout = void 0;
    };
    this.cancelMatches = () => {
      this.stores.pendingIds.get().forEach((matchId) => {
        this.cancelMatch(matchId);
      });
      this.stores.matchesId.get().forEach((matchId) => {
        if (this.stores.pendingMatchStores.has(matchId)) return;
        const match = this.stores.matchStores.get(matchId)?.get();
        if (!match) return;
        if (match.status === "pending" || match.isFetching === "loader") this.cancelMatch(matchId);
      });
    };
    this.buildLocation = (opts) => {
      const build = (dest = {}) => {
        const currentLocation =
          dest._fromLocation || this.pendingBuiltLocation || this.latestLocation;
        const lightweightResult = this.matchRoutesLightweight(currentLocation);
        if (dest.from && false);
        const defaultedFromPath =
          dest.unsafeRelative === "path"
            ? currentLocation.pathname
            : (dest.from ?? lightweightResult.fullPath);
        const fromPath = this.resolvePathWithBase(defaultedFromPath, ".");
        const fromSearch = lightweightResult.search;
        const fromParams = Object.assign(Object.create(null), lightweightResult.params);
        const nextTo = dest.to
          ? this.resolvePathWithBase(fromPath, `${dest.to}`)
          : this.resolvePathWithBase(fromPath, ".");
        const nextParams =
          dest.params === false || dest.params === null
            ? Object.create(null)
            : (dest.params ?? true) === true
              ? fromParams
              : Object.assign(fromParams, functionalUpdate(dest.params, fromParams));
        const destMatchResult = this.getMatchedRoutes(nextTo);
        let destRoutes = destMatchResult.matchedRoutes;
        if (
          (!destMatchResult.foundRoute ||
            (destMatchResult.foundRoute.path !== "/" && destMatchResult.routeParams["**"])) &&
          this.options.notFoundRoute
        )
          destRoutes = [...destRoutes, this.options.notFoundRoute];
        if (Object.keys(nextParams).length > 0)
          for (const route of destRoutes) {
            const fn = route.options.params?.stringify ?? route.options.stringifyParams;
            if (fn)
              try {
                Object.assign(nextParams, fn(nextParams));
              } catch {}
          }
        const nextPathname = opts.leaveParams
          ? nextTo
          : decodePath(
              interpolatePath({
                path: nextTo,
                params: nextParams,
                decoder: this.pathParamsDecoder,
                server: this.isServer,
              }).interpolatedPath,
            ).path;
        let nextSearch = fromSearch;
        if (opts._includeValidateSearch && this.options.search?.strict) {
          const validatedSearch = {};
          destRoutes.forEach((route) => {
            if (route.options.validateSearch)
              try {
                Object.assign(
                  validatedSearch,
                  validateSearch(route.options.validateSearch, {
                    ...validatedSearch,
                    ...nextSearch,
                  }),
                );
              } catch {}
          });
          nextSearch = validatedSearch;
        }
        nextSearch = applySearchMiddleware({
          search: nextSearch,
          dest,
          destRoutes,
          _includeValidateSearch: opts._includeValidateSearch,
        });
        nextSearch = nullReplaceEqualDeep(fromSearch, nextSearch);
        const searchStr = this.options.stringifySearch(nextSearch);
        const hash =
          dest.hash === true
            ? currentLocation.hash
            : dest.hash
              ? functionalUpdate(dest.hash, currentLocation.hash)
              : void 0;
        const hashStr = hash ? `#${hash}` : "";
        let nextState =
          dest.state === true
            ? currentLocation.state
            : dest.state
              ? functionalUpdate(dest.state, currentLocation.state)
              : {};
        nextState = replaceEqualDeep(currentLocation.state, nextState);
        const fullPath = `${nextPathname}${searchStr}${hashStr}`;
        let href;
        let publicHref;
        let external = false;
        if (this.rewrite) {
          const url = new URL(fullPath, this.origin);
          const rewrittenUrl = executeRewriteOutput(this.rewrite, url);
          href = url.href.replace(url.origin, "");
          if (rewrittenUrl.origin !== this.origin) {
            publicHref = rewrittenUrl.href;
            external = true;
          } else publicHref = rewrittenUrl.pathname + rewrittenUrl.search + rewrittenUrl.hash;
        } else {
          href = encodePathLikeUrl(fullPath);
          publicHref = href;
        }
        return {
          publicHref,
          href,
          pathname: nextPathname,
          search: nextSearch,
          searchStr,
          state: nextState,
          hash: hash ?? "",
          external,
          unmaskOnReload: dest.unmaskOnReload,
        };
      };
      const buildWithMatches = (dest = {}, maskedDest) => {
        const next = build(dest);
        let maskedNext = maskedDest ? build(maskedDest) : void 0;
        if (!maskedNext) {
          const params = Object.create(null);
          if (this.options.routeMasks) {
            const match = findFlatMatch(next.pathname, this.processedTree);
            if (match) {
              Object.assign(params, match.rawParams);
              const { from: _from, params: maskParams, ...maskProps } = match.route;
              const nextParams =
                maskParams === false || maskParams === null
                  ? Object.create(null)
                  : (maskParams ?? true) === true
                    ? params
                    : Object.assign(params, functionalUpdate(maskParams, params));
              maskedDest = {
                from: opts.from,
                ...maskProps,
                params: nextParams,
              };
              maskedNext = build(maskedDest);
            }
          }
        }
        if (maskedNext) next.maskedLocation = maskedNext;
        return next;
      };
      if (opts.mask)
        return buildWithMatches(opts, {
          from: opts.from,
          ...opts.mask,
        });
      return buildWithMatches(opts);
    };
    this.commitLocation = async ({ viewTransition, ignoreBlocker, ...next }) => {
      const isSameState = () => {
        const ignoredProps = ["key", "__TSR_key", "__TSR_index", "__hashScrollIntoViewOptions"];
        ignoredProps.forEach((prop) => {
          next.state[prop] = this.latestLocation.state[prop];
        });
        const isEqual = deepEqual(next.state, this.latestLocation.state);
        ignoredProps.forEach((prop) => {
          delete next.state[prop];
        });
        return isEqual;
      };
      const isSameUrl = trimPathRight(this.latestLocation.href) === trimPathRight(next.href);
      let previousCommitPromise = this.commitLocationPromise;
      this.commitLocationPromise = createControlledPromise(() => {
        previousCommitPromise?.resolve();
        previousCommitPromise = void 0;
      });
      if (isSameUrl && isSameState()) this.load();
      else {
        let { maskedLocation, hashScrollIntoView, ...nextHistory } = next;
        if (maskedLocation) {
          nextHistory = {
            ...maskedLocation,
            state: {
              ...maskedLocation.state,
              __tempKey: void 0,
              __tempLocation: {
                ...nextHistory,
                search: nextHistory.searchStr,
                state: {
                  ...nextHistory.state,
                  __tempKey: void 0,
                  __tempLocation: void 0,
                  __TSR_key: void 0,
                  key: void 0,
                },
              },
            },
          };
          if (nextHistory.unmaskOnReload ?? this.options.unmaskOnReload ?? false)
            nextHistory.state.__tempKey = this.tempLocationKey;
        }
        nextHistory.state.__hashScrollIntoViewOptions =
          hashScrollIntoView ?? this.options.defaultHashScrollIntoView ?? true;
        this.shouldViewTransition = viewTransition;
        this.history[next.replace ? "replace" : "push"](nextHistory.publicHref, nextHistory.state, {
          ignoreBlocker,
        });
      }
      this.resetNextScroll = next.resetScroll ?? true;
      if (!this.history.subscribers.size) this.load();
      return this.commitLocationPromise;
    };
    this.buildAndCommitLocation = ({
      replace,
      resetScroll,
      hashScrollIntoView,
      viewTransition,
      ignoreBlocker,
      href,
      ...rest
    } = {}) => {
      if (href) {
        const currentIndex = this.history.location.state.__TSR_index;
        const parsed = parseHref(href, { __TSR_index: replace ? currentIndex : currentIndex + 1 });
        const hrefUrl = new URL(parsed.pathname, this.origin);
        rest.to = executeRewriteInput(this.rewrite, hrefUrl).pathname;
        rest.search = this.options.parseSearch(parsed.search);
        rest.hash = parsed.hash.slice(1);
      }
      const location = this.buildLocation({
        ...rest,
        _includeValidateSearch: true,
      });
      this.pendingBuiltLocation = location;
      const commitPromise = this.commitLocation({
        ...location,
        viewTransition,
        replace,
        resetScroll,
        hashScrollIntoView,
        ignoreBlocker,
      });
      Promise.resolve().then(() => {
        if (this.pendingBuiltLocation === location) this.pendingBuiltLocation = void 0;
      });
      return commitPromise;
    };
    this.navigate = async ({ to, reloadDocument, href, publicHref, ...rest }) => {
      let hrefIsUrl = false;
      if (href)
        try {
          new URL(`${href}`);
          hrefIsUrl = true;
        } catch {}
      if (hrefIsUrl && !reloadDocument) reloadDocument = true;
      if (reloadDocument) {
        if (to !== void 0 || !href) {
          const location = this.buildLocation({
            to,
            ...rest,
          });
          href = href ?? location.publicHref;
          publicHref = publicHref ?? location.publicHref;
        }
        const reloadHref = !hrefIsUrl && publicHref ? publicHref : href;
        if (isDangerousProtocol(reloadHref, this.protocolAllowlist)) return Promise.resolve();
        if (!rest.ignoreBlocker) {
          const blockers = this.history.getBlockers?.() ?? [];
          for (const blocker of blockers)
            if (blocker?.blockerFn) {
              if (
                await blocker.blockerFn({
                  currentLocation: this.latestLocation,
                  nextLocation: this.latestLocation,
                  action: "PUSH",
                })
              )
                return Promise.resolve();
            }
        }
        if (rest.replace) window.location.replace(reloadHref);
        else window.location.href = reloadHref;
        return Promise.resolve();
      }
      return this.buildAndCommitLocation({
        ...rest,
        href,
        to,
        _isNavigate: true,
      });
    };
    this.beforeLoad = () => {
      this.cancelMatches();
      this.updateLatestLocation();
      {
        const nextLocation = this.buildLocation({
          to: this.latestLocation.pathname,
          search: true,
          params: true,
          hash: true,
          state: true,
          _includeValidateSearch: true,
        });
        if (this.latestLocation.publicHref !== nextLocation.publicHref) {
          const href = this.getParsedLocationHref(nextLocation);
          if (nextLocation.external) throw redirect({ href });
          else
            throw redirect({
              href,
              _builtLocation: nextLocation,
            });
        }
      }
      const pendingMatches = this.matchRoutes(this.latestLocation);
      const nextCachedMatches = this.stores.cachedMatches
        .get()
        .filter((d) => !pendingMatches.some((e) => e.id === d.id));
      this.batch(() => {
        this.stores.status.set("pending");
        this.stores.statusCode.set(200);
        this.stores.isLoading.set(true);
        this.stores.location.set(this.latestLocation);
        this.stores.setPending(pendingMatches);
        this.stores.setCached(nextCachedMatches);
      });
    };
    this.load = async (opts) => {
      let redirect;
      let notFound;
      let loadPromise;
      const previousLocation = this.stores.resolvedLocation.get() ?? this.stores.location.get();
      loadPromise = new Promise((resolve) => {
        this.startTransition(async () => {
          try {
            this.beforeLoad();
            const next = this.latestLocation;
            const locationChangeInfo = getLocationChangeInfo(
              next,
              this.stores.resolvedLocation.get(),
            );
            if (!this.stores.redirect.get())
              this.emit({
                type: "onBeforeNavigate",
                ...locationChangeInfo,
              });
            this.emit({
              type: "onBeforeLoad",
              ...locationChangeInfo,
            });
            await loadMatches({
              router: this,
              sync: opts?.sync,
              forceStaleReload: previousLocation.href === next.href,
              matches: this.stores.pendingMatches.get(),
              location: next,
              updateMatch: this.updateMatch,
              onReady: async () => {
                this.startTransition(() => {
                  this.startViewTransition(async () => {
                    let exitingMatches = null;
                    let hookExitingMatches = null;
                    let hookEnteringMatches = null;
                    let hookStayingMatches = null;
                    this.batch(() => {
                      const pendingMatches = this.stores.pendingMatches.get();
                      const mountPending = pendingMatches.length;
                      const currentMatches = this.stores.matches.get();
                      exitingMatches = mountPending
                        ? currentMatches.filter(
                            (match) => !this.stores.pendingMatchStores.has(match.id),
                          )
                        : null;
                      const pendingRouteIds = /* @__PURE__ */ new Set();
                      for (const s of this.stores.pendingMatchStores.values())
                        if (s.routeId) pendingRouteIds.add(s.routeId);
                      const activeRouteIds = /* @__PURE__ */ new Set();
                      for (const s of this.stores.matchStores.values())
                        if (s.routeId) activeRouteIds.add(s.routeId);
                      hookExitingMatches = mountPending
                        ? currentMatches.filter((match) => !pendingRouteIds.has(match.routeId))
                        : null;
                      hookEnteringMatches = mountPending
                        ? pendingMatches.filter((match) => !activeRouteIds.has(match.routeId))
                        : null;
                      hookStayingMatches = mountPending
                        ? pendingMatches.filter((match) => activeRouteIds.has(match.routeId))
                        : currentMatches;
                      this.stores.isLoading.set(false);
                      this.stores.loadedAt.set(Date.now());
                      /**
                       * When committing new matches, cache any exiting matches that are still usable.
                       * Routes that resolved with `status: 'error'` or `status: 'notFound'` are
                       * deliberately excluded from `cachedMatches` so that subsequent invalidations
                       * or reloads re-run their loaders instead of reusing the failed/not-found data.
                       */
                      if (mountPending) {
                        this.stores.setMatches(pendingMatches);
                        this.stores.setPending([]);
                        this.stores.setCached([
                          ...this.stores.cachedMatches.get(),
                          ...exitingMatches.filter(
                            (d) =>
                              d.status !== "error" &&
                              d.status !== "notFound" &&
                              d.status !== "redirected",
                          ),
                        ]);
                        this.clearExpiredCache();
                      }
                    });
                    for (const [matches, hook] of [
                      [hookExitingMatches, "onLeave"],
                      [hookEnteringMatches, "onEnter"],
                      [hookStayingMatches, "onStay"],
                    ]) {
                      if (!matches) continue;
                      for (const match of matches)
                        this.looseRoutesById[match.routeId].options[hook]?.(match);
                    }
                  });
                });
              },
            });
          } catch (err) {
            if (isRedirect(err)) redirect = err;
            else if (isNotFound(err)) notFound = err;
            const nextStatusCode = redirect
              ? redirect.status
              : notFound
                ? 404
                : this.stores.matches.get().some((d) => d.status === "error")
                  ? 500
                  : 200;
            this.batch(() => {
              this.stores.statusCode.set(nextStatusCode);
              this.stores.redirect.set(redirect);
            });
          }
          if (this.latestLoadPromise === loadPromise) {
            this.commitLocationPromise?.resolve();
            this.latestLoadPromise = void 0;
            this.commitLocationPromise = void 0;
          }
          resolve();
        });
      });
      this.latestLoadPromise = loadPromise;
      await loadPromise;
      while (this.latestLoadPromise && loadPromise !== this.latestLoadPromise)
        await this.latestLoadPromise;
      let newStatusCode = void 0;
      if (this.hasNotFoundMatch()) newStatusCode = 404;
      else if (this.stores.matches.get().some((d) => d.status === "error")) newStatusCode = 500;
      if (newStatusCode !== void 0) this.stores.statusCode.set(newStatusCode);
    };
    this.startViewTransition = (fn) => {
      const shouldViewTransition = this.shouldViewTransition ?? this.options.defaultViewTransition;
      this.shouldViewTransition = void 0;
      if (
        shouldViewTransition &&
        typeof document !== "undefined" &&
        "startViewTransition" in document &&
        typeof document.startViewTransition === "function"
      ) {
        let startViewTransitionParams;
        if (typeof shouldViewTransition === "object" && this.isViewTransitionTypesSupported) {
          const next = this.latestLocation;
          const prevLocation = this.stores.resolvedLocation.get();
          const resolvedViewTransitionTypes =
            typeof shouldViewTransition.types === "function"
              ? shouldViewTransition.types(getLocationChangeInfo(next, prevLocation))
              : shouldViewTransition.types;
          if (resolvedViewTransitionTypes === false) {
            fn();
            return;
          }
          startViewTransitionParams = {
            update: fn,
            types: resolvedViewTransitionTypes,
          };
        } else startViewTransitionParams = fn;
        document.startViewTransition(startViewTransitionParams);
      } else fn();
    };
    this.updateMatch = (id, updater) => {
      this.startTransition(() => {
        const pendingMatch = this.stores.pendingMatchStores.get(id);
        if (pendingMatch) {
          pendingMatch.set(updater);
          return;
        }
        const activeMatch = this.stores.matchStores.get(id);
        if (activeMatch) {
          activeMatch.set(updater);
          return;
        }
        const cachedMatch = this.stores.cachedMatchStores.get(id);
        if (cachedMatch) {
          const next = updater(cachedMatch.get());
          if (next.status === "redirected") {
            if (this.stores.cachedMatchStores.delete(id))
              this.stores.cachedIds.set((prev) => prev.filter((matchId) => matchId !== id));
          } else cachedMatch.set(next);
        }
      });
    };
    this.getMatch = (matchId) => {
      return (
        this.stores.cachedMatchStores.get(matchId)?.get() ??
        this.stores.pendingMatchStores.get(matchId)?.get() ??
        this.stores.matchStores.get(matchId)?.get()
      );
    };
    this.invalidate = (opts) => {
      const invalidate = (d) => {
        if (opts?.filter?.(d) ?? true)
          return {
            ...d,
            invalid: true,
            ...(opts?.forcePending || d.status === "error" || d.status === "notFound"
              ? {
                  status: "pending",
                  error: void 0,
                }
              : void 0),
          };
        return d;
      };
      this.batch(() => {
        this.stores.setMatches(this.stores.matches.get().map(invalidate));
        this.stores.setCached(this.stores.cachedMatches.get().map(invalidate));
        this.stores.setPending(this.stores.pendingMatches.get().map(invalidate));
      });
      this.shouldViewTransition = false;
      return this.load({ sync: opts?.sync });
    };
    this.getParsedLocationHref = (location) => {
      return location.publicHref || "/";
    };
    this.resolveRedirect = (redirect) => {
      const locationHeader = redirect.headers.get("Location");
      if (!redirect.options.href || redirect.options._builtLocation) {
        const location = redirect.options._builtLocation ?? this.buildLocation(redirect.options);
        const href = this.getParsedLocationHref(location);
        redirect.options.href = href;
        redirect.headers.set("Location", href);
      } else if (locationHeader)
        try {
          const url = new URL(locationHeader);
          if (this.origin && url.origin === this.origin) {
            const href = url.pathname + url.search + url.hash;
            redirect.options.href = href;
            redirect.headers.set("Location", href);
          }
        } catch {}
      if (
        redirect.options.href &&
        !redirect.options._builtLocation &&
        isDangerousProtocol(redirect.options.href, this.protocolAllowlist)
      )
        throw new Error("Redirect blocked: unsafe protocol");
      if (!redirect.headers.get("Location"))
        redirect.headers.set("Location", redirect.options.href);
      return redirect;
    };
    this.clearCache = (opts) => {
      const filter = opts?.filter;
      if (filter !== void 0)
        this.stores.setCached(this.stores.cachedMatches.get().filter((m) => !filter(m)));
      else this.stores.setCached([]);
    };
    this.clearExpiredCache = () => {
      const now = Date.now();
      const filter = (d) => {
        const route = this.looseRoutesById[d.routeId];
        if (!route.options.loader) return true;
        const gcTime =
          (d.preload
            ? (route.options.preloadGcTime ?? this.options.defaultPreloadGcTime)
            : (route.options.gcTime ?? this.options.defaultGcTime)) ?? 300 * 1e3;
        if (d.status === "error") return true;
        return now - d.updatedAt >= gcTime;
      };
      this.clearCache({ filter });
    };
    this.loadRouteChunk = loadRouteChunk;
    this.preloadRoute = async (opts) => {
      const next = opts._builtLocation ?? this.buildLocation(opts);
      let matches = this.matchRoutes(next, {
        throwOnError: true,
        preload: true,
        dest: opts,
      });
      const activeMatchIds = new Set([
        ...this.stores.matchesId.get(),
        ...this.stores.pendingIds.get(),
      ]);
      const loadedMatchIds = new Set([...activeMatchIds, ...this.stores.cachedIds.get()]);
      const matchesToCache = matches.filter((match) => !loadedMatchIds.has(match.id));
      if (matchesToCache.length) {
        const cachedMatches = this.stores.cachedMatches.get();
        this.stores.setCached([...cachedMatches, ...matchesToCache]);
      }
      try {
        matches = await loadMatches({
          router: this,
          matches,
          location: next,
          preload: true,
          updateMatch: (id, updater) => {
            if (activeMatchIds.has(id))
              matches = matches.map((d) => (d.id === id ? updater(d) : d));
            else this.updateMatch(id, updater);
          },
        });
        return matches;
      } catch (err) {
        if (isRedirect(err)) {
          if (err.options.reloadDocument) return;
          return await this.preloadRoute({
            ...err.options,
            _fromLocation: next,
          });
        }
        if (!isNotFound(err)) console.error(err);
        return;
      }
    };
    this.matchRoute = (location, opts) => {
      const matchLocation = {
        ...location,
        to: location.to ? this.resolvePathWithBase(location.from || "", location.to) : void 0,
        params: location.params || {},
        leaveParams: true,
      };
      const next = this.buildLocation(matchLocation);
      if (opts?.pending && this.stores.status.get() !== "pending") return false;
      const baseLocation = (opts?.pending === void 0 ? !this.stores.isLoading.get() : opts.pending)
        ? this.latestLocation
        : this.stores.resolvedLocation.get() || this.stores.location.get();
      const match = findSingleMatch(
        next.pathname,
        opts?.caseSensitive ?? false,
        opts?.fuzzy ?? false,
        baseLocation.pathname,
        this.processedTree,
      );
      if (!match) return false;
      if (location.params) {
        if (!deepEqual(match.rawParams, location.params, { partial: true })) return false;
      }
      if (opts?.includeSearch ?? true)
        return deepEqual(baseLocation.search, next.search, { partial: true })
          ? match.rawParams
          : false;
      return match.rawParams;
    };
    this.hasNotFoundMatch = () => {
      return this.stores.matches.get().some((d) => d.status === "notFound" || d.globalNotFound);
    };
    this.getStoreConfig = getStoreConfig;
    this.update({
      defaultPreloadDelay: 50,
      defaultPendingMs: 1e3,
      defaultPendingMinMs: 500,
      context: void 0,
      ...options,
      caseSensitive: options.caseSensitive ?? false,
      notFoundMode: options.notFoundMode ?? "fuzzy",
      stringifySearch: options.stringifySearch ?? defaultStringifySearch,
      parseSearch: options.parseSearch ?? defaultParseSearch,
      protocolAllowlist: options.protocolAllowlist ?? DEFAULT_PROTOCOL_ALLOWLIST,
    });
    if (typeof document !== "undefined") self.__TSR_ROUTER__ = this;
  }
  isShell() {
    return !!this.options.isShell;
  }
  isPrerendering() {
    return !!this.options.isPrerendering;
  }
  get state() {
    return this.stores.__store.get();
  }
  setRoutes({ routesById, routesByPath, processedTree }) {
    this.routesById = routesById;
    this.routesByPath = routesByPath;
    this.processedTree = processedTree;
    const notFoundRoute = this.options.notFoundRoute;
    if (notFoundRoute) {
      notFoundRoute.init({ originalIndex: 99999999999 });
      this.routesById[notFoundRoute.id] = notFoundRoute;
    }
  }
  get looseRoutesById() {
    return this.routesById;
  }
  getParentContext(parentMatch) {
    return !parentMatch?.id
      ? (this.options.context ?? void 0)
      : (parentMatch.context ?? this.options.context ?? void 0);
  }
  matchRoutesInternal(next, opts) {
    const matchedRoutesResult = this.getMatchedRoutes(next.pathname);
    const { foundRoute, routeParams, parsedParams } = matchedRoutesResult;
    let { matchedRoutes } = matchedRoutesResult;
    let isGlobalNotFound = false;
    if (foundRoute ? foundRoute.path !== "/" && routeParams["**"] : trimPathRight(next.pathname))
      if (this.options.notFoundRoute)
        matchedRoutes = [...matchedRoutes, this.options.notFoundRoute];
      else isGlobalNotFound = true;
    const globalNotFoundRouteId = isGlobalNotFound
      ? findGlobalNotFoundRouteId(this.options.notFoundMode, matchedRoutes)
      : void 0;
    const matches = new Array(matchedRoutes.length);
    const previousActiveMatchesByRouteId = /* @__PURE__ */ new Map();
    for (const store of this.stores.matchStores.values())
      if (store.routeId) previousActiveMatchesByRouteId.set(store.routeId, store.get());
    for (let index = 0; index < matchedRoutes.length; index++) {
      const route = matchedRoutes[index];
      const parentMatch = matches[index - 1];
      let preMatchSearch;
      let strictMatchSearch;
      let searchError;
      {
        const parentSearch = parentMatch?.search ?? next.search;
        const parentStrictSearch = parentMatch?._strictSearch ?? void 0;
        try {
          const strictSearch =
            validateSearch(route.options.validateSearch, { ...parentSearch }) ?? void 0;
          preMatchSearch = {
            ...parentSearch,
            ...strictSearch,
          };
          strictMatchSearch = {
            ...parentStrictSearch,
            ...strictSearch,
          };
          searchError = void 0;
        } catch (err) {
          let searchParamError = err;
          if (!(err instanceof SearchParamError))
            searchParamError = new SearchParamError(err.message, { cause: err });
          if (opts?.throwOnError) throw searchParamError;
          preMatchSearch = parentSearch;
          strictMatchSearch = {};
          searchError = searchParamError;
        }
      }
      const loaderDeps = route.options.loaderDeps?.({ search: preMatchSearch }) ?? "";
      const loaderDepsHash = loaderDeps ? JSON.stringify(loaderDeps) : "";
      const { interpolatedPath, usedParams } = interpolatePath({
        path: route.fullPath,
        params: routeParams,
        decoder: this.pathParamsDecoder,
        server: this.isServer,
      });
      const matchId = route.id + interpolatedPath + loaderDepsHash;
      const existingMatch = this.getMatch(matchId);
      const previousMatch = previousActiveMatchesByRouteId.get(route.id);
      const strictParams = existingMatch?._strictParams ?? usedParams;
      let paramsError = void 0;
      if (!existingMatch)
        try {
          extractStrictParams(route, usedParams, parsedParams, strictParams);
        } catch (err) {
          if (isNotFound(err) || isRedirect(err)) paramsError = err;
          else paramsError = new PathParamError(err.message, { cause: err });
          if (opts?.throwOnError) throw paramsError;
        }
      Object.assign(routeParams, strictParams);
      const cause = previousMatch ? "stay" : "enter";
      let match;
      if (existingMatch)
        match = {
          ...existingMatch,
          cause,
          params: previousMatch?.params ?? routeParams,
          _strictParams: strictParams,
          search: previousMatch
            ? nullReplaceEqualDeep(previousMatch.search, preMatchSearch)
            : nullReplaceEqualDeep(existingMatch.search, preMatchSearch),
          _strictSearch: strictMatchSearch,
        };
      else {
        const status =
          route.options.loader ||
          route.options.beforeLoad ||
          route.lazyFn ||
          routeNeedsPreload(route)
            ? "pending"
            : "success";
        match = {
          id: matchId,
          ssr: void 0,
          index,
          routeId: route.id,
          params: previousMatch?.params ?? routeParams,
          _strictParams: strictParams,
          pathname: interpolatedPath,
          updatedAt: Date.now(),
          search: previousMatch
            ? nullReplaceEqualDeep(previousMatch.search, preMatchSearch)
            : preMatchSearch,
          _strictSearch: strictMatchSearch,
          searchError: void 0,
          status,
          isFetching: false,
          error: void 0,
          paramsError,
          __routeContext: void 0,
          _nonReactive: { loadPromise: createControlledPromise() },
          __beforeLoadContext: void 0,
          context: {},
          abortController: new AbortController(),
          fetchCount: 0,
          cause,
          loaderDeps: previousMatch
            ? replaceEqualDeep(previousMatch.loaderDeps, loaderDeps)
            : loaderDeps,
          invalid: false,
          preload: false,
          links: void 0,
          scripts: void 0,
          headScripts: void 0,
          meta: void 0,
          staticData: route.options.staticData || {},
          fullPath: route.fullPath,
        };
      }
      if (!opts?.preload) match.globalNotFound = globalNotFoundRouteId === route.id;
      match.searchError = searchError;
      const parentContext = this.getParentContext(parentMatch);
      match.context = {
        ...parentContext,
        ...match.__routeContext,
        ...match.__beforeLoadContext,
      };
      matches[index] = match;
    }
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      const route = this.looseRoutesById[match.routeId];
      const existingMatch = this.getMatch(match.id);
      const previousMatch = previousActiveMatchesByRouteId.get(match.routeId);
      match.params = previousMatch
        ? nullReplaceEqualDeep(previousMatch.params, routeParams)
        : routeParams;
      if (!existingMatch) {
        const parentMatch = matches[index - 1];
        const parentContext = this.getParentContext(parentMatch);
        if (route.options.context) {
          const contextFnContext = {
            deps: match.loaderDeps,
            params: match.params,
            context: parentContext ?? {},
            location: next,
            navigate: (opts) =>
              this.navigate({
                ...opts,
                _fromLocation: next,
              }),
            buildLocation: this.buildLocation,
            cause: match.cause,
            abortController: match.abortController,
            preload: !!match.preload,
            matches,
            routeId: route.id,
          };
          match.__routeContext = route.options.context(contextFnContext) ?? void 0;
        }
        match.context = {
          ...parentContext,
          ...match.__routeContext,
          ...match.__beforeLoadContext,
        };
      }
    }
    return matches;
  }
  /**
   * Lightweight route matching for buildLocation.
   * Only computes fullPath, accumulated search, and params - skipping expensive
   * operations like AbortController, ControlledPromise, loaderDeps, and full match objects.
   */
  matchRoutesLightweight(location) {
    const { matchedRoutes, routeParams, parsedParams } = this.getMatchedRoutes(location.pathname);
    const lastRoute = last(matchedRoutes);
    const accumulatedSearch = { ...location.search };
    for (const route of matchedRoutes)
      try {
        Object.assign(
          accumulatedSearch,
          validateSearch(route.options.validateSearch, accumulatedSearch),
        );
      } catch {}
    const lastStateMatchId = last(this.stores.matchesId.get());
    const lastStateMatch = lastStateMatchId && this.stores.matchStores.get(lastStateMatchId)?.get();
    const canReuseParams =
      lastStateMatch &&
      lastStateMatch.routeId === lastRoute.id &&
      lastStateMatch.pathname === location.pathname;
    let params;
    if (canReuseParams) params = lastStateMatch.params;
    else {
      const strictParams = Object.assign(Object.create(null), routeParams);
      for (const route of matchedRoutes)
        try {
          extractStrictParams(route, routeParams, parsedParams ?? {}, strictParams);
        } catch {}
      params = strictParams;
    }
    return {
      matchedRoutes,
      fullPath: lastRoute.fullPath,
      search: accumulatedSearch,
      params,
    };
  }
};
/** Error thrown when search parameter validation fails. */
var SearchParamError = class extends Error {};
/** Error thrown when path parameter parsing/validation fails. */
var PathParamError = class extends Error {};
/** Create an initial RouterState from a parsed location. */
function getInitialRouterState(location) {
  return {
    loadedAt: 0,
    isLoading: false,
    isTransitioning: false,
    status: "idle",
    resolvedLocation: void 0,
    location,
    matches: [],
    statusCode: 200,
  };
}
function validateSearch(validateSearch, input) {
  if (validateSearch == null) return {};
  if ("~standard" in validateSearch) {
    const result = validateSearch["~standard"].validate(input);
    if (result instanceof Promise) throw new SearchParamError("Async validation not supported");
    if (result.issues)
      throw new SearchParamError(JSON.stringify(result.issues, void 0, 2), { cause: result });
    return result.value;
  }
  if ("parse" in validateSearch) return validateSearch.parse(input);
  if (typeof validateSearch === "function") return validateSearch(input);
  return {};
}
/**
 * Build the matched route chain and extract params for a pathname.
 * Falls back to the root route if no specific route is found.
 */
function getMatchedRoutes({ pathname, routesById, processedTree }) {
  const routeParams = Object.create(null);
  const trimmedPath = trimPathRight(pathname);
  let foundRoute = void 0;
  let parsedParams = void 0;
  const match = findRouteMatch(trimmedPath, processedTree, true);
  if (match) {
    foundRoute = match.route;
    Object.assign(routeParams, match.rawParams);
    parsedParams = Object.assign(Object.create(null), match.parsedParams);
  }
  return {
    matchedRoutes: match?.branch || [routesById["__root__"]],
    routeParams,
    foundRoute,
    parsedParams,
  };
}
/**
 * TODO: once caches are persisted across requests on the server,
 * we can cache the built middleware chain using `last(destRoutes)` as the key
 */
function applySearchMiddleware({ search, dest, destRoutes, _includeValidateSearch }) {
  return buildMiddlewareChain(destRoutes)(search, dest, _includeValidateSearch ?? false);
}
function buildMiddlewareChain(destRoutes) {
  const context = {
    dest: null,
    _includeValidateSearch: false,
    middlewares: [],
  };
  for (const route of destRoutes) {
    if ("search" in route.options) {
      if (route.options.search?.middlewares)
        context.middlewares.push(...route.options.search.middlewares);
    } else if (route.options.preSearchFilters || route.options.postSearchFilters) {
      const legacyMiddleware = ({ search, next }) => {
        let nextSearch = search;
        if ("preSearchFilters" in route.options && route.options.preSearchFilters)
          nextSearch = route.options.preSearchFilters.reduce((prev, next) => next(prev), search);
        const result = next(nextSearch);
        if ("postSearchFilters" in route.options && route.options.postSearchFilters)
          return route.options.postSearchFilters.reduce((prev, next) => next(prev), result);
        return result;
      };
      context.middlewares.push(legacyMiddleware);
    }
    if (route.options.validateSearch) {
      const validate = ({ search, next }) => {
        const result = next(search);
        if (!context._includeValidateSearch) return result;
        try {
          return {
            ...result,
            ...(validateSearch(route.options.validateSearch, result) ?? void 0),
          };
        } catch {
          return result;
        }
      };
      context.middlewares.push(validate);
    }
  }
  const final = ({ search }) => {
    const dest = context.dest;
    if (!dest.search) return {};
    if (dest.search === true) return search;
    return functionalUpdate(dest.search, search);
  };
  context.middlewares.push(final);
  const applyNext = (index, currentSearch, middlewares) => {
    if (index >= middlewares.length) return currentSearch;
    const middleware = middlewares[index];
    const next = (newSearch) => {
      return applyNext(index + 1, newSearch, middlewares);
    };
    return middleware({
      search: currentSearch,
      next,
    });
  };
  return function middleware(search, dest, _includeValidateSearch) {
    context.dest = dest;
    context._includeValidateSearch = _includeValidateSearch;
    return applyNext(0, search, context.middlewares);
  };
}
function findGlobalNotFoundRouteId(notFoundMode, routes) {
  if (notFoundMode !== "root")
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i];
      if (route.children) return route.id;
    }
  return rootRouteId;
}
function extractStrictParams(route, referenceParams, parsedParams, accumulatedParams) {
  const parseParams = route.options.params?.parse ?? route.options.parseParams;
  if (parseParams)
    if (route.options.skipRouteOnParseError) {
      for (const key in referenceParams)
        if (key in parsedParams) accumulatedParams[key] = parsedParams[key];
    } else {
      const result = parseParams(accumulatedParams);
      Object.assign(accumulatedParams, result);
    }
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/manifest.js
function getAssetCrossOrigin(assetCrossOrigin, kind) {
  if (!assetCrossOrigin) return;
  if (typeof assetCrossOrigin === "string") return assetCrossOrigin;
  return assetCrossOrigin[kind];
}
function resolveManifestAssetLink(link) {
  if (typeof link === "string")
    return {
      href: link,
      crossOrigin: void 0,
    };
  return link;
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/CatchBoundary.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
function CatchBoundary(props) {
  const errorComponent = props.errorComponent ?? ErrorComponent;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CatchBoundaryImpl, {
    getResetKey: props.getResetKey,
    onCatch: props.onCatch,
    children: ({ error, reset }) => {
      if (error)
        return import_react.createElement(errorComponent, {
          error,
          reset,
        });
      return props.children;
    },
  });
}
var CatchBoundaryImpl = class extends import_react.Component {
  constructor(..._args) {
    super(..._args);
    this.state = { error: null };
  }
  static getDerivedStateFromProps(props, state) {
    const resetKey = props.getResetKey();
    if (state.error && state.resetKey !== resetKey)
      return {
        resetKey,
        error: null,
      };
    return { resetKey };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  reset() {
    this.setState({ error: null });
  }
  componentDidCatch(error, errorInfo) {
    if (this.props.onCatch) this.props.onCatch(error, errorInfo);
  }
  render() {
    return this.props.children({
      error: this.state.error,
      reset: () => {
        this.reset();
      },
    });
  }
};
function ErrorComponent({ error }) {
  const [show, setShow] = import_react.useState(false);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
    style: {
      padding: ".5rem",
      maxWidth: "100%",
    },
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: ".5rem",
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
            style: { fontSize: "1rem" },
            children: "Something went wrong!",
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
            style: {
              appearance: "none",
              fontSize: ".6em",
              border: "1px solid currentColor",
              padding: ".1rem .2rem",
              fontWeight: "bold",
              borderRadius: ".25rem",
            },
            onClick: () => setShow((d) => !d),
            children: show ? "Hide Error" : "Show Error",
          }),
        ],
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { height: ".25rem" } }),
      show
        ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
              style: {
                fontSize: ".7em",
                border: "1px solid red",
                borderRadius: ".25rem",
                padding: ".3rem",
                color: "red",
                overflow: "auto",
              },
              children: error.message
                ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: error.message })
                : null,
            }),
          })
        : null,
    ],
  });
}
//#endregion
//#region node_modules/@tanstack/store/dist/esm/alien.js
var ReactiveFlags = /* @__PURE__ */ ((ReactiveFlags2) => {
  ReactiveFlags2[(ReactiveFlags2["None"] = 0)] = "None";
  ReactiveFlags2[(ReactiveFlags2["Mutable"] = 1)] = "Mutable";
  ReactiveFlags2[(ReactiveFlags2["Watching"] = 2)] = "Watching";
  ReactiveFlags2[(ReactiveFlags2["RecursedCheck"] = 4)] = "RecursedCheck";
  ReactiveFlags2[(ReactiveFlags2["Recursed"] = 8)] = "Recursed";
  ReactiveFlags2[(ReactiveFlags2["Dirty"] = 16)] = "Dirty";
  ReactiveFlags2[(ReactiveFlags2["Pending"] = 32)] = "Pending";
  return ReactiveFlags2;
})(ReactiveFlags || {});
/* @__NO_SIDE_EFFECTS__ */
function createReactiveSystem({ update, notify, unwatched }) {
  return {
    link,
    unlink,
    propagate,
    checkDirty,
    shallowPropagate,
  };
  function link(dep, sub, version) {
    const prevDep = sub.depsTail;
    if (prevDep !== void 0 && prevDep.dep === dep) return;
    const nextDep = prevDep !== void 0 ? prevDep.nextDep : sub.deps;
    if (nextDep !== void 0 && nextDep.dep === dep) {
      nextDep.version = version;
      sub.depsTail = nextDep;
      return;
    }
    const prevSub = dep.subsTail;
    if (prevSub !== void 0 && prevSub.version === version && prevSub.sub === sub) return;
    const newLink =
      (sub.depsTail =
      dep.subsTail =
        {
          version,
          dep,
          sub,
          prevDep,
          nextDep,
          prevSub,
          nextSub: void 0,
        });
    if (nextDep !== void 0) nextDep.prevDep = newLink;
    if (prevDep !== void 0) prevDep.nextDep = newLink;
    else sub.deps = newLink;
    if (prevSub !== void 0) prevSub.nextSub = newLink;
    else dep.subs = newLink;
  }
  function unlink(link2, sub = link2.sub) {
    const dep = link2.dep;
    const prevDep = link2.prevDep;
    const nextDep = link2.nextDep;
    const nextSub = link2.nextSub;
    const prevSub = link2.prevSub;
    if (nextDep !== void 0) nextDep.prevDep = prevDep;
    else sub.depsTail = prevDep;
    if (prevDep !== void 0) prevDep.nextDep = nextDep;
    else sub.deps = nextDep;
    if (nextSub !== void 0) nextSub.prevSub = prevSub;
    else dep.subsTail = prevSub;
    if (prevSub !== void 0) prevSub.nextSub = nextSub;
    else if ((dep.subs = nextSub) === void 0) unwatched(dep);
    return nextDep;
  }
  function propagate(link2) {
    let next = link2.nextSub;
    let stack;
    top: do {
      const sub = link2.sub;
      let flags = sub.flags;
      if (!(flags & 60)) sub.flags = flags | 32;
      else if (!(flags & 12)) flags = 0;
      else if (!(flags & 4)) sub.flags = (flags & -9) | 32;
      else if (!(flags & 48) && isValidLink(link2, sub)) {
        sub.flags = flags | 40;
        flags &= 1;
      } else flags = 0;
      if (flags & 2) notify(sub);
      if (flags & 1) {
        const subSubs = sub.subs;
        if (subSubs !== void 0) {
          const nextSub = (link2 = subSubs).nextSub;
          if (nextSub !== void 0) {
            stack = {
              value: next,
              prev: stack,
            };
            next = nextSub;
          }
          continue;
        }
      }
      if ((link2 = next) !== void 0) {
        next = link2.nextSub;
        continue;
      }
      while (stack !== void 0) {
        link2 = stack.value;
        stack = stack.prev;
        if (link2 !== void 0) {
          next = link2.nextSub;
          continue top;
        }
      }
      break;
    } while (true);
  }
  function checkDirty(link2, sub) {
    let stack;
    let checkDepth = 0;
    let dirty = false;
    top: do {
      const dep = link2.dep;
      const flags = dep.flags;
      if (sub.flags & 16) dirty = true;
      else if ((flags & 17) === 17) {
        if (update(dep)) {
          const subs = dep.subs;
          if (subs.nextSub !== void 0) shallowPropagate(subs);
          dirty = true;
        }
      } else if ((flags & 33) === 33) {
        if (link2.nextSub !== void 0 || link2.prevSub !== void 0)
          stack = {
            value: link2,
            prev: stack,
          };
        link2 = dep.deps;
        sub = dep;
        ++checkDepth;
        continue;
      }
      if (!dirty) {
        const nextDep = link2.nextDep;
        if (nextDep !== void 0) {
          link2 = nextDep;
          continue;
        }
      }
      while (checkDepth--) {
        const firstSub = sub.subs;
        const hasMultipleSubs = firstSub.nextSub !== void 0;
        if (hasMultipleSubs) {
          link2 = stack.value;
          stack = stack.prev;
        } else link2 = firstSub;
        if (dirty) {
          if (update(sub)) {
            if (hasMultipleSubs) shallowPropagate(firstSub);
            sub = link2.sub;
            continue;
          }
          dirty = false;
        } else sub.flags &= -33;
        sub = link2.sub;
        const nextDep = link2.nextDep;
        if (nextDep !== void 0) {
          link2 = nextDep;
          continue top;
        }
      }
      return dirty;
    } while (true);
  }
  function shallowPropagate(link2) {
    do {
      const sub = link2.sub;
      const flags = sub.flags;
      if ((flags & 48) === 32) {
        sub.flags = flags | 16;
        if ((flags & 6) === 2) notify(sub);
      }
    } while ((link2 = link2.nextSub) !== void 0);
  }
  function isValidLink(checkLink, sub) {
    let link2 = sub.depsTail;
    while (link2 !== void 0) {
      if (link2 === checkLink) return true;
      link2 = link2.prevDep;
    }
    return false;
  }
}
//#endregion
//#region node_modules/@tanstack/store/dist/esm/atom.js
function toObserver(nextHandler, errorHandler, completionHandler) {
  const isObserver = typeof nextHandler === "object";
  const self = isObserver ? nextHandler : void 0;
  return {
    next: (isObserver ? nextHandler.next : nextHandler)?.bind(self),
    error: (isObserver ? nextHandler.error : errorHandler)?.bind(self),
    complete: (isObserver ? nextHandler.complete : completionHandler)?.bind(self),
  };
}
var queuedEffects = [];
var cycle = 0;
var { link, unlink, propagate, checkDirty, shallowPropagate } =
  /* @__PURE__ */ createReactiveSystem({
    update(atom) {
      return atom._update();
    },
    notify(effect2) {
      queuedEffects[queuedEffectsLength++] = effect2;
      effect2.flags &= ~ReactiveFlags.Watching;
    },
    unwatched(atom) {
      if (atom.depsTail !== void 0) {
        atom.depsTail = void 0;
        atom.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        purgeDeps(atom);
      }
    },
  });
var notifyIndex = 0;
var queuedEffectsLength = 0;
var activeSub;
var batchDepth = 0;
function batch(fn) {
  try {
    ++batchDepth;
    fn();
  } finally {
    if (!--batchDepth) flush();
  }
}
function purgeDeps(sub) {
  const depsTail = sub.depsTail;
  let dep = depsTail !== void 0 ? depsTail.nextDep : sub.deps;
  while (dep !== void 0) dep = unlink(dep, sub);
}
function flush() {
  if (batchDepth > 0) return;
  while (notifyIndex < queuedEffectsLength) {
    const effect2 = queuedEffects[notifyIndex];
    queuedEffects[notifyIndex++] = void 0;
    effect2.notify();
  }
  notifyIndex = 0;
  queuedEffectsLength = 0;
}
function createAtom(valueOrFn, options) {
  const isComputed = typeof valueOrFn === "function";
  const getter = valueOrFn;
  const atom = {
    _snapshot: isComputed ? void 0 : valueOrFn,
    subs: void 0,
    subsTail: void 0,
    deps: void 0,
    depsTail: void 0,
    flags: isComputed ? ReactiveFlags.None : ReactiveFlags.Mutable,
    get() {
      if (activeSub !== void 0) link(atom, activeSub, cycle);
      return atom._snapshot;
    },
    subscribe(observerOrFn) {
      const obs = toObserver(observerOrFn);
      const observed = { current: false };
      const e = effect(() => {
        atom.get();
        if (!observed.current) observed.current = true;
        else obs.next?.(atom._snapshot);
      });
      return {
        unsubscribe: () => {
          e.stop();
        },
      };
    },
    _update(getValue) {
      const prevSub = activeSub;
      const compare = options?.compare ?? Object.is;
      if (isComputed) {
        activeSub = atom;
        ++cycle;
        atom.depsTail = void 0;
      } else if (getValue === void 0) return false;
      if (isComputed) atom.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
      try {
        const oldValue = atom._snapshot;
        const newValue =
          typeof getValue === "function"
            ? getValue(oldValue)
            : getValue === void 0 && isComputed
              ? getter(oldValue)
              : getValue;
        if (oldValue === void 0 || !compare(oldValue, newValue)) {
          atom._snapshot = newValue;
          return true;
        }
        return false;
      } finally {
        activeSub = prevSub;
        if (isComputed) atom.flags &= ~ReactiveFlags.RecursedCheck;
        purgeDeps(atom);
      }
    },
  };
  if (isComputed) {
    atom.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
    atom.get = function () {
      const flags = atom.flags;
      if (
        flags & ReactiveFlags.Dirty ||
        (flags & ReactiveFlags.Pending && checkDirty(atom.deps, atom))
      ) {
        if (atom._update()) {
          const subs = atom.subs;
          if (subs !== void 0) shallowPropagate(subs);
        }
      } else if (flags & ReactiveFlags.Pending) atom.flags = flags & ~ReactiveFlags.Pending;
      if (activeSub !== void 0) link(atom, activeSub, cycle);
      return atom._snapshot;
    };
  } else
    atom.set = function (valueOrFn2) {
      if (atom._update(valueOrFn2)) {
        const subs = atom.subs;
        if (subs !== void 0) {
          propagate(subs);
          shallowPropagate(subs);
          flush();
        }
      }
    };
  return atom;
}
function effect(fn) {
  const run = () => {
    const prevSub = activeSub;
    activeSub = effectObj;
    ++cycle;
    effectObj.depsTail = void 0;
    effectObj.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    try {
      return fn();
    } finally {
      activeSub = prevSub;
      effectObj.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(effectObj);
    }
  };
  const effectObj = {
    deps: void 0,
    depsTail: void 0,
    subs: void 0,
    subsTail: void 0,
    flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
    notify() {
      const flags = this.flags;
      if (
        flags & ReactiveFlags.Dirty ||
        (flags & ReactiveFlags.Pending && checkDirty(this.deps, this))
      )
        run();
      else this.flags = ReactiveFlags.Watching;
    },
    stop() {
      this.flags = ReactiveFlags.None;
      this.depsTail = void 0;
      purgeDeps(this);
    },
  };
  run();
  return effectObj;
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/not-found.js
function CatchNotFound(props) {
  const router = useRouter();
  {
    const resetKey = `not-found-${router.stores.location.get().pathname}-${router.stores.status.get()}`;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CatchBoundary, {
      getResetKey: () => resetKey,
      onCatch: (error, errorInfo) => {
        if (isNotFound(error)) props.onCatch?.(error, errorInfo);
        else throw error;
      },
      errorComponent: ({ error }) => {
        if (isNotFound(error)) return props.fallback?.(error);
        else throw error;
      },
      children: props.children,
    });
  }
  const resetKey = `not-found-${useStore(router.stores.location, (location) => location.pathname)}-${useStore(router.stores.status, (status) => status)}`;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CatchBoundary, {
    getResetKey: () => resetKey,
    onCatch: (error, errorInfo) => {
      if (isNotFound(error)) props.onCatch?.(error, errorInfo);
      else throw error;
    },
    errorComponent: ({ error }) => {
      if (isNotFound(error)) return props.fallback?.(error);
      else throw error;
    },
    children: props.children,
  });
}
function DefaultGlobalNotFound() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "Not Found" });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/ScriptOnce.js
/**
 * Server-only helper to emit a script tag exactly once during SSR.
 */
function ScriptOnce({ children }) {
  const router = useRouter();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("script", {
    nonce: router.options.ssr?.nonce,
    dangerouslySetInnerHTML: { __html: children + ";document.currentScript.remove()" },
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/SafeFragment.js
function SafeFragment(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {
    children: props.children,
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/renderRouteNotFound.js
/**
 * Renders a not found component for a route when no matching route is found.
 *
 * @param router - The router instance containing the route configuration
 * @param route - The route that triggered the not found state
 * @param data - Additional data to pass to the not found component
 * @returns The rendered not found component or a default fallback component
 */
function renderRouteNotFound(router, route, data) {
  if (!route.options.notFoundComponent) {
    if (router.options.defaultNotFoundComponent)
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(router.options.defaultNotFoundComponent, {
        ...data,
      });
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DefaultGlobalNotFound, {});
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(route.options.notFoundComponent, { ...data });
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/scroll-restoration-script/client.js
function getScrollRestorationScriptForRouter(_router) {
  return null;
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/scroll-restoration.js
function ScrollRestoration() {
  const script = getScrollRestorationScriptForRouter(useRouter());
  if (!script) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScriptOnce, { children: script });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/Match.js
var Match = import_react.memo(function MatchImpl({ matchId }) {
  const router = useRouter();
  {
    const match = router.stores.matchStores.get(matchId)?.get();
    if (!match) invariant();
    const routeId = match.routeId;
    const parentRouteId = router.routesById[routeId].parentRoute?.id;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchView, {
      router,
      matchId,
      resetKey: router.stores.loadedAt.get(),
      matchState: {
        routeId,
        ssr: match.ssr,
        _displayPending: match._displayPending,
        parentRouteId,
      },
    });
  }
  const matchStore = router.stores.matchStores.get(matchId);
  if (!matchStore) invariant();
  const resetKey = useStore(router.stores.loadedAt, (loadedAt) => loadedAt);
  const match = useStore(matchStore, (value) => value);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchView, {
    router,
    matchId,
    resetKey,
    matchState: import_react.useMemo(() => {
      const routeId = match.routeId;
      const parentRouteId = router.routesById[routeId].parentRoute?.id;
      return {
        routeId,
        ssr: match.ssr,
        _displayPending: match._displayPending,
        parentRouteId,
      };
    }, [match._displayPending, match.routeId, match.ssr, router.routesById]),
  });
});
function MatchView({ router, matchId, resetKey, matchState }) {
  const route = router.routesById[matchState.routeId];
  const PendingComponent = route.options.pendingComponent ?? router.options.defaultPendingComponent;
  const pendingElement = PendingComponent
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PendingComponent, {})
    : null;
  const routeErrorComponent = route.options.errorComponent ?? router.options.defaultErrorComponent;
  const routeOnCatch = route.options.onCatch ?? router.options.defaultOnCatch;
  const routeNotFoundComponent = route.isRoot
    ? (route.options.notFoundComponent ?? router.options.notFoundRoute?.options.component)
    : route.options.notFoundComponent;
  const resolvedNoSsr = matchState.ssr === false || matchState.ssr === "data-only";
  const ResolvedSuspenseBoundary =
    (!route.isRoot || route.options.wrapInSuspense || resolvedNoSsr) &&
    (route.options.wrapInSuspense ??
      PendingComponent ??
      (route.options.errorComponent?.preload || resolvedNoSsr))
      ? import_react.Suspense
      : SafeFragment;
  const ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment;
  const ResolvedNotFoundBoundary = routeNotFoundComponent ? CatchNotFound : SafeFragment;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    route.isRoot ? (route.options.shellComponent ?? SafeFragment) : SafeFragment,
    {
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(matchContext.Provider, {
          value: matchId,
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResolvedSuspenseBoundary, {
            fallback: pendingElement,
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResolvedCatchBoundary, {
              getResetKey: () => resetKey,
              errorComponent: routeErrorComponent || ErrorComponent,
              onCatch: (error, errorInfo) => {
                if (isNotFound(error)) {
                  error.routeId ??= matchState.routeId;
                  throw error;
                }
                routeOnCatch?.(error, errorInfo);
              },
              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResolvedNotFoundBoundary, {
                fallback: (error) => {
                  error.routeId ??= matchState.routeId;
                  if (
                    !routeNotFoundComponent ||
                    (error.routeId && error.routeId !== matchState.routeId) ||
                    (!error.routeId && !route.isRoot)
                  )
                    throw error;
                  return import_react.createElement(routeNotFoundComponent, error);
                },
                children:
                  resolvedNoSsr || matchState._displayPending
                    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ClientOnly, {
                        fallback: pendingElement,
                        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchInner, {
                          matchId,
                        }),
                      })
                    : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchInner, { matchId }),
              }),
            }),
          }),
        }),
        matchState.parentRouteId === "__root__"
          ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, {
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OnRendered, { resetKey }),
                router.options.scrollRestoration && true
                  ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScrollRestoration, {})
                  : null,
              ],
            })
          : null,
      ],
    },
  );
}
function OnRendered({ resetKey }) {
  useRouter();
  return null;
}
var MatchInner = import_react.memo(function MatchInnerImpl({ matchId }) {
  const router = useRouter();
  const getMatchPromise = (match, key) => {
    return router.getMatch(match.id)?._nonReactive[key] ?? match._nonReactive[key];
  };
  {
    const match = router.stores.matchStores.get(matchId)?.get();
    if (!match) invariant();
    const routeId = match.routeId;
    const route = router.routesById[routeId];
    const remountDeps = (
      router.routesById[routeId].options.remountDeps ?? router.options.defaultRemountDeps
    )?.({
      routeId,
      loaderDeps: match.loaderDeps,
      params: match._strictParams,
      search: match._strictSearch,
    });
    const key = remountDeps ? JSON.stringify(remountDeps) : void 0;
    const Comp = route.options.component ?? router.options.defaultComponent;
    const out = Comp
      ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Comp, {}, key)
      : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {});
    if (match._displayPending) throw getMatchPromise(match, "displayPendingPromise");
    if (match._forcePending) throw getMatchPromise(match, "minPendingPromise");
    if (match.status === "pending") throw getMatchPromise(match, "loadPromise");
    if (match.status === "notFound") {
      if (!isNotFound(match.error)) invariant();
      return renderRouteNotFound(router, route, match.error);
    }
    if (match.status === "redirected") {
      if (!isRedirect(match.error)) invariant();
      throw getMatchPromise(match, "loadPromise");
    }
    if (match.status === "error")
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        (route.options.errorComponent ?? router.options.defaultErrorComponent) || ErrorComponent,
        {
          error: match.error,
          reset: void 0,
          info: { componentStack: "" },
        },
      );
    return out;
  }
  const matchStore = router.stores.matchStores.get(matchId);
  if (!matchStore) invariant();
  const match = useStore(matchStore, (value) => value);
  const routeId = match.routeId;
  const route = router.routesById[routeId];
  const key = import_react.useMemo(() => {
    const remountDeps = (
      router.routesById[routeId].options.remountDeps ?? router.options.defaultRemountDeps
    )?.({
      routeId,
      loaderDeps: match.loaderDeps,
      params: match._strictParams,
      search: match._strictSearch,
    });
    return remountDeps ? JSON.stringify(remountDeps) : void 0;
  }, [
    routeId,
    match.loaderDeps,
    match._strictParams,
    match._strictSearch,
    router.options.defaultRemountDeps,
    router.routesById,
  ]);
  const out = import_react.useMemo(() => {
    const Comp = route.options.component ?? router.options.defaultComponent;
    if (Comp) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Comp, {}, key);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {});
  }, [key, route.options.component, router.options.defaultComponent]);
  if (match._displayPending) throw getMatchPromise(match, "displayPendingPromise");
  if (match._forcePending) throw getMatchPromise(match, "minPendingPromise");
  if (match.status === "pending") {
    if (route.options.pendingMinMs ?? router.options.defaultPendingMinMs) {
      const routerMatch = router.getMatch(match.id);
      if (routerMatch && !routerMatch._nonReactive.minPendingPromise) {
      }
    }
    throw getMatchPromise(match, "loadPromise");
  }
  if (match.status === "notFound") {
    if (!isNotFound(match.error)) invariant();
    return renderRouteNotFound(router, route, match.error);
  }
  if (match.status === "redirected") {
    if (!isRedirect(match.error)) invariant();
    throw getMatchPromise(match, "loadPromise");
  }
  if (match.status === "error")
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      (route.options.errorComponent ?? router.options.defaultErrorComponent) || ErrorComponent,
      {
        error: match.error,
        reset: void 0,
        info: { componentStack: "" },
      },
    );
  return out;
});
/**
 * Render the next child match in the route tree. Typically used inside
 * a route component to render nested routes.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/outletComponent
 */
var Outlet = import_react.memo(function OutletImpl() {
  const router = useRouter();
  const matchId = import_react.useContext(matchContext);
  let routeId;
  let parentGlobalNotFound = false;
  let childMatchId;
  {
    const matches = router.stores.matches.get();
    const parentIndex = matchId ? matches.findIndex((match) => match.id === matchId) : -1;
    const parentMatch = parentIndex >= 0 ? matches[parentIndex] : void 0;
    routeId = parentMatch?.routeId;
    parentGlobalNotFound = parentMatch?.globalNotFound ?? false;
    childMatchId = parentIndex >= 0 ? matches[parentIndex + 1]?.id : void 0;
  }
  const route = routeId ? router.routesById[routeId] : void 0;
  const pendingElement = router.options.defaultPendingComponent
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(router.options.defaultPendingComponent, {})
    : null;
  if (parentGlobalNotFound) {
    if (!route) invariant();
    return renderRouteNotFound(router, route, void 0);
  }
  if (!childMatchId) return null;
  const nextMatch = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Match, { matchId: childMatchId });
  if (routeId === "__root__")
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react.Suspense, {
      fallback: pendingElement,
      children: nextMatch,
    });
  return nextMatch;
});
//#endregion
//#region src/lib/ws-response.ts
var WebSocketResponse = class extends Response {
  wsHooks;
  constructor(hooks) {
    super("WebSocket upgrade required", { status: 426 });
    this.wsHooks = hooks;
  }
};
//#endregion
//#region src/db/schema.ts
var schema_exports = /* @__PURE__ */ __exportAll({ thingsTable: () => thingsTable });
var thingsTable = sqliteTable(
  "things",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("things_created_at_idx").on(table.createdAt)],
);
//#endregion
export {
  View as $,
  inArray as A,
  notIlike as B,
  and as C,
  gt as D,
  exists as E,
  lte as F,
  getTableColumns as G,
  notLike as H,
  ne as I,
  mapResultRow as J,
  getTableLikeName as K,
  not as L,
  isNull as M,
  like as N,
  gte as O,
  lt as P,
  SQL as Q,
  notBetween as R,
  desc as S,
  eq as T,
  or as U,
  notInArray as V,
  applyMixins as W,
  orderSelectedFields as X,
  mapUpdateSet as Y,
  Param as Z,
  createNonReactiveReadonlyStore as _,
  Outlet as a,
  Column as at,
  SQLiteColumn as b,
  createAtom as c,
  getTableName as ct,
  getAssetCrossOrigin as d,
  is as dt,
  fillPlaceholders as et,
  resolveManifestAssetLink as f,
  createNonReactiveMutableStore as g,
  createMemoryHistory as h,
  Match as i,
  WithSubquery as it,
  isNotNull as j,
  ilike as k,
  CatchBoundary as l,
  getTableUniqueName as lt,
  getLocationChangeInfo as m,
  thingsTable as n,
  ViewBaseConfig as nt,
  SafeFragment as o,
  Columns as ot,
  RouterCore as p,
  haveSameKeys as q,
  WebSocketResponse as r,
  Subquery as rt,
  batch as s,
  Table as st,
  schema_exports as t,
  sql as tt,
  ErrorComponent as u,
  entityKind as ut,
  executeRewriteInput as v,
  between as w,
  asc as x,
  SQLiteTable as y,
  notExists as z,
};
