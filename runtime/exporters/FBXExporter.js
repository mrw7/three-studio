/**
 * Minimal binary FBX 7.4 (version 7400) writer for static scenes.
 *
 * Implemented from the public binary FBX format: 23-byte header, nested node
 * records with 32-bit offsets, typed property lists, and the 13-byte null
 * sentinel that terminates every nested list. Verified by round-tripping the
 * output through three.js FBXLoader in tests/export-fbx.test.mjs.
 *
 * Scope and deliberate limits (documented in README):
 * - Mesh geometry with normals and one UV set, as triangles.
 * - Node hierarchy with local translation/rotation/scale (quaternion-free
 *   Shepperd decomposition of each object's local matrix); groups become
 *   FBX Null models so parenting survives.
 * - InstancedMesh instances are expanded into sibling models that share one
 *   geometry (object local matrix × instance matrix).
 * - Materials are converted to FBX Phong (diffuse/specular/emissive/shininess/
 *   transparency); PBR channels, textures and vertex colors are not carried
 *   over. Geometry material groups map to per-polygon material assignment.
 * - No animation, skinning, lights or cameras.
 * - Units are authored in metres with GlobalSettings UnitScaleFactor=100,
 *   matching Blender's metre-unit FBX output; coordinates are not rescaled.
 * - Object names are transliterated to printable ASCII.
 *
 * Dependency-free by design so Node tests can import it directly. It only
 * reads duck-typed three.js scene-graph objects (matrix/matrixWorld,
 * geometry attributes, material.color...).
 */

const FBX_VERSION = 7400
const HEADER_MAGIC = 'Kaydara FBX Binary  \x00\x1a\x00'
// Footer magic used by FBX writers twice around the version block.
const FOOTER_MAGIC = [
  0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66,
  0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e,
]
const HEADER_VERSION = 1003
const GEOMETRY_VERSION = 124
const MODEL_VERSION = 232
const MATERIAL_VERSION = 102
const METRES_PER_FBX_UNIT = 100 // UnitScaleFactor: 1 unit = 100 cm = 1 m

class ByteWriter {
  constructor() {
    this.chunks = []
    this.length = 0
  }

  push(bytes) {
    this.chunks.push(bytes)
    this.length += bytes.length
    return this
  }

  u8(value) { return this.push(new Uint8Array([value & 0xff])) }

  u32(value) {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, value >>> 0, true)
    return this.push(out)
  }

  f64(value) {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setFloat64(0, value, true)
    return this.push(out)
  }

  i64(value) {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigInt64(0, BigInt(Math.trunc(value)), true)
    return this.push(out)
  }

  ascii(text) {
    const out = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
    return this.push(out)
  }

  buffer() {
    const out = new Uint8Array(this.length)
    let cursor = 0
    for (const chunk of this.chunks) {
      out.set(chunk, cursor)
      cursor += chunk.length
    }
    return out
  }
}

// --- node tree -------------------------------------------------------------

const node = (name, props = [], children = null) => ({ name, props, children })
const pI = value => ({ type: 'I', value: value | 0 })
const pD = value => ({ type: 'D', value: +value })
const pS = value => ({ type: 'S', value: String(value) })
const pC = value => ({ type: 'C', value: value ? 1 : 0 })
const pL = value => ({ type: 'L', value: Math.trunc(value) })
const pDArray = values => ({ type: 'd', value: Float64Array.from(values) })
const pIArray = values => ({ type: 'i', value: Int32Array.from(values) })

const PROPERTY_SIZE = { I: 5, F: 5, D: 9, L: 9, C: 2 }

function propsByteLength(props) {
  let size = 0
  for (const prop of props) {
    if (prop.type === 'S' || prop.type === 'R') size += 5 + prop.value.length
    else if (prop.type === 'd') size += 13 + prop.value.length * 8
    else if (prop.type === 'i') size += 13 + prop.value.length * 4
    else if (PROPERTY_SIZE[prop.type] !== undefined) size += PROPERTY_SIZE[prop.type]
    else throw new Error(`FBXExporter: unknown property type ${String(prop.type)}`)
  }
  return size
}

