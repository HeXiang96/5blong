/** 视觉夹具：房间内好友请求提示（?theme=dark 看夜间）。 */
import { createRoot } from "react-dom/client";

import { FriendRequestToast } from "../../src/client/voice/components/FriendRequestToast";
import "../../src/client/voice/styles.css";
import "../../src/client/voice/account.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
if (params.get("night")) document.documentElement.dataset.daypart = "night";

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", background: "linear-gradient(#f7ecd6, #dce9b6)" }}>
    <FriendRequestToast
      request={{
        account: {
          id: "53720018",
          username: "tangxiaofei",
          name: "无敌唐小菲大王",
          avatar: "",
          avatarVersion: 0,
          createdAt: Date.now(),
        },
        at: Date.now(),
      }}
      onAccept={() => {}}
      onDismiss={() => {}}
    />
  </div>,
);
