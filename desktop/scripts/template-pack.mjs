/**
 * Pure validation for template-pack manifests.
 *
 * Used by the build assembler and the pre-release gate. Kept separate from the
 * filesystem code so the rules can be unit tested without touching the private
 * Pro pack.
 */

export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const TEMPLATE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
export const TEMPLATE_TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const isPlainObject = value => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

/**
 * @param {unknown} manifest
 * @returns {string[]} human-readable validation errors; empty when valid.
 */
export function validateManifest(manifest) {
  if (!isPlainObject(manifest)) return ['manifest must be a JSON object']

  const errors = []
  if (manifest.v !== 1) errors.push('v must be 1')
  if (typeof manifest.pack !== 'string' || manifest.pack.trim() === ''
    || manifest.pack.length > 120) {
    errors.push('pack must be a non-empty string of at most 120 characters')
  }
  if (!Array.isArray(manifest.templates)) {
    errors.push('templates must be an array')
    return errors
  }
  if (manifest.templates.length > 64) errors.push('templates must contain at most 64 entries')

  const ids = new Set()
  const files = new Set()
  manifest.templates.forEach((template, index) => {
    const at = `templates[${index}]`
    if (!isPlainObject(template)) {
      errors.push(`${at} must be an object`)
      return
    }
    if (typeof template.id !== 'string' || !TEMPLATE_ID_RE.test(template.id)) {
      errors.push(`${at}.id must match ${TEMPLATE_ID_RE}`)
    } else if (ids.has(template.id)) {
      errors.push(`${at}.id duplicates "${template.id}"`)
    } else {
      ids.add(template.id)
    }
    if (typeof template.title !== 'string' || template.title.trim() === ''
      || template.title.length > 120) {
      errors.push(`${at}.title must be a non-empty string of at most 120 characters`)
    }
    if (typeof template.file !== 'string' || !TEMPLATE_FILE_RE.test(template.file)) {
      errors.push(`${at}.file must be a flat .js filename without directories`)
    } else if (files.has(template.file)) {
      errors.push(`${at}.file duplicates "${template.file}"`)
    } else {
      files.add(template.file)
    }
    if (template.tags !== undefined) {
      if (!Array.isArray(template.tags) || template.tags.length > 16
        || !template.tags.every(tag => typeof tag === 'string' && TEMPLATE_TAG_RE.test(tag))) {
        errors.push(`${at}.tags must be an array of up to 16 lowercase tags`)
      }
    }
  })
  return errors
}