function writeProperty(writer, prop) {
  switch (prop.type) {
    case 'I': writer.u8(0x49).u32(prop.value); return
    case 'D': writer.u8(0x44).f64(prop.value); return
    case 'C': writer.u8(0x43).u8(prop.value); return
    case 'L': writer.u8(0x4c).i64(prop.value); return
    case 'S':
    case 'R':
      writer.u8(prop.type === 'S' ? 0x53 : 0x52).u32(prop.value.length).ascii(prop.value)
      return
    case 'd':
      writer.u8(0x64).u32(prop.value.length).u32(0 /* encoding: raw */).u32(prop.value.length * 8)
      for (const value of prop.value) writer.f64(value)
      return
    case 'i':
      writer.u8(0x69).u32(prop.value.length).u32(0).u32(prop.value.length * 4)
      for (const value of prop.value) writer.u32(value)
      return
    default:
      throw new Error(`FBXExporter: unhandled property type ${String(prop.type)}`)
  }
}

function nodeByteLength(entry) {
  let size = 13 + entry.name.length + propsByteLength(entry.props)
  if (entry.children !== null) {
    for (const child of entry.children) size += nodeByteLength(child)
    size += 13 // null sentinel terminating the nested list
  }
  return size
}

function writeNode(writer, entry, startOffset) {
  const propsLength = propsByteLength(entry.props)
  writer.u32(startOffset + nodeByteLength(entry))
  writer.u32(entry.props.length).u32(propsLength)
  writer.u8(entry.name.length).ascii(entry.name)
  for (const prop of entry.props) writeProperty(writer, prop)
  if (entry.children !== null) {
    let cursor = startOffset + 13 + entry.name.length + propsLength
    for (const child of entry.children) {
      writeNode(writer, child, cursor)
      cursor += nodeByteLength(child)
    }
    writer.u32(0).u32(0).u32(0).u8(0) // null record terminating the list
  }
}

// --- helpers ---------------------------------------------------------------

function sanitizeName(raw, fallback, usedByType) {
  // Printable ASCII only: control characters, the name/class separators and
  // every non-ASCII code point are transliterated away. Uniqueness is scoped
  // per FBX object type, so a mesh and its geometry may share a name.
  let name = typeof raw === 'string' ? raw.replace(/[^\x20-\x7e]/g, '_') : ''
  name = name.replace(/[\x00\x01]/g, '')
  if (name.length === 0) name = fallback
  let unique = name
  let counter = 1
  while (usedByType.has(unique)) unique = `${name}_${counter++}`
  usedByType.add(unique)
  return unique
}

const fbxObjectName = (name, className) => `${name}\x00\x01${className}`

function decomposeTRS(elements) {
  // Column-major 4x4 (three.js layout) -> T, Euler XYZ (degrees), S.
  const sx = Math.hypot(elements[0], elements[1], elements[2]) || 1e-9
  const sy = Math.hypot(elements[4], elements[5], elements[6]) || 1e-9
  const sz = Math.hypot(elements[8], elements[9], elements[10]) || 1e-9
  const det = elements[0] * (elements[5] * elements[10] - elements[6] * elements[9])
    - elements[1] * (elements[4] * elements[10] - elements[6] * elements[8])
    + elements[2] * (elements[4] * elements[9] - elements[5] * elements[8])
  const sign = det < 0 ? -1 : 1
  const scaleX = sign * sx
  // Rows of the rotation matrix with scale removed.
  const r00 = elements[0] / scaleX, r01 = elements[4] / sy, r02 = elements[8] / sz
  const r10 = elements[1] / scaleX, r11 = elements[5] / sy, r12 = elements[9] / sz
  const r20 = elements[2] / scaleX, r21 = elements[6] / sy, r22 = elements[10] / sz
  // Shepperd's method for XYZ Euler angles (the FBX default rotation order).
  const sinY = Math.max(-1, Math.min(1, -r20))
  const cosY = Math.sqrt(Math.max(0, 1 - sinY * sinY))
  let rx = 0
  let ry = 0
  let rz = 0
  if (cosY > 1e-6) {
    rx = Math.atan2(r21, r22)
    ry = Math.asin(sinY)
    rz = Math.atan2(r10, r00)
  } else {
    rx = Math.atan2(-r12, r11)
    ry = sinY > 0 ? Math.PI / 2 : -Math.PI / 2
    rz = 0
  }
  const rad2deg = 180 / Math.PI
  return {
    translation: [elements[12], elements[13], elements[14]],
    rotation: [rx * rad2deg, ry * rad2deg, rz * rad2deg],
    scale: [sign * sx, sy, sz],
  }
}

