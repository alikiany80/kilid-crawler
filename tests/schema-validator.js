/**
 * Tiny validator for the JSON-Schema subset used by contract/listing.v1.schema.json:
 * type (string or array of types), required, enum, const, properties, additionalProperties:false, items,
 * minimum/maximum, pattern, minLength/maxLength, plus format date-time/uri (lightweight checks).
 * Returns an array of error strings (empty = valid).
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function checkFormat(value, format) {
  if (format === 'date-time') return ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
  if (format === 'uri') {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  return true;
}

function validate(schema, value, at = '$') {
  const errors = [];
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(value, t))) {
      errors.push(`${at}: expected type ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.format && !checkFormat(value, schema.format)) errors.push(`${at}: invalid ${schema.format}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}: missing required '${key}'`);
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(props[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property '${key}'`);
    }
  }
  return errors;
}

module.exports = { validate };
