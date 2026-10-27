/**
 * 开黑圈的 URL 工具（纯字符串逻辑，无 React / 无引擎依赖）。
 *
 * 单独成文件的原因：App 首帧就要读 `?g=` 判断是否直接进开黑圈，
 * 若从 GameRoomView.tsx 里 import，会把 700+ 行视图和整条引擎链拉进首屏包，
 * 懒加载就形同虚设。这里保持**不引视图/引擎**，任何模块都可以安全引用。
 *
 * 房码格式**只认 protocol.ts 那一处**（6 位新码 + 老 4 位兼容）。
 * 这里曾经自己写了一份 `^[0-9]{4}$`，2026-10-26 房码扩到 6 位后没跟着改，
 * 结果开黑圈建房生成 6 位码、加入却只收 4 位——邀请链接直接打不开。
 * 别再复制正则，统一用 isRoomCode。
 */

import { isRoomCode, normalizeCode } from "../voice/protocol";

/** 复制用的邀请链接（桌面端页面在本地协议下，必须改写成网页可用地址）。 */
export function gameInviteUrl(code: string): string {
  const host = window.location.hostname;
  const desktop = host === "tauri.localhost" || host.endsWith(".tauri.localhost");
  const url = new URL(desktop ? "https://5blong.pages.dev/" : window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("g", normalizeCode(code));
  return url.toString();
}

/**
 * 从查询串里解析房间码（6 位新码 / 4 位老码都放行）。
 *
 * 纯函数（不读 window）是为了能在 node 下单测——房码长度这类问题
 * 全靠人眼盯是盯不住第二次的。
 */
export function parseGameCode(search: string): string | null {
  const value = normalizeCode(new URLSearchParams(search).get("g") ?? "");
  return isRoomCode(value) ? value : null;
}

/** 从地址栏读开黑圈房间码；没有或不合法返回 null。 */
export function gameCodeFromUrl(): string | null {
  return parseGameCode(window.location.search);
}
