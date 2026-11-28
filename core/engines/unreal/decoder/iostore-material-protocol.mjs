export const ioStoreMaterialRevision = 1

const name = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/u.test(value)
const object = value => name(value) && !/[/\\.:]/u.test(value)
const packagePath = value => typeof value === 'string' && value.length <= 768 &&
  value.startsWith('/') && value.slice(1).split('/').every(object)
const hash = value => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) && value !== '0000000000000000'
const soft = value => packagePath(value?.package) && object(value.object)
const reference = value => packagePath(value?.package) && hash(value.hash)
const integer = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
const nullable = (value, valid) => value === null || valid(value)
const list = (value, valid, limit = 256) => Array.isArray(value) && value.length <= limit && value.every(valid)

export const validZenIdentity = value => soft(value) && hash(value.hash)

export function validZenSlots(value) {
  return list(value, row => integer(row?.slot) && row.slot >= 0 && row.slot < 128 && reference(row.reference), 128) &&
    new Set(value.map(row => row.slot)).size === value.length
}

function parameter(row) {
  return name(row?.name) && nullable(row.association, name) && nullable(row.index, integer)
}

function texture(row) {
  return parameter(row) && row.value === null &&
    (row.status === 'reference' ? reference(row.reference) :
      [null, 'empty', 'unsupported-reference'].includes(row.status) && row.reference === null)
}

function numeric(row, valid) {
  return parameter(row) && nullable(row.value, valid) && row.reference === null && row.status === null
}

function vector(value) {
  return list(value, Number.isFinite, 4) && value.length === 4
}

export function validZenMaterial(value) {
  return (value?.type === 'MaterialInstanceConstant' && nullable(value.parent, reference) ||
    value?.type === 'Material' && value.parent === null) &&
    list(value.textures, texture) && list(value.scalars, row => numeric(row, Number.isFinite)) &&
    list(value.vectors, row => numeric(row, vector)) && list(value.streaming, row =>
      nullable(row?.reference, soft) && nullable(row.textureName, name) && nullable(row.uvChannel, integer) &&
      nullable(row.samplingScale, Number.isFinite))
}