const lclP = (suffix, values) => node('P', [
  pS(`Lcl ${suffix}`), pS(`Lcl ${suffix}`), pS(''), pS('A'),
  pD(values[0]), pD(values[1]), pD(values[2]),
])

function colorTriple(color, fallback) {
  if (color === null || color === undefined || typeof color.r !== 'number') return fallback
  // three.js material colors live in the linear working space while FBX
  // stores gamma-space (sRGB) values; convert before writing.
  return [toSRGB(color.r), toSRGB(color.g), toSRGB(color.b)]
}

function toSRGB(value) {
  const x = Math.min(1, Math.max(0, value))
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

function phongMaterialProperties(material) {
  const source = material === null || material === undefined ? {} : material
  const diffuse = colorTriple(source.color, [0.8, 0.8, 0.8])
  const emissive = colorTriple(source.emissive, [0, 0, 0])
  const emissiveIntensity = typeof source.emissiveIntensity === 'number' ? Math.max(0, source.emissiveIntensity) : 1
  const roughness = typeof source.roughness === 'number' ? source.roughness : 0.5
  const metalness = typeof source.metalness === 'number' ? source.metalness : 0
  // Heuristic Phong mapping: smooth dielectrics are glossy, metals are
  // specular-dominant. Roughness 1 -> dull (shininess ~2), 0 -> mirror (~200).
  const shininess = Math.max(1, Math.min(250, 2 + (1 - roughness) * 198))
  const specularStrength = toSRGB(0.2 + metalness * 0.6)
  const opacity = typeof source.opacity === 'number' ? source.opacity : 1
  return [
    node('P', [pS('ShadingModel'), pS('KString'), pS(''), pS(''), pS('phong')]),
    node('P', [pS('EmissiveColor'), pS('Color'), pS(''), pS('A'),
      pD(emissive[0] * emissiveIntensity), pD(emissive[1] * emissiveIntensity), pD(emissive[2] * emissiveIntensity)]),
    node('P', [pS('EmissiveFactor'), pS('Number'), pS(''), pS('A'), pD(1)]),
    node('P', [pS('DiffuseColor'), pS('Color'), pS(''), pS('A'), pD(diffuse[0]), pD(diffuse[1]), pD(diffuse[2])]),
    node('P', [pS('DiffuseFactor'), pS('Number'), pS(''), pS('A'), pD(1)]),
    node('P', [pS('SpecularColor'), pS('Color'), pS(''), pS('A'),
      pD(specularStrength), pD(specularStrength), pD(specularStrength)]),
    node('P', [pS('SpecularFactor'), pS('Number'), pS(''), pS('A'), pD((1 - roughness) * 0.5 + metalness * 0.3)]),
    node('P', [pS('Shininess'), pS('Number'), pS(''), pS('A'), pD(shininess)]),
    node('P', [pS('ReflectionFactor'), pS('Number'), pS(''), pS('A'), pD(0.1)]),
    node('P', [pS('TransparencyFactor'), pS('Number'), pS(''), pS('A'), pD(Math.max(0, Math.min(1, 1 - opacity)))]),
  ]
}

function composeMatrices(a, b) {
  // Column-major a × b.
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

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const localMatrix = object => (object.matrix !== null && object.matrix !== undefined
  ? object.matrix.elements : IDENTITY)

// --- geometry collection ---------------------------------------------------

function collectTriangles(geometry) {
  const position = geometry.attributes.position
  if (position === null || position === undefined) return null
  const index = geometry.index
  const triangles = []
  if (index !== null && index !== undefined) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      triangles.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)])
    }
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) triangles.push([i, i + 1, i + 2])
  }
  return triangles.length === 0 ? null : triangles
}

