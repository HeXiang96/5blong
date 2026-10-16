/**
 * 一键体检：进房前自查 麦克风 / 扬声器 / 网络。
 *
 * 背景（2026-10-16 语音无声事故的教训）：用户出问题时自己完全不知道坏在哪一环，
 * 反馈里只有"没声音"。这个面板把三件事拆开测，让用户**自己**先看到答案，
 * 也能把"哪一环亮红灯"直接截图发到反馈里。
 *
 * - 麦克风：复用设置页的 startMicTest（3 秒电平采样）；
 * - 扬声器：合成一段短蜂鸣（用户手势内播放，无需元素）；
 * - 网络：/ice 凭据 + 强制中继 gathering（与引擎同源，见 ./ice.ts）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Check, Mic, Volume2, Wifi, X } from "lucide-react";

import { startMicTest, type MicTest } from "../devices";
import { ensureIceServers, iceServers } from "../ice";
import type { VoiceSettings } from "../settings";

type RowState = "idle" | "running" | "ok" | "warn" | "fail";

const STATE_ICON: Record<RowState, string> = {
  idle: "",
  running: "…",
  ok: "✓",
  warn: "⚠",
  fail: "✕",
};

/** 合成一段两声短蜂鸣（用户手势上下文里直接渲染到默认输出）。 */
async function playTestTone(): Promise<void> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("audio-context-unavailable");
  const ctx = new Ctor();
  try {
    await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.22, ctx.currentTime + 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    await new Promise((r) => setTimeout(r, 950));
    osc.stop();
  } finally {
    void ctx.close().catch(() => {});
  }
}

/** 强制走中继（TURN）收集候选：验证"严格 NAT 也能进房"的关键能力。 */
async function checkNetwork(): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now();
  await ensureIceServers();
  const servers = iceServers();
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: "relay" });
  try {
    pc.createDataChannel("health");
    let relay = 0;
    pc.onicecandidate = (e) => {
      if (e.candidate?.type === "relay") relay += 1;
    };
    await pc.setLocalDescription(await pc.createOffer());
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && pc.iceGatheringState !== "complete") {
      await new Promise((r) => setTimeout(r, 250));
      if (relay > 0 && Date.now() - t0 > 3000) break;
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (relay > 0) return { ok: true, detail: `中继可用（${sec}s）——正常网络下能进房` };
    return { ok: false, detail: "没拿到中继线路——严格网络下可能进不了房，试试换网络（如手机热点）" };
  } finally {
    try {
      pc.close();
    } catch {
      /* noop */
    }
  }
}

function Row({
  icon,
  title,
  state,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  state: RowState;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className={`vx-hc-row vx-hc-${state}`}>
      <span className="vx-hc-icon">{icon}</span>
      <span className="vx-hc-body">
        <b>
          {title}
          {STATE_ICON[state] ? <em className="vx-hc-state">{STATE_ICON[state]}</em> : null}
        </b>
        {detail ? <small>{detail}</small> : null}
      </span>
      {action ? <span className="vx-hc-action">{action}</span> : null}
    </div>
  );
}

