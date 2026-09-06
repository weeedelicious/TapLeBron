/**
 * 画布 Cindy 的准入：聊天 + 默认模式对所有人，film / master 按名单
 * （2026-08-24 用户要求「所有人都能用画布的 cindy 聊天 和 cindy skill 的默认模式」）。
 *
 * 这次改动把一道**默认关着**的门改成**默认开着**，方向反了，所以两头都要锁死：
 *
 *   ① 开的那头：收窄名单是空的时候，任何登录账号都必须能用。
 *      这是本次改动的全部目的，写错了就等于没改。
 *   ② 关的那头：`isUserAllowed` 是唯一那道门，绝不能对**没登录**（id 是
 *      undefined / 0 / NaN）的请求点头。空名单代表"所有登录用户"，不代表"所有人"。
 *   ③ 高级模式的越权：前端不会给没权限的人显示 film / master，但请求体是用户可控的 ——
 *      谁都能手搓一个 `mode:'master'` 打过来。所以最终生效的模式必须由服务端定。
 *      漏了这条，名单就只是个 UI 装饰，谁都能白拿高级 skill。
 *
 * 顺带锁住配置的兜底链：高级模式名单不写时沿用遗留的 CINDY_ASSISTANT_ALLOWED_USER_IDS ——
 * 就是靠这条，放开聊天那天生产 .env 一个字都不用改，原本有高级模式的人也不会少东西。
 */
import { afterEach, describe, expect, it } from 'vitest'

/*
 * CindyAssistantService 要 require server/config.js，它在加载时就强制要求这几个环境变量。
 * 这里只为让模块能加载 —— 本文件测的都是纯函数，不碰数据库也不发请求。
 */
