p = 'tests/engine-join-handshake.test.ts'
s = open(p, encoding='utf-8', newline='').read()

# startHost 支持私密房
old = '''const startHost = async (): Promise<{ host: VoiceMesh; holder: any; invite: any }> => {
  const holder = makeEvents();
  const host = new VoiceMesh(holder.events as any);
  engines.push(host);
  let invite: any = null;
  holder.events.ready = (v: any) => {
    invite = v;
  };
  await host.host(identity, defaultSettings(), false);
  return { host, holder, invite };
};'''
new = '''const startHost = async (
  prefer?: { private?: boolean },
): Promise<{ host: VoiceMesh; holder: any; invite: any }> => {
  const holder = makeEvents();
  const host = new VoiceMesh(holder.events as any);
  engines.push(host);
  let invite: any = null;
  holder.events.ready = (v: any) => {
    invite = v;
  };
  await host.host(identity, defaultSettings(), false, prefer);
  return { host, holder, invite };
};'''
assert old in s
s = s.replace(old, new, 1)

# startGuest 支持临时密码
old = '''const startGuest = async (target: {
  code: string;
  hostId: string;
  roomKey: string;
}): Promise<{ guest: VoiceMesh; holder: any }> => {'''
new = '''const startGuest = async (target: {
  code: string;
  hostId: string;
  roomKey: string;
  pass?: string;
}): Promise<{ guest: VoiceMesh; holder: any }> => {'''
assert old in s
s = s.replace(old, new, 1)

# 追加私密房用例（放在 describe 内的最后一个 it 之后：这里直接追加到文件尾的新 describe）
s += '''
/**
 * 私密房（登录账号的「我的房间」）门禁 —— 这是 2026-10-26 这轮改动的核心行为，
 * 用真实引擎（信令与 PeerJS 已打桩）跑一遍，比手点界面靠谱：
 *   ① 裸输房号 → 必须被拒（needs-pass）
 *   ② 房号 + 临时密码 → 进得来
 *   ③ 房主关掉密码后，旧密码立刻失效（bad-pass）
 *   ④ 普通房老行为不变：裸码照样进
 */
describe("私密房门禁（我的房间）", () => {
  it("裸输房号进不去，并且给的是 needs-pass 而不是 bad-key", async () => {
    const { holder: hostHolder, invite } = await startHost({ private: true });
    const { holder: guestHolder } = await startGuest({
      code: invite.code,
      hostId: "",
      roomKey: "",
    });

    await sleep(30);
    expect(lastStatus(guestHolder)).not.toBe("connected");
    // 房主侧不应把这个人收进名册
    expect(lastMembers(hostHolder)).toHaveLength(1);
    // 拒绝原因是 needs-pass（客户端据此弹出"输入临时密码"）
    const reasons = guestHolder.events.__reasons ?? [];
    expect(reasons).toContain("needs-pass");
  });

  it("房号 + 临时密码能进；关掉密码后同一个密码立刻失效", async () => {
    const { host, holder: hostHolder, invite } = await startHost({ private: true });
    const pass = host.renewGuestPass();
    expect(pass).toMatch(/^\\d{6}$/);

    const { holder: guestHolder } = await startGuest({
      code: invite.code,
      hostId: "",
      roomKey: "",
      pass,
    });
    await sleep(30);
    expect(lastStatus(guestHolder)).toBe("connected");
    expect(lastMembers(hostHolder)).toHaveLength(2);

    // 房主关掉临时密码 → 新来的拿旧密码进不来
    host.closeGuestPass();
    expect(host.getGuestPass()).toBe("");
    const { holder: lateHolder } = await startGuest({
      code: invite.code,
      hostId: "",
      roomKey: "",
      pass,
    });
    await sleep(30);
    expect(lastStatus(lateHolder)).not.toBe("connected");
    expect(lateHolder.events.__reasons ?? []).toContain("bad-pass");
  });

  it("普通房不受影响：裸码仍然直接进", async () => {
    const { holder: hostHolder, invite } = await startHost();
    const { holder: guestHolder } = await startGuest({
      code: invite.code,
      hostId: "",
      roomKey: "",
    });
    await sleep(30);
    expect(lastStatus(guestHolder)).toBe("connected");
    expect(lastMembers(hostHolder)).toHaveLength(2);
  });
});
'''

# makeEvents 记录 rejected 原因（引擎新增的 rejected 事件）
old = '''      mediaState: (_peerId?: string, _state?: string) => {},
    },'''
new = '''      mediaState: (_peerId?: string, _state?: string) => {},
      // 新增：被拒原因（UI 据此展开"临时密码"输入行）
      __reasons: [] as string[],
      rejected: (reason: string) => {
        (holderRef.reasons as string[]).push(reason);
      },
    },'''
assert old in s
s = s.replace(old, new, 1)

# makeEvents 里需要一个 reasons 台账（holder 尚未定义，改成闭包变量）
old = '''function makeEvents() {
  const statuses: Array<{ status: string; detail?: string }> = [];
  const membersSnapshots: any[][] = [];
  return {
    statuses,
    membersSnapshots,
    events: {'''
new = '''function makeEvents() {
  const statuses: Array<{ status: string; detail?: string }> = [];
  const membersSnapshots: any[][] = [];
  const reasons: string[] = [];
  return {
    statuses,
    membersSnapshots,
    reasons,
    events: {'''
assert old in s
s = s.replace(old, new, 1)

# 修正 rejected 实现：直接用 reasons
old = '''      // 新增：被拒原因（UI 据此展开"临时密码"输入行）
      __reasons: [] as string[],
      rejected: (reason: string) => {
        (holderRef.reasons as string[]).push(reason);
      },'''
new = '''      // 新增：被拒原因（UI 据此展开"临时密码"输入行）
      rejected: (reason: string) => {
        reasons.push(reason);
      },'''
assert old in s
s = s.replace(old, new, 1)

# 用例里改用 holder.reasons
s = s.replace('const reasons = guestHolder.events.__reasons ?? [];\n    expect(reasons).toContain("needs-pass");',
              'expect(guestHolder.reasons).toContain("needs-pass");')
s = s.replace('expect(lateHolder.events.__reasons ?? []).toContain("bad-pass");',
              'expect(lateHolder.reasons).toContain("bad-pass");')

open(p, 'w', encoding='utf-8', newline='').write(s)
print('tests extended')
