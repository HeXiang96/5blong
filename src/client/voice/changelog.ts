/**
 * 首页公告栏「最新更新」的唯一数据源。
 *
 * 发版约定（简洁版）：每次发版**只在数组最前面加一条**：
 *   { version: "x.y.z", date: "YYYY-MM-DD", lines: [最多 4 条短句] }
 * 首页公告栏自动展示最新一条并标注版本号；历史条目保留在下面备查。
 * 短句要求：每条一句话（建议 ≤ 16 字），说人话、讲变化，不堆术语。
 *
 * `npm run bump` 的收尾输出里也会提醒这一步（见 scripts/bump-version.mjs）。
 */

export interface ChangelogEntry {
  /** 对应桌面端/网页的版本号（与 package.json 一致）。 */
  version: string;
  /** 发布日期（YYYY-MM-DD）。 */
  date: string;
  /** 简洁版更新条目：最多 4 条，每条一句话。 */
  lines: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    // 纯修复/调优版：lines 留空 → 公告栏展示上一条有内容版本
    version: "1.1.3",
    date: "2026-10-14",
    lines: [],
  },
  {
    // 纯修复版：lines 留空 → 公告栏展示上一条有内容版本
    version: "1.1.2",
    date: "2026-10-14",
    lines: [],
  },
  {
    // 纯修复版：lines 留空 → 公告栏展示上一条有内容版本
    version: "1.1.1",
    date: "2026-10-14",
    lines: [],
  },
  {
    version: "1.1.0",
    date: "2026-10-14",
    lines: [
      "围炉看投影：开共享，全房同看大幕布",
      "投影仪从天而降，小猪围火趴坐围观",
      "共享画质两档：高清 720p / 超清 1080p",
      "多房间互不串流，语音链路零影响",
    ],
  },
  {
    // bump 自动插入（发版时保证首条 = 本次版本）；内容按需补充，留空 = 公告栏展示上一条有内容版本
    version: "1.0.10",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.9",
    date: "2026-10-14",
    lines: ["修好：启动时的更新提示不再挡屏"],
  },
  {
    version: "1.0.8",
    date: "2026-10-13",
    lines: [
      "更新全流程换成木牌主题界面，告别原生白框",
      "窗口标题栏跟随深浅色与四时段主题",
      "默认静音进房；投喂后小猪立即跑向食物",
      "设置里改昵称，铭牌立即跟着变",
    ],
  },
  {
    version: "1.0.7",
    date: "2026-10-13",
    lines: [
      "修好：房主进设置不再冻结全房",
      "设置页新增「快捷方式」指南",
      "客户端滚动条不再乱入",
    ],
  },
  {
    version: "1.0.6",
    date: "2026-10-13",
    lines: [
      "小猪换 3D 新形象，全套动作上线",
      "新互动「吊起来」+ 降落伞空降入场",
      "场景与界面跟随早晚自动变色",
      "更新下载显示进度：小猪跑给你看",
    ],
  },
  {
    // 纯修复/已合并版本：lines 留空 → 公告栏翻页时跳过
    version: "1.0.5",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.4",
    date: "2026-10-13",
    lines: [
      "8 种小猪互动动作上线",
      "闭听戴耳罩，全房间可见",
      "房间场景与聊天界面木质化",
      "断线自动重连、跨网连通增强",
    ],
  },
];

/** 公告栏展示用：最新一条**有内容**的记录。 */
export function latestChangelog(): ChangelogEntry | undefined {
  return CHANGELOG.find((entry) => entry.lines.length > 0);
}

/** 公告栏可翻阅的过往更新：有内容的最近 4 条（最新在前）。 */
export function boardEntries(): ChangelogEntry[] {
  return CHANGELOG.filter((entry) => entry.lines.length > 0).slice(0, 4);
}