for (const [key, value] of Object.entries({
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  DB_NAME: 'test',
  SESSION_SECRET: 'test-secret',
  INITIAL_ADMIN_PASSWORD: 'test-only',
})) {
  if (!process.env[key]) process.env[key] = value
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../server/config.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const service = require('../server/services/CindyAssistantService.js')

const { CINDY_MODE_ORDER, allowedCindyModes, isUserAllowed, normalizeCindyMode, resolveCindyMode } = service

/**
 * 两个名单都是每次调用现读 config 的，所以测试直接改 config 就能造场景。
 * 每个用例跑完还原，避免互相污染。
 */
const original = {
  restrictToUserIds: config.cindyAssistant.restrictToUserIds,
  advancedModeUserIds: config.cindyAssistant.advancedModeUserIds,
}
const setLists = (restrictToUserIds: number[], advancedModeUserIds: number[]) => {
  config.cindyAssistant.restrictToUserIds = restrictToUserIds
  config.cindyAssistant.advancedModeUserIds = advancedModeUserIds
}
afterEach(() => {
  config.cindyAssistant.restrictToUserIds = original.restrictToUserIds
  config.cindyAssistant.advancedModeUserIds = original.advancedModeUserIds
})

describe('① 收窄名单为空 = 所有登录账号都能用', () => {
  it('名单空着时，随便哪个 id 都能用（这就是本次改动）', () => {
    setLists([], [1])
    for (const id of [1, 2, 18, 47, 9999]) {
      expect(isUserAllowed({ id })).toBe(true)
    }
  })

  it('id 是字符串（从数据库/session 里读出来常是字符串）也认', () => {
    setLists([], [1])
    expect(isUserAllowed({ id: '23' })).toBe(true)
  })
})

describe('② 未登录仍然进不来（空名单 ≠ 所有人）', () => {
  it('没有 user 对象 / id 缺失 → 拒', () => {
    setLists([], [1])
    for (const user of [undefined, null, {}, { id: undefined }, { id: null }]) {
      expect(isUserAllowed(user)).toBe(false)
    }
  })

  it('id 不是正整数 → 拒（0 / 负数 / NaN / 小数 / 乱字符串）', () => {
    setLists([], [1])
    for (const id of [0, -1, NaN, 1.5, 'abc', '', Infinity]) {
      expect(isUserAllowed({ id })).toBe(false)
    }
  })

  it('没登录的人一个模式也拿不到', () => {
    setLists([], [1])
    expect(allowedCindyModes(undefined)).toEqual([])
    expect(allowedCindyModes({ id: 0 })).toEqual([])
  })
})

describe('收窄名单填了值时能真的收回来（出事时的退路）', () => {
  it('只有名单里的人能用', () => {
    setLists([1, 18], [1])
    expect(isUserAllowed({ id: 1 })).toBe(true)
    expect(isUserAllowed({ id: 18 })).toBe(true)
    expect(isUserAllowed({ id: 19 })).toBe(false)
    expect(isUserAllowed({ id: 47 })).toBe(false)
  })

  it('被收窄挡住的人，即使在高级名单里也一个模式都没有', () => {
    setLists([1], [1, 19])
    expect(allowedCindyModes({ id: 19 })).toEqual([])
  })
})

describe('默认模式人人有，film / master 按名单', () => {
  it('不在高级名单里 → 只有默认模式', () => {
    setLists([], [1])
    expect(allowedCindyModes({ id: 47 })).toEqual(['default'])
  })

  it('在高级名单里 → 三个模式都有，且顺序固定（default 排第一）', () => {
    setLists([], [1, 19])
    expect(allowedCindyModes({ id: 19 })).toEqual(['default', 'film', 'master'])
    expect(CINDY_MODE_ORDER[0]).toBe('default')
  })

  it('高级名单为空时也不能把 film / master 漏给所有人', () => {
    setLists([], [])
    expect(allowedCindyModes({ id: 1 })).toEqual(['default'])
    expect(allowedCindyModes({ id: 47 })).toEqual(['default'])
  })
})

describe('③ 生效模式由服务端定（越权静默降级，不报错）', () => {
  it('没权限的人请求 master / film → 拿到的是 default', () => {
    setLists([], [1])
    expect(resolveCindyMode({ id: 47 }, 'master')).toBe('default')
    expect(resolveCindyMode({ id: 47 }, 'film')).toBe('default')
  })

  it('有权限的人请求 master / film → 按请求给', () => {
    setLists([], [1])
    expect(resolveCindyMode({ id: 1 }, 'master')).toBe('master')
    expect(resolveCindyMode({ id: 1 }, 'film')).toBe('film')
  })

  it('默认模式谁都能用', () => {
    setLists([], [1])
    expect(resolveCindyMode({ id: 47 }, 'default')).toBe('default')
    expect(resolveCindyMode({ id: 1 }, 'default')).toBe('default')
  })

  it('乱值 / 缺值一律退回 default，不抛异常', () => {
    setLists([], [1])
    for (const mode of [undefined, null, '', 'MASTER', '乱写', 42, {}, ['master']]) {
      expect(resolveCindyMode({ id: 1 }, mode)).toBe('default')
    }
  })

  it('normalizeCindyMode 只认这三个值', () => {
    expect(normalizeCindyMode('film')).toBe('film')
    expect(normalizeCindyMode('master')).toBe('master')
    expect(normalizeCindyMode('default')).toBe('default')
    expect(normalizeCindyMode('studio')).toBe('default')
  })
})

describe('配置的兜底链（靠它做到生产 .env 不用改）', () => {
  const configPath = require.resolve('../server/config.js')

  /*
   * 重新加载 config.js 来观察兜底链。
   *
   * 「没写这个变量」一律用**空字符串**表示，不用 delete —— config.js 会再跑一次
   * dotenv.config()，而 dotenv 只跳过 process.env 里**已存在**的 key。删掉的话，
   * 哪天仓库根目录出现一个本地 .env，这几个用例就会莫名其妙地读到真实配置。
   * 空字符串在 `a || b` 里和未定义等价，同时又"占着位子"让 dotenv 不去覆盖。
   */
  const loadConfigWith = (env: Record<string, string>) => {
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
    Object.assign(process.env, env)
    delete require.cache[configPath]
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../server/config.js').cindyAssistant
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      // 缓存留着上面那份按临时 env 算出来的 config 会污染后续 require，清掉
      delete require.cache[configPath]
    }
  }

  it('高级名单没写 → 沿用遗留的 CINDY_ASSISTANT_ALLOWED_USER_IDS', () => {
    const loaded = loadConfigWith({
      CINDY_ASSISTANT_ADVANCED_MODE_USER_IDS: '',
      CINDY_ASSISTANT_ALLOWED_USER_IDS: '1,18,19,22,23,29',
      CINDY_ASSISTANT_RESTRICT_USER_IDS: '',
    })
    expect(loaded.advancedModeUserIds).toEqual([1, 18, 19, 22, 23, 29])
    // 关键：老的那行**不再**限制聊天了 —— 就是这条让生产 .env 一个字都不用改
    expect(loaded.restrictToUserIds).toEqual([])
  })

  it('高级名单写了 → 以它为准，不看遗留变量', () => {
    const loaded = loadConfigWith({
      CINDY_ASSISTANT_ADVANCED_MODE_USER_IDS: '1,19',
      CINDY_ASSISTANT_ALLOWED_USER_IDS: '1,18,19,22,23,29',
      CINDY_ASSISTANT_RESTRICT_USER_IDS: '',
    })
    expect(loaded.advancedModeUserIds).toEqual([1, 19])
  })

  it('两个都没写 → 高级模式只对用户 1（保守默认，不会误开）', () => {
    const loaded = loadConfigWith({
      CINDY_ASSISTANT_ADVANCED_MODE_USER_IDS: '',
      CINDY_ASSISTANT_ALLOWED_USER_IDS: '',
      CINDY_ASSISTANT_RESTRICT_USER_IDS: '',
    })
    expect(loaded.advancedModeUserIds).toEqual([1])
  })

  it('填了收窄名单能读出来（出事时改 .env 重启就能收回）', () => {
    const loaded = loadConfigWith({
      CINDY_ASSISTANT_RESTRICT_USER_IDS: '1, 19',
      CINDY_ASSISTANT_ADVANCED_MODE_USER_IDS: '',
      CINDY_ASSISTANT_ALLOWED_USER_IDS: '',
    })
    expect(loaded.restrictToUserIds).toEqual([1, 19])
  })
})
