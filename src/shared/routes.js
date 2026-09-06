const SHOTFLOW_BASE_PATH = '/Shotflow'
const SHOTFLOW_ADMIN_PATH = '/Shotflow/admin'
const SHOTFLOW_ERROR_LIBRARY_PATH = '/Shotflow/errors'

export function normalizePathname(pathname = '/') {
  const normalized = String(pathname || '/').replace(/\/+$/, '')
  return normalized || '/'
}

export function getAppHomePath(pathname = window.location.pathname) {
  return SHOTFLOW_BASE_PATH
}

export function getAdminPath(pathname = window.location.pathname) {
  return SHOTFLOW_ADMIN_PATH
}

export function getErrorLibraryPath(pathname = window.location.pathname) {
  return SHOTFLOW_ERROR_LIBRARY_PATH
}

export function isAdminPath(pathname = window.location.pathname) {
  const normalized = normalizePathname(pathname)
  return normalized === SHOTFLOW_ADMIN_PATH
}

export function isErrorLibraryPath(pathname = window.location.pathname) {
  const normalized = normalizePathname(pathname)
  return normalized === SHOTFLOW_ERROR_LIBRARY_PATH
}
