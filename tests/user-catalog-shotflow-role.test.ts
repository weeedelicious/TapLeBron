import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { localRoleFromExternal, normalizeShotflowRole } = require('../server/shotflowRole.js')

describe('Shotflow 独立画布管理角色', () => {
  it('只认 shotflow_role=admin，不借用 SD2 的 is_admin', () => {
    expect(localRoleFromExternal({ shotflow_role: 'admin', is_admin: 0 })).toBe('admin')
    expect(localRoleFromExternal({ shotflow_role: 'artist', is_admin: 1 })).toBe('user')
  })

  it('空值和未知值都安全降级为氛围艺术家', () => {
    expect(normalizeShotflowRole(null)).toBe('artist')
    expect(normalizeShotflowRole('owner')).toBe('artist')
    expect(localRoleFromExternal({ is_admin: 1 })).toBe('user')
  })

  it('对管理员值做大小写和空白归一化', () => {
    expect(normalizeShotflowRole(' ADMIN ')).toBe('admin')
  })
})
