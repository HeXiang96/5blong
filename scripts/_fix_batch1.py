#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量修复：静音加入 / 昵称铭牌 / 投喂时序 / 徽章对比度 / changelog"""
import io, sys, os

os.chdir(r"E:\twest\5blong\piik\src\client\voice")

def patch(path, pairs, must=True):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            if must:
                print(f"[FAIL] {path}: 未找到锚点: {old[:60]!r}")
                sys.exit(1)
            continue
        s = s.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print(f"[OK] {path}")

# ================= engine.ts =================
patch("engine.ts", [
    # 投喂后立即出发（菜 1.1s 落地）
    ('''    this.emitPen(toss);
    this.timers.after(3600, () => {
      if (this.destroyed || !this.hosting || !this.members.has(to)) return;
      this.emitPen(this.pen.produceEat(Date.now(), to, kind));''',
     '''    this.emitPen(toss);
    // 菜 1.1s 后落地，猪 1.2s 就出发——立刻能看到"跑向食物"，
    // 而不是站在原地好几秒没反应（业主实测反馈）。
    this.timers.after(1200, () => {
      if (this.destroyed || !this.hosting || !this.members.has(to)) return;
      this.emitPen(this.pen.produceEat(Date.now(), to, kind));'''),

    # updateIdentity：改昵称立即生效并同步全房
    ('''  setMuted(muted: boolean): void {''',
     '''  /**
   * 房间进行中更新自己的资料（设置页改昵称/头像/颜色）。
   * 之前只写 localStorage，正在运行会话里的铭牌一直是旧名字——
   * 这里改完立即更新成员记录并同步给全房。
   */
  updateIdentity(identity: Identity): void {
    if (!this.me || this.destroyed) return;
    this.me = {
      ...this.me,
      name: identity.name,
      avatar: identity.avatar,
      color: identity.color,
    };
    this.members.set(this.myId, this.me);
    this.emitMembers();
    if (this.hosting) {
      this.broadcastHost({ t: "roster", members: this.roster() });
    } else {
      this.send(this.hostConn, {
        t: "identity",
        name: identity.name,
        avatar: identity.avatar,
        color: identity.color,
      });
    }
  }

  setMuted(muted: boolean): void {'''),

    # host 处理访客的 identity 更新
    ('''      case "muted": {''',
     '''      case "identity": {
        // 访客在设置里改了资料：更新成员记录并重新广播名单
        const guestRecord = this.guests.get(conn.peer);
        const guestMember = guestRecord ? this.members.get(guestRecord.id) : null;
        if (!guestMember) break;
        this.members.set(guestRecord!.id, {
          ...guestMember,
          name: message.name,
          avatar: message.avatar,
          color: message.color,
        });
        this.emitMembers();
        this.broadcastHost({ t: "roster", members: this.roster() });
        break;
      }

      case "muted": {'''),

    # welcome 自同步：静音以本地为准，花名册只恢复房主强制禁言
    ('''          if (this.me) {
            this.me.serverMuted = member.serverMuted ?? false;
            this.me.deafened = member.deafened ?? this.deafened;
            this.me.muted = member.muted;
            if (this.localStream) {
              for (const track of this.localStream.getAudioTracks()) {
                track.enabled = !member.muted;
              }
            }
          }
          continue;''',
     '''          if (this.me) {
            this.me.serverMuted = member.serverMuted ?? false;
            this.me.deafened = member.deafened ?? this.deafened;
            /*
             * 自己的静音状态以**本地选择**为准（确认页的"先静音进入"）。
             * 之前无条件照抄花名册的 muted——而房主侧把访客一律初始化为
             * 静音，导致"取消静音进入"的访客在 welcome 一到就被静音。
             * 花名册只负责恢复房主的强制禁言（serverMuted）。
             */
            if (this.me.serverMuted && !this.me.muted) {
              this.me.muted = true;
              if (this.localStream) {
                for (const track of this.localStream.getAudioTracks()) {
                  track.enabled = false;
                }
              }
            }
          }
          // 把自己当前的静音/闭听状态同步给房主（覆盖 handleHello 的初始值）
          this.send(this.hostConn, {
            t: "muted",
            muted: this.me.muted,
            deafened: this.me.deafened,
          });
          continue;'''),
])

# handleHello：访客初始 muted 用 HELLO 里的真实状态
s = io.open("engine.ts", encoding="utf-8").read()
i = s.find('muted: true,')
# 只改 handleHello 里那一处（找它前面的 hello 上下文确认）
seg_start = s.rfind('handleHello', 0, i)
assert seg_start != -1, "handleHello 锚点未找到"
s = s[:i] + 'muted: message.muted ?? false,' + s[i + len('muted: true,'):]
io.open("engine.ts", "w", encoding="utf-8", newline="").write(s)
print("[OK] engine.ts handleHello muted")

# HELLO 发送时带上 muted（找 t: "hello" 的发送处）
s = io.open("engine.ts", encoding="utf-8").read()
old_hello = '''      t: "hello",'''
i = s.find(old_hello)
assert i != -1
# 在 hello 消息对象里加 muted 字段：找该对象的结尾 nonce 行
j = s.find('nonce:', i)
assert j != -1
k = s.find(',', j)
# 在 nonce 行后插入 muted（保持对象结构）
line_end = s.find('\n', j)
insert_at = line_end
s = s[:insert_at] + '\n      muted: this.me.muted,' + s[insert_at:]
io.open("engine.ts", "w", encoding="utf-8", newline="").write(s)
print("[OK] engine.ts hello muted")

# ================= protocol.ts =================
patch("protocol.ts", [
    # HELLO 类型加 muted
    ('''  | { t: "hello"; personId: string; sessionId: string; name: string; avatar: string; color: string; hasMic: boolean; nonce: string; proof: string }''',
     '''  | { t: "hello"; personId: string; sessionId: string; name: string; avatar: string; color: string; hasMic: boolean; muted: boolean; nonce: string; proof: string }
  | { t: "identity"; name: string; avatar: string; color: string }'''),
])

# hello parse：加 muted；identity parse
s = io.open("protocol.ts", encoding="utf-8").read()
i = s.find('case "hello": {')
assert i != -1
# 在 hello 的 return 对象里补 muted（找 hasMic）
j = s.find("hasMic", i)
line_start = s.rfind("\n", 0, j) + 1
line = s[line_start:s.find("\n", j)]
s = s[:s.find("\n", j)] + "\n        muted: typeof record[\"muted\"] === \"boolean\" ? record[\"muted\"] : false," + s[s.find("\n", j):]
io.open("protocol.ts", "w", encoding="utf-8", newline="").write(s)
print("[OK] protocol.ts hello muted")

# identity parse case（加在 hello case 之后）
s = io.open("protocol.ts", encoding="utf-8").read()
anchor = s.find('case "hello": {')
end = s.find("case ", anchor + 10)
insert_pos = s.rfind("  }\n\n", anchor, end) + len("  }\n\n")
identity_case = '''  if (kind === "identity") {
    const name = str(record["name"], 24);
    const avatar = typeof record["avatar"] === "string" ? record["avatar"].slice(0, 200_000) : "";
    const colorRaw = str(record["color"], 16);
    if (!name || !colorRaw) return null;
    return { t: "identity", id, name, avatar, color: colorRaw };
  }

  '''
s = s[:insert_pos] + identity_case + s[insert_pos:]
io.open("protocol.ts", "w", encoding="utf-8", newline="").write(s)
print("[OK] protocol.ts identity case")
print("BATCH1_DONE")
