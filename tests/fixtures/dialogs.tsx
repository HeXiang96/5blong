/**
 * 两个「告知类」弹窗的视觉回归夹具：新手导览 / 大更新公告。
 *
 * 用法：/tests/fixtures/dialogs.html?d=onboard|whatsnew&theme=light|dark&scene=snow|halloween|spring&daypart=day|night
 * 为什么单独做：这两处文案是**唯一**把新功能告诉用户的地方，改完必须亲眼看过换行与图标，
 * 尤其是深色/场景主题下的对比度（业主强调过多套主题适配）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { OnboardingDialog } from "../../src/client/voice/components/OnboardingDialog";
import { WhatsNewDialog } from "../../src/client/voice/components/WhatsNewDialog";
import "../../src/client/voice/styles.css";
import "../../src/client/voice/account.css";
import "../../src/client/voice/pen-scene.css";
import "../../src/client/voice/pen-life.css";
import "../../src/client/voice/pen-fence.css";
import "../../src/client/voice/pen-tv.css";
import "../../src/client/voice/pen-themes.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scene = params.get("scene");
if (scene) document.documentElement.dataset.scene = scene;
const daypart = params.get("daypart");
if (daypart) document.documentElement.dataset.daypart = daypart;

const which = params.get("d") ?? "onboard";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {which === "whatsnew" ? (
      <WhatsNewDialog open onClose={() => {}} />
    ) : (
      <OnboardingDialog open onClose={() => {}} />
    )}
  </StrictMode>,
);
