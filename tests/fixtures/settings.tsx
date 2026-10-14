/** 设置页视觉回归夹具：直接渲染 SettingsView，支持 ?theme= 与 ?daypart=（daypart 由 PenFrame 钩子写入，这里手动挂）。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SettingsView } from "../../src/client/voice/components/SettingsView";
import "../../src/client/voice/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const forcedDaypart = params.get("daypart");
if (forcedDaypart) document.documentElement.dataset.daypart = forcedDaypart;

const identity = {
  personId: "9165556823",
  name: "爱笑的小鹿",
  avatar: "",
  color: "#b783d9",
};

const settings = {
  micDeviceId: "",
  speakerDeviceId: "",
  processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  joinMuted: false,
  micVolume: 1,
  peerVolumes: {},
  peerMuted: {},
  shareQuality: "fhd1080" as const,
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsView
      identity={identity}
      settings={settings}
      onSave={() => {}}
      onClose={() => {}}
      onNotice={() => {}}
    />
  </StrictMode>,
);
