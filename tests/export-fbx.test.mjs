/**
 * P2-4 USDZ / binary FBX export — pure contracts and structure invariants.
 *
 * The FBX writer is dependency-free, so this suite exercises it directly with
 * duck-typed scene graphs and re-parses the produced bytes with a strict
 * reader that validates every declared end_offset/property_list_len the way
 * binary FBX parsers do. Interop (three.js FBXLoader) was verified separately
 * against the same writer: hierarchy, compound rotations, corner geometry,
 * UVs, normals and Phong colors round-trip exactly; the source guards below
 * pin the client wiring that runs that path in the sandboxed preview.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { FBXExporter, FBX_VERSION } from '../runtime/exporters/FBXExporter.js'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

// --- duck-typed scene helpers (mirror the shapes three.js provides) --------

const attribute = (array, itemSize) => ({
  array, itemSize,
  count: array.length / itemSize,
  getX: index => array[index * itemSize],
  getY: index => array[index * itemSize + 1],
  getZ: index => array[index * itemSize + 2],
})

const triangleGeometry = options => {
  const position = attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)
  const geometry = {
    attributes: { position },
    index: null,
    groups: options.groups === undefined ? [] : options.groups,
  }
  if (options.normals !== false) geometry.attributes.normal = attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
  if (options.uvs !== false) geometry.attributes.uv = attribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2)
  return geometry
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const rotate = (axis, degrees) => {
  const c = Math.cos(degrees * Math.PI / 180)
  const s = Math.sin(degrees * Math.PI / 180)
  if (axis === 'x') return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
  if (axis === 'y') return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}
const multiply = (a, b) => {
  const out = new Array(16).fill(0)
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[row + k * 4] * b[k + col * 4]
      out[row + col * 4] = sum
    }
  }
  return out
}
const local = elements => ({ elements })
const mesh = (name, matrix, geometry, material) => ({
  isMesh: true, name, visible: true, matrix, geometry, material,
})

const flatMaterial = (name, color) => ({
  uuid: `uuid-${name}`, name, color, roughness: 0.4, metalness: 0.2, opacity: 1,
})

// --- strict binary FBX reader ----------------------------------------------

function parseFBX(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const decode = (start, length) => {
    let end = start + length
    for (let i = start; i < end; i += 1) if (bytes[i] === 0) { end = i; break }
    let text = ''
    for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i])
    return text
  }
  const header = decode(0, 23)
  assert.equal(header, 'Kaydara FBX Binary  \x00\x1a\x00'.slice(0, 20), 'header magic text')
  assert.equal(view.getUint32(23, true), FBX_VERSION, 'declared FBX version')
  let offset = 27
  const readProperty = () => {
    const type = String.fromCharCode(bytes[offset]); offset += 1
    if (type === 'I') { const value = view.getInt32(offset, true); offset += 4; return value }
    if (type === 'D') { const value = view.getFloat64(offset, true); offset += 8; return value }
    if (type === 'C') { const value = bytes[offset] === 1; offset += 1; return value }
    if (type === 'L') { const value = view.getBigInt64(offset, true); offset += 8; return Number(value) }
    if (type === 'S' || type === 'R') {
      const length = view.getUint32(offset, true); offset += 4
      const value = decode(offset, length); offset += length
      return type === 'S' ? value : bytes.slice(offset - length, offset)
    }
    if (type === 'd' || type === 'i') {
      const length = view.getUint32(offset, true); offset += 4
      const encoding = view.getUint32(offset, true); offset += 4
      const stored = view.getUint32(offset, true); offset += 4
      assert.equal(encoding, 0, 'arrays are written uncompressed')
      const width = type === 'd' ? 8 : 4
      assert.equal(stored, length * width, 'declared stored length matches raw encoding')
      const out = []
      for (let i = 0; i < length; i += 1) {
        out.push(type === 'd' ? view.getFloat64(offset, true) : view.getInt32(offset, true))
        offset += width
      }
      return out
    }
    throw new Error(`test reader: unexpected property type ${type} at ${offset - 1}`)
  }
  const parseNode = () => {
    const start = offset
    const endOffset = view.getUint32(offset, true)
    const numProps = view.getUint32(offset + 4, true)
    const propsLen = view.getUint32(offset + 8, true)
    const nameLen = bytes[offset + 12]
    offset += 13
    const name = decode(offset, nameLen); offset += nameLen
    if (endOffset === 0 && numProps === 0 && propsLen === 0 && nameLen === 0) return null
    const propsStart = offset
    const props = []
    for (let i = 0; i < numProps; i += 1) props.push(readProperty())
    assert.equal(offset - propsStart, propsLen, `property_list_len for ${name}`)
    const children = []
    if (offset < endOffset) {
      for (;;) {
        const child = parseNode()
        if (child === null) break
        children.push(child)
      }
    }
    assert.equal(offset, endOffset, `end_offset for ${name} (start ${start})`)
    return { name, props, children }
  }
  const roots = []
  for (;;) {
    const node = parseNode()
    if (node === null) break
    roots.push(node)
  }
  // Footer: magic(16), alignment padding to 16, zero u32, version u32,
  // 120 zero bytes, magic(16) — 160 bytes plus 0-15 alignment bytes.
  const pad = (16 - ((offset + 16) % 16)) % 16
  assert.equal(view.getUint32(offset + 16 + pad + 4, true), FBX_VERSION, 'footer version')
  assert.equal(view.getUint32(offset + 16 + pad, true), 0, 'footer zero word')
  assert.equal(bytes.length - offset - 160, pad, 'footer is exactly 160 bytes plus alignment')
  const find = (list, name) => list.filter(node => node.name === name)
  const byPath = (nodes, path) => path.reduce((current, step) => {
    if (current === null) return null
    const source = Array.isArray(current) ? current : current.children
    return find(source, step)[0] || null
  }, nodes)
  return { roots, find, byPath }
}

const firstExport = root => {
  const result = new FBXExporter().parse(root, { timestamp: 0 })
  assert.ok(result.buffer instanceof ArrayBuffer)
  return result
}

// --- tests -------------------------------------------------------------------

test('P2-4 FBX header, footer and node framing are self-consistent', () => {
  const root = { children: [mesh('Solo', local(identity), triangleGeometry({}), flatMaterial('Red', { r: 1, g: 0, b: 0 }))] }
  const exported = firstExport(root)
  const parsed = parseFBX(exported.buffer)
  const names = parsed.roots.map(node => node.name)
  assert.deepEqual(names.sort(), ['Connections', 'Definitions', 'Documents', 'FBXHeaderExtension', 'GlobalSettings', 'Objects', 'References'])
  // Units stay metres: UnitScaleFactor = 100 and no vertex rescaling.
  const unit = parsed.byPath(parsed.roots, ['GlobalSettings', 'Properties70']).children
    .find(node => node.props[0] === 'UnitScaleFactor')
  assert.equal(unit.props[4], 100)
})

test('P2-4 indexed mesh exports vertices, polygon sentinels, normals and UVs', () => {
  const geometry = {
    attributes: {
      position: attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
      normal: attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
      uv: attribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2),
    },
    index: attribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1),
    groups: [],
  }
  const exported = firstExport({ children: [mesh('Tri', local(identity), geometry, flatMaterial('Red', { r: 1, g: 0, b: 0 }))] })
  const parsed = parseFBX(exported.buffer)
  const objects = parsed.byPath(parsed.roots, ['Objects'])
  const geometryNode = parsed.find(objects.children, 'Geometry')[0]
  // Readers (three.js FBXLoader included) truncate the name at the \x00\x01
  // class separator, so the parsed attrName is the bare object name.
  assert.equal(geometryNode.props[1], 'Tri')
  assert.equal(geometryNode.props[2], 'Mesh')
  const childByName = name => parsed.find(geometryNode.children, name)[0]
  assert.deepEqual(childByName('Vertices').props[0], [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])
  // The last vertex index of every polygon is stored as -(index + 1):
  // triangles [0,1,2] and [2,1,3] -> 0,1,-3,2,1,-4.
  assert.deepEqual(childByName('PolygonVertexIndex').props[0], [0, 1, -3, 2, 1, -4])
  const normals = parsed.find(childByName('LayerElementNormal').children, 'Normals')
  assert.equal(normals[0].props[0].length, 18, 'per-corner normals for 6 vertices')
  assert.equal(parsed.find(childByName('LayerElementUV').children, 'UV').length, 1)
  const mapping = parsed.find(childByName('LayerElementNormal').children, 'MappingInformationType')[0]
  assert.equal(mapping.props[0], 'ByPolygonVertex')
})

test('P2-4 hierarchy keeps local transforms; groups become Null models', () => {
  const rotation = multiply(multiply(rotate('x', 20), rotate('y', 30)), rotate('z', 40))
  const groupMatrix = multiply([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, -2, 1], rotation)
  const meshMatrix = multiply([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1, 2, 1], [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1])
  const material = flatMaterial('Blue', { r: 0.2, g: 0.6, b: 0.9 })
  const root = {
    children: [{
      name: 'Rig', visible: true, matrix: local(groupMatrix),
      children: [mesh('Box', local(meshMatrix), triangleGeometry({}), material)],
    }],
  }
  const exported = firstExport(root)
  const parsed = parseFBX(exported.buffer)
  const models = parsed.find(parsed.byPath(parsed.roots, ['Objects']).children, 'Model')
  assert.equal(models.length, 2)
  const nullModel = models.find(node => node.props[2] === 'Null')
  const meshModel = models.find(node => node.props[2] === 'Mesh')
  assert.equal(nullModel.props[1], 'Rig')
  assert.equal(meshModel.props[1], 'Box')
  const readLcl = (node, label) => {
    const properties = parsed.find(node.children, 'Properties70')[0]
    const entry = properties.children.find(child => child.props[0] === `Lcl ${label}`)
    return entry.props.slice(4)
  }
  // Recompose T * Rz(rz) * Ry(ry) * Rx(rx) * S from the exported channels and
  // compare against the source local matrix (the verified FBX convention).
  const recompose = node => {
    const [tx, ty, tz] = readLcl(node, 'Translation')
    const [rx, ry, rz] = readLcl(node, 'Rotation').map(degrees => degrees * Math.PI / 180)
    const [sx, sy, sz] = readLcl(node, 'Scaling')
    const rad2 = 'xyz'
    const r = multiply(multiply(rotate('z', rz * 180 / Math.PI), rotate('y', ry * 180 / Math.PI)), rotate('x', rx * 180 / Math.PI))
    void rad2
    return multiply([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1], multiply(r, [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]))
  }
  for (const [node, source] of [[nullModel, groupMatrix], [meshModel, meshMatrix]]) {
    const composed = recompose(node)
    for (let i = 0; i < 16; i += 1) {
      assert.ok(Math.abs(composed[i] - source[i]) < 1e-9, `channel ${i} of ${node.props[1]}: ${composed[i]} vs ${source[i]}`)
    }
  }
  // Connections: rig -> root(0), mesh -> rig, geometry -> mesh, material -> mesh.
  const connections = parsed.find(parsed.byPath(parsed.roots, ['Connections']).children, 'C')
    .map(node => ({ type: node.props[0], child: node.props[1], parent: node.props[2] }))
  const idOf = node => node.props[0]
  assert.ok(connections.some(row => row.type === 'OO' && row.child === idOf(nullModel) && row.parent === 0))
  assert.ok(connections.some(row => row.type === 'OO' && row.child === idOf(meshModel) && row.parent === idOf(nullModel)))
})

test('P2-4 material groups map to per-polygon material assignment', () => {
  // 8 triangles so two 12-index groups cover different triangles.
  const positions = []
  const indices = []
  for (let triangle = 0; triangle < 8; triangle += 1) {
    const base = triangle * 3
    positions.push(base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7, base + 8)
    indices.push(base, base + 1, base + 2)
  }
  const geometry = {
    attributes: { position: attribute(new Float32Array(positions), 3) },
    index: attribute(new Uint16Array(indices), 1),
    groups: [
      { start: 0, count: 12, materialIndex: 0 },
      { start: 12, count: 12, materialIndex: 1 },
    ],
  }
  const materials = [flatMaterial('A', { r: 1, g: 0, b: 0 }), flatMaterial('B', { r: 0, g: 1, b: 0 })]
  const exported = firstExport({ children: [mesh('Multi', local(identity), geometry, materials)] })
  const parsed = parseFBX(exported.buffer)
  const objects = parsed.byPath(parsed.roots, ['Objects']).children
  const geometryNode = parsed.find(objects, 'Geometry')[0]
  const layerMaterial = parsed.find(geometryNode.children, 'LayerElementMaterial')[0]
  assert.equal(parsed.find(layerMaterial.children, 'MappingInformationType')[0].props[0], 'ByPolygon')
  assert.deepEqual(parsed.find(layerMaterial.children, 'Materials')[0].props[0], [0, 0, 0, 0, 1, 1, 1, 1])
  assert.equal(parsed.find(objects, 'Material').length, 2)
})

test('P2-4 InstancedMesh expands to models sharing one geometry', () => {
  const instanced = {
    isMesh: true,
    isInstancedMesh: true,
    name: 'Forest',
    visible: true,
    matrix: local([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]),
    geometry: triangleGeometry({}),
    material: flatMaterial('Green', { r: 0, g: 1, b: 0 }),
    count: 3,
    instanceMatrix: {
      itemSize: 16,
      array: new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1,
        2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 2, 1, 0, 1,
      ]),
    },
  }
  const exported = firstExport({ children: [instanced] })
  const parsed = parseFBX(exported.buffer)
  const objects = parsed.byPath(parsed.roots, ['Objects']).children
  assert.equal(parsed.find(objects, 'Geometry').length, 1, 'geometry is shared')
  const models = parsed.find(objects, 'Model')
  assert.equal(models.length, 3)
  const connections = parsed.find(parsed.byPath(parsed.roots, ['Connections']).children, 'C')
    .map(node => ({ child: node.props[1], parent: node.props[2] }))
  const geometryId = parsed.find(objects, 'Geometry')[0].props[0]
  for (const model of models) {
    assert.ok(connections.some(row => row.child === geometryId && row.parent === model.props[0]),
      `${model.props[1]} reuses the shared geometry`)
  }
  // The third instance carries the object translation plus its own transform.
  const readLcl = (node, label) => {
    const properties = parsed.find(node.children, 'Properties70')[0]
    return properties.children.find(child => child.props[0] === `Lcl ${label}`).props.slice(4)
  }
  const third = models.find(node => node.props[1].startsWith('Forest_2'))
  const translation = readLcl(third, 'Translation')
  assert.deepEqual(translation, [12, 1, 0])
  assert.deepEqual(readLcl(third, 'Scaling'), [2, 2, 2])
})

test('P2-4 names are ASCII-sanitized per type and invisible subtrees are pruned', () => {
  const material = flatMaterial('M', { r: 1, g: 1, b: 1 })
  const geometry = triangleGeometry({})
  const root = {
    children: [
      mesh('立方体 Cube', local(identity), geometry, material),
      mesh('立方体 Cube', local(identity), triangleGeometry({ uvs: false }), material),
      { name: 'Hidden', visible: false, matrix: local(identity), children: [mesh('Inside', local(identity), geometry, material)] },
      { name: 'Empty', visible: true, matrix: local(identity), children: [] },
    ],
  }
  const exported = firstExport(root)
  const parsed = parseFBX(exported.buffer)
  const objects = parsed.byPath(parsed.roots, ['Objects']).children
  const models = parsed.find(objects, 'Model')
  const modelNames = models.map(node => node.props[1].split('\x00')[0]).sort()
  // '立方体 Cube' -> three underscores for the CJK characters, space kept.
  assert.deepEqual(modelNames, ['___ Cube', '___ Cube_1'])
  assert.equal(parsed.find(objects, 'Geometry').length, 2, 'two distinct geometries')
  assert.equal(parsed.find(objects, 'Material').length, 1, 'material deduped by uuid')
})

test('P2-4 missing normals fall back to face normals; colors are sRGB', () => {
  const geometry = {
    attributes: { position: attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3) },
    index: null,
    groups: [],
  }
  const material = {
    uuid: 'u', name: 'Phong',
    color: { r: 0.2, g: 0.6, b: 0.9 },
    emissive: { r: 0, g: 0, b: 0 },
    roughness: 0.35, metalness: 0.1, opacity: 0.5,
  }
  const exported = firstExport({ children: [mesh('N', local(identity), geometry, material)] })
  const parsed = parseFBX(exported.buffer)
  const objects = parsed.byPath(parsed.roots, ['Objects']).children
  const geometryNode = parsed.find(objects, 'Geometry')[0]
  const normals = parsed.find(parsed.find(geometryNode.children, 'LayerElementNormal')[0].children, 'Normals')[0].props[0]
  // Flat +Z triangle: all three corners share the face normal.
  const face = normals.slice(0, 3)
  assert.deepEqual(normals, [...face, ...face, ...face])
  assert.ok(Math.abs(Math.hypot(...face) - 1) < 1e-9, 'face normals are normalized')
  const materialNode = parsed.find(objects, 'Material')[0]
  const properties = parsed.find(materialNode.children, 'Properties70')[0]
  const diffuse = properties.children.find(child => child.props[0] === 'DiffuseColor').props.slice(4)
  // three.js stores material colors in linear space; FBX expects sRGB. The
  // inverse mapping was verified end-to-end through FBXLoader (which converts
  // these values back to linear and recovered exactly 0.2/0.6/0.9).
  const toSRGB = x => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
  assert.ok(Math.abs(diffuse[0] - toSRGB(0.2)) < 1e-12)
  assert.ok(Math.abs(diffuse[1] - toSRGB(0.6)) < 1e-12)
  assert.ok(Math.abs(diffuse[2] - toSRGB(0.9)) < 1e-12)
  const transparency = properties.children.find(child => child.props[0] === 'TransparencyFactor').props[4]
  assert.ok(Math.abs(transparency - 0.5) < 1e-12)
  assert.equal(parsed.find(materialNode.children, 'ShadingModel')[0].props[0], 'phong')
})

test('P2-4 client wiring runs both exporters through the sandbox preview', () => {
  assert.match(clientSource, /command === 'export-usdz'/)
  assert.match(clientSource, /command === 'export-fbx'/)
  assert.match(clientSource, /import\('three\/addons\/exporters\/USDZExporter\.js'\)/)
  assert.match(clientSource, /import\('three\/addons\/exporters\/FBXExporter\.js'\)/)
  assert.match(clientSource, /type: 'three-workbench:usdz', buffer/)
  assert.match(clientSource, /type: 'three-workbench:fbx', buffer/)
  assert.match(clientSource, /model\/vnd\.usdz\+zip/)
  assert.match(clientSource, /commandAfterAssets\('export-usdz'\)/)
  assert.match(clientSource, /commandAfterAssets\('export-fbx'\)/)
})

test('P2-4 i18n labels exist once per locale and vendor files are pinned', async () => {
  for (const key of ['action.exportUsdz', 'action.exportFbx']) {
    assert.equal((clientSource.match(new RegExp(`'${key}':`,'g')) || []).length, 2, `${key} zh+en`)
  }
  assert.match(clientSource, /'action.exportUsdz': '导出 USDZ/)
  assert.match(clientSource, /'action.exportFbx': 'Export FBX/)
  const usdz = await readFile(new URL('../runtime/exporters/USDZExporter.js', import.meta.url), 'utf8')
  assert.match(usdz, /from '\.\.\/vendor\/fflate\.module\.js'/, 'USDZExporter uses the vendored fflate')
  const fflate = await readFile(new URL('../runtime/vendor/fflate.module.js', import.meta.url), 'utf8')
  assert.match(fflate, /Licensed under MIT/, 'fflate license header retained')
})