function cornerData(geometry, triangles, attributeName, itemSize) {
  const attribute = geometry.attributes[attributeName]
  if (attribute === null || attribute === undefined) return null
  const out = []
  for (const triangle of triangles) {
    for (const corner of triangle) {
      out.push(attribute.getX(corner))
      if (itemSize > 1) out.push(attribute.getY(corner))
      if (itemSize > 2) out.push(attribute.getZ(corner))
    }
  }
  return out
}

function computeFaceNormals(geometry, triangles) {
  const position = geometry.attributes.position
  const out = []
  for (const [a, b, c] of triangles) {
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a)
    const ux = position.getX(b) - ax, uy = position.getY(b) - ay, uz = position.getZ(b) - az
    const vx = position.getX(c) - ax, vy = position.getY(c) - ay, vz = position.getZ(c) - az
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz) || 1
    nx /= length; ny /= length; nz /= length
    out.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
  }
  return out
}

// --- exporter --------------------------------------------------------------

class FBXExporter {
  /**
   * @param {object} root scene-graph root; each object needs an up-to-date
   *   local `matrix` (three.js keeps it fresh when matrixAutoUpdate is on).
   * @param {{creator?: string}} [options]
   * @returns {{buffer: ArrayBuffer, meshes: number, materials: number}}
   */
  parse(root, options = {}) {
    const usedNames = new Map()
    const namesOfType = type => {
      if (!usedNames.has(type)) usedNames.set(type, new Set())
      return usedNames.get(type)
    }
    /** @type {Array<[string, number, number]>} */
    const connections = []
    const objectNodes = []
    let nextId = 1000000
    const takeId = () => { nextId += 1; return nextId }
    const materialIds = new Map()
    const stats = { meshes: 0, materials: 0 }

    const emitMaterial = material => {
      const key = material !== null && material !== undefined ? material.uuid || 'default' : 'default'
      if (materialIds.has(key)) return materialIds.get(key)
      const id = takeId()
      materialIds.set(key, id)
      stats.materials += 1
      const name = sanitizeName(
        material !== null && material !== undefined ? material.name : '', 'Material', namesOfType('Material'))
      objectNodes.push(node('Material', [pL(id), pS(fbxObjectName(name, 'Material')), pS('')], [
        node('Version', [pI(MATERIAL_VERSION)]),
        node('ShadingModel', [pS('phong')]),
        node('MultiLayer', [pI(0)]),
        node('Properties70', [], phongMaterialProperties(material)),
      ]))
      return id
    }

    const emitMeshModel = (id, name, transformElements) => {
      const trs = decomposeTRS(transformElements)
      objectNodes.push(node('Model', [pL(id), pS(fbxObjectName(name, 'Model')), pS('Mesh')], [
        node('Version', [pI(MODEL_VERSION)]),
        node('Properties70', [], [
          lclP('Translation', trs.translation),
          lclP('Rotation', trs.rotation),
          lclP('Scaling', trs.scale),
          node('P', [pS('DefaultAttributeIndex'), pS('int'), pS('Integer'), pS(''), pI(0)]),
          node('P', [pS('InheritType'), pS('enum'), pS(''), pS(''), pI(1)]),
        ]),
        node('Shading', [pC(true)]),
        node('Culling', [pS('CullingOff')]),
      ]))
    }

    const emitMesh = (object, parentId) => {
      const geometry = object.geometry
      if (geometry === null || geometry === undefined) return
      const triangles = collectTriangles(geometry)
      if (triangles === null) return
      const position = geometry.attributes.position
      const vertices = []
      for (let i = 0; i < position.count; i += 1) {
        vertices.push(position.getX(i), position.getY(i), position.getZ(i))
      }
      const cornerIndices = []
      for (const triangle of triangles) {
        cornerIndices.push(triangle[0], triangle[1], -(triangle[2] + 1))
      }
      let normals = cornerData(geometry, triangles, 'normal', 3)
      if (normals === null) normals = computeFaceNormals(geometry, triangles)
      const uvs = cornerData(geometry, triangles, 'uv', 2)

      const geometryId = takeId()
      const geometryName = sanitizeName(object.name, 'Geometry', namesOfType('Geometry'))
      const geometryChildren = [
        node('Properties70', []),
        node('Vertices', [pDArray(vertices)]),
        node('PolygonVertexIndex', [pIArray(cornerIndices)]),
        node('GeometryVersion', [pI(GEOMETRY_VERSION)]),
        node('LayerElementNormal', [pI(0)], [
          node('Version', [pI(101)]),
          node('Name', [pS('')]),
          node('MappingInformationType', [pS('ByPolygonVertex')]),
          node('ReferenceInformationType', [pS('Direct')]),
          node('Normals', [pDArray(normals)]),
        ]),
      ]
      if (uvs !== null) {
        geometryChildren.push(node('LayerElementUV', [pI(0)], [
          node('Version', [pI(101)]),
          node('Name', [pS('UVMap')]),
          node('MappingInformationType', [pS('ByPolygonVertex')]),
          node('ReferenceInformationType', [pS('Direct')]),
          node('UV', [pDArray(uvs)]),
        ]))
      }

      // Material groups map to per-polygon assignment; otherwise one material.
      const groups = Array.isArray(geometry.groups) ? geometry.groups : []
      const isMultiMaterial = groups.length > 0 && Array.isArray(object.material)
        && object.material.length > 1
      const materialList = []
      let materialAssignments = null
      if (isMultiMaterial) {
        materialAssignments = []
        for (const material of object.material) {
          materialList.push(emitMaterial(material === undefined ? null : material))
        }
        let cornerCursor = 0
        for (const triangle of triangles) {
          let assignment = 0
          for (const group of groups) {
            if (group.start <= cornerCursor && cornerCursor + 3 <= group.start + group.count) {
              assignment = group.materialIndex === undefined ? 0 : group.materialIndex
              break
            }
          }
          materialAssignments.push(assignment)
          cornerCursor += 3
        }
      } else {
        materialList.push(emitMaterial(Array.isArray(object.material) ? object.material[0] : object.material))
      }
      geometryChildren.push(node('LayerElementMaterial', [pI(0)], [
        node('Version', [pI(101)]),
        node('Name', [pS('')]),
        node('MappingInformationType', [pS(materialAssignments === null ? 'AllSame' : 'ByPolygon')]),
        node('ReferenceInformationType', [pS('IndexToDirect')]),
        node('Materials', [pIArray(materialAssignments === null ? [0] : materialAssignments)]),
      ]))
      const layerElements = [node('LayerElement', [pS('LayerElementNormal'), pI(0)])]
      if (uvs !== null) layerElements.push(node('LayerElement', [pS('LayerElementUV'), pI(0)]))
      layerElements.push(node('LayerElement', [pS('LayerElementMaterial'), pI(0)]))
      geometryChildren.push(node('Layer', [pI(0)], [
        node('Version', [pI(100)]),
        ...layerElements,
      ]))
      objectNodes.push(node('Geometry', [pL(geometryId), pS(fbxObjectName(geometryName, 'Geometry')), pS('Mesh')], geometryChildren))

      const isInstanced = object.isInstancedMesh === true
        && typeof object.count === 'number' && object.count > 0
        && object.instanceMatrix !== null && object.instanceMatrix !== undefined
      if (isInstanced) {
        // One Model per instance, all connected to the shared geometry; the
        // instance transform is object-local × instance-local.
        for (let i = 0; i < object.count; i += 1) {
          const elements = composeMatrices(localMatrix(object), instanceElementsAt(object, i))
          const modelId = takeId()
          emitMeshModel(modelId, sanitizeName(`${object.name || 'Instance'}_${i}`, 'Instance', namesOfType('Model')), elements)
          connections.push(['OO', modelId, parentId])
          connections.push(['OO', geometryId, modelId])
          for (const materialId of materialList) connections.push(['OO', materialId, modelId])
        }
      } else {
        const modelId = takeId()
        emitMeshModel(modelId, sanitizeName(object.name, 'Mesh', namesOfType('Model')), localMatrix(object))
        connections.push(['OO', modelId, parentId])
        connections.push(['OO', geometryId, modelId])
        for (const materialId of materialList) connections.push(['OO', materialId, modelId])
      }
      stats.meshes += 1
    }

    const instanceElementsAt = (object, index) => {
      const source = object.instanceMatrix.array
      const stride = object.instanceMatrix.itemSize || 16
      return Array.from(source.slice(index * stride, (index + 1) * stride))
    }

    const emitNullModel = (object, parentId) => {
      const id = takeId()
      const name = sanitizeName(object.name, 'Null', namesOfType('Model'))
      const trs = decomposeTRS(localMatrix(object))
      objectNodes.push(node('Model', [pL(id), pS(fbxObjectName(name, 'Model')), pS('Null')], [
        node('Version', [pI(MODEL_VERSION)]),
        node('Properties70', [], [
          lclP('Translation', trs.translation),
          lclP('Rotation', trs.rotation),
          lclP('Scaling', trs.scale),
          node('P', [pS('InheritType'), pS('enum'), pS(''), pS(''), pI(1)]),
        ]),
      ]))
      connections.push(['OO', id, parentId])
      return id
    }

    const hasMeshDescendant = object => {
      for (const child of object.children) {
        if (child.isMesh === true) return true
        if (hasMeshDescendant(child)) return true
      }
      return false
    }

    const walk = (object, parentId) => {
      if (object === null || object === undefined) return
      if (object.visible === false) return
      if (object.isMesh === true) {
        emitMesh(object, parentId)
        return
      }
      if (!hasMeshDescendant(object)) return
      const id = emitNullModel(object, parentId)
      for (const child of object.children) walk(child, id)
    }
    for (const child of root.children) walk(child, 0)

    const now = options.timestamp === undefined ? new Date() : new Date(options.timestamp)
    const creation = node('CreationTimeStamp', [], [
      node('Version', [pI(1000)]),
      node('Year', [pI(now.getUTCFullYear())]),
      node('Month', [pI(now.getUTCMonth() + 1)]),
      node('Day', [pI(now.getUTCDate())]),
      node('Hour', [pI(now.getUTCHours())]),
      node('Minute', [pI(now.getUTCMinutes())]),
      node('Second', [pI(now.getUTCSeconds())]),
      node('Millisecond', [pI(0)]),
    ])

    const countNodes = name => objectNodes.reduce((total, entry) =>
      total + (entry.name === name ? 1 : 0), 0)
    const tree = [
      node('FBXHeaderExtension', [], [
        node('FBXHeaderVersion', [pI(HEADER_VERSION)]),
        node('FBXVersion', [pI(FBX_VERSION)]),
        node('EncryptionType', [pI(0)]),
        creation,
        node('Creator', [pS(options.creator === undefined ? 'Three Studio FBXExporter' : String(options.creator))]),
      ]),
      node('GlobalSettings', [], [
        node('Version', [pI(1000)]),
        node('Properties70', [], [
          node('P', [pS('UpAxis'), pS('int'), pS('Integer'), pS(''), pI(1)]),
          node('P', [pS('UpAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
          node('P', [pS('FrontAxis'), pS('int'), pS('Integer'), pS(''), pI(2)]),
          node('P', [pS('FrontAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
          node('P', [pS('CoordAxis'), pS('int'), pS('Integer'), pS(''), pI(0)]),
          node('P', [pS('CoordAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
          node('P', [pS('OriginalUpAxis'), pS('int'), pS('Integer'), pS(''), pI(1)]),
          node('P', [pS('OriginalUpAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
          node('P', [pS('UnitScaleFactor'), pS('double'), pS('Number'), pS(''), pD(METRES_PER_FBX_UNIT)]),
          node('P', [pS('OriginalUnitScaleFactor'), pS('double'), pS('Number'), pS(''), pD(METRES_PER_FBX_UNIT)]),
          node('P', [pS('AmbientColor'), pS('ColorRGB'), pS('Color'), pS('A'), pD(0), pD(0), pD(0)]),
          node('P', [pS('DefaultCamera'), pS('KString'), pS(''), pS(''), pS('Producer Perspective')]),
          node('P', [pS('TimeMode'), pS('enum'), pS(''), pS(''), pI(6)]),
          node('P', [pS('TimeSpanStart'), pS('KTime'), pS('Time'), pS(''), pL(0)]),
          node('P', [pS('TimeSpanStop'), pS('KTime'), pS('Time'), pS(''), pL(46186158000)]),
          node('P', [pS('CustomFrameRate'), pS('double'), pS('Number'), pS(''), pD(-1)]),
        ]),
      ]),
      node('Documents', [], [
        node('Count', [pI(1)]),
        node('Document', [pL(1234567890), pS('Scene'), pS('Scene')], [
          node('Properties70', [], [
            node('P', [pS('SourceObject'), pS('object'), pS(''), pS('')]),
            node('P', [pS('ActiveAnimStackName'), pS('KString'), pS(''), pS(''), pS('')]),
          ]),
          node('RootNode', [pI(0)]),
        ]),
      ]),
      node('References', []),
      node('Definitions', [], [
        node('Version', [pI(100)]),
        node('Count', [pI(objectNodes.length + 1)]),
        node('ObjectType', [pS('GlobalSettings')], [node('Count', [pI(1)])]),
        node('ObjectType', [pS('Model')], [
          node('Count', [pI(countNodes('Model'))]),
          node('PropertyTemplate', [pS('FbxNode')], [node('Properties70', [])]),
        ]),
        node('ObjectType', [pS('Geometry')], [
          node('Count', [pI(countNodes('Geometry'))]),
          node('PropertyTemplate', [pS('FbxMesh')], [node('Properties70', [])]),
        ]),
        node('ObjectType', [pS('Material')], [
          node('Count', [pI(countNodes('Material'))]),
          node('PropertyTemplate', [pS('FbxSurfacePhong')], [node('Properties70', [])]),
        ]),
      ]),
      node('Objects', [], objectNodes),
      node('Connections', [], connections.map(([type, child, parent]) =>
        node('C', [pS(type), pL(child), pL(parent)]))),
    ]

    const writer = new ByteWriter()
    writer.ascii(HEADER_MAGIC)
    writer.u32(FBX_VERSION)
    let cursor = writer.length
    for (const entry of tree) {
      writeNode(writer, entry, cursor)
      cursor += nodeByteLength(entry)
    }
    writer.u32(0).u32(0).u32(0).u8(0) // top-level null record

    // Footer (160 bytes + alignment): magic, padding to 16-byte alignment,
    // one zero uint32, the version, 120 zero bytes, then the magic again.
    // This exact size is what parsers (three.js FBXLoader among them) use to
    // detect the end of the node stream.
    writer.push(Uint8Array.from(FOOTER_MAGIC))
    while (writer.length % 16 !== 0) writer.u8(0)
    writer.u32(0)
    writer.u32(FBX_VERSION)
    writer.push(new Uint8Array(120))
    writer.push(Uint8Array.from(FOOTER_MAGIC))

    const bytes = writer.buffer()
    return {
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      meshes: stats.meshes,
      materials: stats.materials,
    }
  }
}

export { FBXExporter, FBX_VERSION }
