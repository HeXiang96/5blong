/**
 * 房主收到「XX 想进你的房间」时的轻提示（2026-10-27）。
 *
 * 场景：好友在某个房间里、而那是私密房（或者我不知道临时密码），
 * 他点「进他的房」→ 我这边就冒出这一条。
 *
 * 三条约束和好友请求提示（FriendRequestToast）一致：
 * - **不打断**：12 秒自动收起，不抢焦点；
 * - **不丢**：收起只是关掉提示，敲门记录还在好友面板「待处理」里（10 分钟内有效）；
 * - **同意才给钥匙**：这里只是"放人进来"的确认，钥匙由我这台机器随邀请发出去，
 *   服务端不生成、不保存临时密码。
 */
import { useEffect, useRef } from "react";
import { DoorOpen } from "lucide-react";

import { Avatar } from "./ui";
import type { Knock } from "../account/types";

interface KnockToastProps {
  knock: Knock;
  /** 我自己也在房间里 → 能放他进来；不在房间就只能忽略 */
  canAccept: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}

export function KnockToast({ knock, canAccept, onAccept, onDismiss }: KnockToastProps) {
  /*
   * 父组件每 20 秒刷一次好友数据就会重渲染，`onDismiss` 每次都是新函数。
   * 直接把它放进依赖数组会把 12 秒的计时器一次次重置 —— 提示就永远不消失。
   * 所以只按"是谁敲的"重置计时器，回调走 ref。
   */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), 12_000);
    return () => window.clearTimeout(timer);
  }, [knock.from.id]);

  return (
    <div className="vx-freq vx-freq-knock" role="status">
      <Avatar avatar={knock.from.avatar} color="#b783d9" name={knock.from.name} size={30} />
      <div className="vx-freq-main">
        <b>{knock.from.name}</b>
        <span>{canAccept ? "想进你的房间" : "想进你的房间 · 你还没开房"}</span>
      </div>
      {canAccept ? (
        <button type="button" className="vx-freq-accept" onClick={onAccept}>
          <DoorOpen size={13} /> 放他进来
        </button>
      ) : null}
      <button type="button" className="vx-freq-dismiss" onClick={onDismiss} aria-label="忽略">
        忽略
      </button>
    </div>
  );
}
