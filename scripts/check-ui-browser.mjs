/** 本地 UI 回归：真实 RoomView + 独立成员数据，不访问公共信令或采集麦克风。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const binary = process.env.BROWSER_CLI;
const executable = process.env.BROWSER_EXECUTABLE;
if (!binary || !executable) throw new Error("请设置 BROWSER_CLI 与 BROWSER_EXECUTABLE");
const base = process.env.UI_BASE_URL ?? "http://127.0.0.1:8787";
const output = path.resolve(process.env.UI_OUTPUT_DIR ?? "outputs");
mkdirSync(output, { recursive: true });
const prefix = ["--executable-path", executable, "--session", "5blong-ui-regression"];
const run = async (...args) => {
  const { stdout: result } = await execute(binary, [...prefix, ...args], { encoding: "utf8", timeout: 30000 });
  if (args[0] !== "eval") process.stdout.write(result);
  return result.trim();
};
const evaluate = async (code) => {
  const output = await run("eval", code);
  return JSON.parse(output);
};
const reports = [];
const inspectMenu = `
  const menu = document.querySelector('.vx-member-menu');
  if (!menu) throw new Error('没有成员面板');
  const rect = menu.getBoundingClientRect();
  if (rect.left < 11.5 || rect.top < 11.5 || rect.right > innerWidth - 11.5 || rect.bottom > innerHeight - 11.5)
    throw new Error('成员面板超出视口：' + JSON.stringify(rect.toJSON()));
  if (menu.parentElement !== document.body) throw new Error('未脱离场景裁切容器');
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    viewport: [innerWidth, innerHeight], scrollable: menu.scrollHeight > menu.clientHeight };
`;
const openMenu = (index, x, y) => evaluate(`(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
  await new Promise(resolve => requestAnimationFrame(resolve));
  document.querySelectorAll('.vx-pig-hit')[${index}].dispatchEvent(new MouseEvent('click',
    {clientX:${x}, clientY:${y}, bubbles:true}));
  await new Promise(resolve => setTimeout(resolve, 180));
  ${inspectMenu}
})()`);
const checkCurrent = () => evaluate(`(async () => {
  await new Promise(resolve => setTimeout(resolve, 180));
  ${inspectMenu}
})()`);

try {
  await run("open", base);
  await run("set", "viewport", "1080", "760");
  await run("snapshot", "-i");
  await evaluate(`(async () => {
    document.documentElement.dataset.theme = 'light';
    const img = document.querySelector('.vx-landing-mascot img');
    await img.decode();
    if (img.naturalWidth !== 512 || !img.src.includes('landing-pig.gif')) throw new Error('首页GIF未正确加载');
    const join = [...document.querySelectorAll('button')].find(b => b.textContent.includes('加入语音房'));
    join.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!document.querySelector('.vx-modal input')) throw new Error('加入弹窗未打开');
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '取消').click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {gif:img.naturalWidth,join:true};
  })()`);
  await run("screenshot", path.join(output, "5blong-home.png"));

  for (const theme of ["light", "dark"]) {
    await run("open", `${base}/tests/fixtures/member-menu.html?theme=${theme}&muted=1`);
    await run("snapshot", "-i");
    for (const [width, height] of [[1080,760],[820,600],[820,320],[390,360],[200,180]]) {
      await run("set", "viewport", String(width), String(height));
      for (const [index, x, y] of [[0,8,8],[1,8,height-8],[1,width-8,height-8],[1,width/2,height/2]]) {
        reports.push({theme,index,...await openMenu(index,x,y)});
      }
      if (width === 820 && height === 600) {
        await openMenu(1,70,height-24);
        await run("screenshot", path.join(output, `5blong-menu-${theme}.png`));
      }
      if (width === 820 && height === 320 && theme === "light") {
        await openMenu(1,70,height-24);
        await evaluate(`(async()=>{ const menu=document.querySelector('.vx-member-menu'); menu.scrollTop=menu.scrollHeight;
          await new Promise(resolve=>requestAnimationFrame(resolve));
          const kick=[...menu.querySelectorAll('button')].find(b=>b.textContent.includes('踢出房间'));
          const r=kick.getBoundingClientRect();
          if(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')!==kick) throw new Error('底部管理按钮仍被遮挡');
          return true; })()`);
        await run("screenshot", path.join(output, "5blong-menu-short.png"));
      }
    }
    await run("set", "viewport", "1080", "760");
    await openMenu(1,1050,700);
    await run("set", "viewport", "820", "320");
    reports.push({theme,resize:true,...await checkCurrent()});
  }

  await run("set", "viewport", "820", "600");
  await run("open", `${base}/tests/fixtures/member-menu.html`);
  await run("snapshot", "-i");
  await openMenu(1,70,570);
  await evaluate(`(async()=>{
    const input=document.querySelector('.vx-member-menu input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0.45');
    input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(window.menuTestEvents.at(-1)?.kind!=='peer-volume'||window.menuTestEvents.at(-1).args[1]!==0.45) throw new Error('成员音量回调失败');
    [...document.querySelectorAll('.vx-member-menu button')].find(b=>b.textContent.includes('本地静音')).click();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(!document.querySelector('.vx-member-menu').textContent.includes('取消静音')) throw new Error('静音状态未更新');
    return true;
  })()`);
  const actions = ["poke","wave","feed","pat","tickle","hug","boo","cheer"];
  for (let index=0;index<actions.length;index++) {
    await openMenu(1,70,570);
    await evaluate(`(async()=>{
      document.querySelectorAll('.vx-interact-btn')[${index}].click();
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const last=window.menuTestEvents.at(-1);
      if(last.kind!=='interact'||last.args[2]!=='${actions[index]}'||document.querySelector('.vx-member-menu')) throw new Error('互动回调/关闭失败');
      return last;
    })()`);
  }
  for (const [label,kind] of [["禁言（关麦）","force-mute"],["踢出房间","kick"]]) {
    await openMenu(1,70,570);
    await evaluate(`(async()=>{
      [...document.querySelectorAll('.vx-member-menu button')].find(b=>b.textContent.includes('${label}')).click();
      await new Promise(resolve=>requestAnimationFrame(resolve));
      if(window.menuTestEvents.at(-1).kind!=='${kind}') throw new Error('房主管理回调失败');
      return true;
    })()`);
  }
  await openMenu(0,70,570);
  await evaluate(`(async()=>{
    const input=document.querySelector('.vx-member-menu input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'1.5');
    input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(window.menuTestEvents.at(-1).kind!=='mic-volume') throw new Error('麦克风音量回调失败');
    document.querySelector('.vx-menu-backdrop').click();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(document.querySelector('.vx-member-menu')) throw new Error('点击外部未关闭');
    return true;
  })()`);
  await run("open", `${base}/tests/fixtures/member-menu.html?host=0`);
  await run("snapshot", "-i");
  await openMenu(1,70,570);
  await evaluate(`(()=>{
    const menu=document.querySelector('.vx-member-menu');
    if(menu.textContent.includes('踢出房间')||menu.textContent.includes('禁言（关麦）')) throw new Error('非房主出现管理按钮');
    return true;
  })()`);
  // 检查真实指针点击，以及共享遮罩不挡住原来的语音快捷设置。
  await run("press", "Escape");
  await run("find", "role", "button", "click", "--name", "测试成员", "--exact");
  await checkCurrent();
  await run("press", "Escape");
  await run("find", "role", "button", "click", "--name", "语音快捷设置", "--exact");
  await evaluate(`(async()=>{
    await new Promise(resolve=>setTimeout(resolve,180));
    const panel=document.querySelector('.vx-voice-panel');
    const button=panel?.querySelector('button');
    const r=button?.getBoundingClientRect();
    if(!r||document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')!==button) throw new Error('快捷语音面板被遮罩挡住');
    return true;
  })()`);
  await run("press", "Escape");
  await evaluate(`(async()=>{
    const previous=document.querySelector('.vx-pig-hit');
    const other=document.querySelector('.vx-sign-settings');
    previous.focus();
    previous.click();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    other.focus();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(document.activeElement!==other) throw new Error('关闭抢了其他控件的焦点');
    return true;
  })()`);
  const result = { passed: true, layoutChecks: reports.length, layouts: reports,
    interactions: ["peer-volume","peer-mute",...actions,"force-mute","kick","mic-volume","escape","outside-click","non-host-permissions","landing-gif","join-dialog"] };
  writeFileSync(path.join(output, "5blong-ui-check.json"), JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,layoutChecks:reports.length,output}));
} finally {
  await run("close");
}