export function HealthCheck({
  settings,
  triggerLabel = "先检查设备",
  triggerClass = "vx-btn vx-btn-quiet",
}: {
  settings: VoiceSettings;
  triggerLabel?: string;
  triggerClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const [micState, setMicState] = useState<RowState>("idle");
  const [micDetail, setMicDetail] = useState("");
  const [spkState, setSpkState] = useState<RowState>("idle");
  const [spkDetail, setSpkDetail] = useState("");
  const [netState, setNetState] = useState<RowState>("idle");
  const [netDetail, setNetDetail] = useState("");
  const micTestRef = useRef<MicTest | null>(null);

  // 关面板时确保采音停掉。
  useEffect(() => {
    if (open) return;
    micTestRef.current?.stop();
    micTestRef.current = null;
  }, [open]);
  useEffect(() => () => micTestRef.current?.stop(), []);

  const runMic = async () => {
    if (micTestRef.current) {
      micTestRef.current.stop();
      micTestRef.current = null;
    }
    setMicState("running");
    setMicDetail("正在听 3 秒，请对着麦克风说句话…");
    let peak = 0;
    try {
      micTestRef.current = await startMicTest(settings, (level) => {
        peak = Math.max(peak, level);
      });
    } catch (error) {
      setMicState("fail");
      setMicDetail(`麦克风拿不到：${String((error as Error)?.message ?? error)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
    micTestRef.current?.stop();
    micTestRef.current = null;
    if (peak > 0.04) {
      setMicState("ok");
      setMicDetail("检测到声音，麦克风工作正常");
    } else if (peak > 0.005) {
      setMicState("warn");
      setMicDetail("有微弱声音——麦克风离远了吗？或到系统设置里调高音量");
    } else {
      setMicState("fail");
      setMicDetail("完全没检测到声音——检查系统里选没选对麦克风、有没有被静音");
    }
  };

  const runSpeaker = async () => {
    setSpkState("running");
    setSpkDetail("播放一段试音…");
    try {
      await playTestTone();
      setSpkState("ok");
      setSpkDetail("已播放。听到了就点 ✓；没听到请检查系统音量/输出设备");
    } catch (error) {
      setSpkState("fail");
      setSpkDetail(`放不出声音：${String((error as Error)?.message ?? error)}`);
    }
  };

  const runNetwork = async () => {
    setNetState("running");
    setNetDetail("正在探测中转线路…");
    try {
      const result = await checkNetwork();
      setNetState(result.ok ? "ok" : "warn");
      setNetDetail(result.detail);
    } catch (error) {
      setNetState("fail");
      setNetDetail(`网络探测失败：${String((error as Error)?.message ?? error)}`);
    }
  };

  const runAll = () => {
    void runMic();
    void runSpeaker();
    void runNetwork();
  };

  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        <Activity size={15} /> {triggerLabel}
      </button>
      {open ? (
        <div className="vx-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="vx-modal vx-hc-modal" onClick={(e) => e.stopPropagation()}>
            <h2>一键体检</h2>
            <p className="vx-modal-sub">三件事各测一下，问题出在哪一环一眼看清。</p>
            <div className="vx-hc-rows">
              <Row
                icon={<Mic size={18} />}
                title="麦克风"
                state={micState}
                detail={micDetail}
                action={
                  <button
                    type="button"
                    className="vx-btn vx-btn-small vx-btn-quiet"
                    onClick={() => void runMic()}
                  >
                    {micState === "running" ? "监听中" : micState === "idle" ? "开始" : "再测一次"}
                  </button>
                }
              />
              <Row
                icon={<Volume2 size={18} />}
                title="扬声器"
                state={spkState}
                detail={spkDetail}
                action={
                  <button
                    type="button"
                    className="vx-btn vx-btn-small vx-btn-quiet"
                    onClick={() => void runSpeaker()}
                  >
                    {spkState === "idle" ? "播放试音" : "重播"}
                  </button>
                }
              />
              <Row
                icon={<Wifi size={18} />}
                title="网络"
                state={netState}
                detail={netDetail}
                action={
                  <button
                    type="button"
                    className="vx-btn vx-btn-small vx-btn-quiet"
                    onClick={() => void runNetwork()}
                  >
                    {netState === "running" ? "探测中" : netState === "idle" ? "开始" : "再测一次"}
                  </button>
                }
              />
            </div>
            <p className="vx-modal-hint">
              哪一环亮了 ✕，截图这页发到「意见反馈」就能说清问题。
            </p>
            <div className="vx-modal-actions">
              <button type="button" className="vx-btn vx-btn-primary" onClick={runAll}>
                <Check size={15} /> 全部测一遍
              </button>
              <button type="button" className="vx-btn vx-btn-quiet" onClick={() => setOpen(false)}>
                <X size={15} /> 关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
