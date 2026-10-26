/**
 * 房间里收到好友请求时的轻提示（2026-10-26 反馈：只能在房间外同意太绕）。
 *
 * 设计约束：
 * - **不打断**：底部控制栏上方的一条小纸卡，8 秒自动收起，不抢焦点；
 * - **不挡操作**：只在自身大小内接收点击，其余区域完全穿透；
 * - **可忽略**：忽略只是收起提示，请求仍留在好友面板里，不会丢。
 */
import { useEffect } from "react";

import { Avatar } from "./ui";
import type { FriendRequest } from "../account/types";

interface FriendRequestToastProps {
  request: FriendRequest;
  onAccept: () => void;
  onDismiss: () => void;
}

export function FriendRequestToast({ request, onAccept, onDismiss }: FriendRequestToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 8_000);
    return () => window.clearTimeout(timer);
  }, [request.account.id, onDismiss]);

  return (
    <div className="vx-freq" role="status">
      <Avatar
        avatar={request.account.avatar}
        color="#b783d9"
        name={request.account.name}
        size={30}
      />
      <div className="vx-freq-main">
        <b>{request.account.name}</b>
        <span>想加你为好友</span>
      </div>
      <button type="button" className="vx-freq-accept" onClick={onAccept}>
        同意
      </button>
      <button type="button" className="vx-freq-dismiss" onClick={onDismiss} aria-label="稍后处理">
        稍后
      </button>
    </div>
  );
}
