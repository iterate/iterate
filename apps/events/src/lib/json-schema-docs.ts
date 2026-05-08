const combiners = ["anyOf", "oneOf"] as const;

type JsonSchemaRecord = Record<string, unknown>;
type DiscriminatorValue = boolean | number | string;

export function addDiscriminatorTitlesToJsonSchema(schema: unknown): unknown {
  return visitJsonSchemaValue(schema);
}

function visitJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => visitJsonSchemaValue(item));
  }

  if (!isRecord(value)) return value;

  const schema: JsonSchemaRecord = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, visitJsonSchemaValue(child)]),
  );

  for (const combiner of combiners) {
    const options = schema[combiner];
    if (Array.isArray(options)) {
      schema[combiner] = addDiscriminatorTitlesToCombinerOptions(options);
    }
  }

  return schema;
}

function addDiscriminatorTitlesToCombinerOptions(options: unknown[]) {
  const discriminator = findSharedDiscriminator(options);
  if (discriminator == null) return options;

  return options.map((option, index) => {
    if (!isRecord(option) || typeof option.title === "string") return option;

    return {
      ...option,
      title: String(discriminator.values[index]),
    };
  });
}

function findSharedDiscriminator(options: unknown[]) {
  const candidatesByOption = options.map(discriminatorCandidatesForOption);
  if (
    candidatesByOption.length === 0 ||
    candidatesByOption.some((candidates) => candidates.size === 0)
  ) {
    return null;
  }

  const [firstCandidates, ...remainingCandidates] = candidatesByOption;
  for (const key of firstCandidates.keys()) {
    const values = candidatesByOption.map((candidates) => candidates.get(key));
    if (values.some((value) => value == null)) continue;
    if (new Set(values).size !== values.length) continue;
    if (remainingCandidates.every((candidates) => candidates.has(key))) {
      return {
        key,
        values: values as DiscriminatorValue[],
      };
    }
  }

  return null;
}

function discriminatorCandidatesForOption(option: unknown) {
  const candidates = new Map<string, DiscriminatorValue>();
  if (!isRecord(option)) return candidates;

  const properties = option.properties;
  if (!isRecord(properties)) return candidates;

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (requiresProperty(option, key)) {
      const value = discriminatorValue(propertySchema);
      if (value != null) candidates.set(key, value);
    }
  }

  return candidates;
}

function requiresProperty(schema: JsonSchemaRecord, key: string) {
  const required = schema.required;
  return Array.isArray(required) && required.includes(key);
}

function discriminatorValue(schema: unknown): DiscriminatorValue | null {
  if (!isRecord(schema)) return null;

  const constValue = schema.const;
  if (isDiscriminatorValue(constValue)) return constValue;

  const enumValue = schema.enum;
  if (Array.isArray(enumValue) && enumValue.length === 1 && isDiscriminatorValue(enumValue[0])) {
    return enumValue[0];
  }

  return null;
}

function isDiscriminatorValue(value: unknown): value is DiscriminatorValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is JsonSchemaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
