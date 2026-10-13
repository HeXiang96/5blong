/**
 * 把 .ico 嵌进 .exe 的文件资源里（资源管理器/桌面显示的图标）。
 *
 * 为什么需要：打包脚本只是把 electron.exe 改名成 5blong.exe，
 * exe 内部的图标资源还是 Electron 的。窗口与任务栏图标走 BrowserWindow({ icon })
 * 本来就生效，但**文件本身的图标**必须改 PE 资源。
 *
 * 做法：调 Win32 的 UpdateResource / EndUpdateResource（Add-Type 可用，实测通过），
 * 不需要额外工具。图标组与图标资源都从 1 号开始重写。
 *
 * 用法：node scripts/embed-exe-icon.mjs <exe> <ico>
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [exe, ico] = process.argv.slice(2);
if (!exe || !ico || !existsSync(exe) || !existsSync(ico)) {
  console.error("用法: node scripts/embed-exe-icon.mjs <exe> <ico>");
  process.exit(1);
}

/** 解析 .ico：取出每个条目的原始数据与尺寸。 */
function parseIco(buffer) {
  if (buffer.readUInt16LE(2) !== 1) throw new Error("不是 ICO 文件");
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    const width = buffer[off] === 0 ? 256 : buffer[off];
    const height = buffer[off + 1] === 0 ? 256 : buffer[off + 1];
    const size = buffer.readUInt32LE(off + 8);
    const dataOffset = buffer.readUInt32LE(off + 12);
    entries.push({
      width,
      height,
      data: buffer.subarray(dataOffset, dataOffset + size),
    });
  }
  return entries;
}

const entries = parseIco(readFileSync(ico));
console.log(`图标条目 ${entries.length} 个：${entries.map((e) => `${e.width}x${e.height}`).join(", ")}`);

/** C# 侧：P/Invoke 两个 API + 一个枚举（枚举只为打印现状）。 */
const CS = `
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class IconEmbedder {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool EndUpdateResource(IntPtr h, bool discard);

  delegate bool EnumResNameProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool EnumResourceNames(IntPtr hModule, IntPtr lpszType, EnumResNameProc proc, IntPtr lParam);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr LoadLibraryEx(string file, IntPtr hFile, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FreeLibrary(IntPtr hModule);

  const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
  static readonly IntPtr RT_ICON = new IntPtr(3);
  static readonly IntPtr RT_GROUP_ICON = new IntPtr(14);

  static string[] Names(string exe, IntPtr type) {
    var list = new List<string>();
    IntPtr mod = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
    if (mod == IntPtr.Zero) return list.ToArray();
    try {
      EnumResourceNames(mod, type, (h, t, n, p) => { list.Add(n.ToInt64().ToString()); return true; }, IntPtr.Zero);
    } finally { FreeLibrary(mod); }
    return list.ToArray();
  }

  public static string[] ListGroups(string exe) { return Names(exe, RT_GROUP_ICON); }
  public static string[] ListIcons(string exe) { return Names(exe, RT_ICON); }

  /** 写入图标资源与图标组。images[i] 为该条目原始数据。 */
  public static void Apply(string exe, byte[][] images, ushort[] widths, ushort[] heights) {
    IntPtr h = BeginUpdateResource(exe, false);
    if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "BeginUpdateResource");
    try {
      int n = images.Length;
      var ids = new ushort[n];
      for (int i = 0; i < n; i++) {
        ids[i] = (ushort)(i + 1);
        if (!UpdateResource(h, RT_ICON, new IntPtr(ids[i]), 0, images[i], (uint)images[i].Length))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateResource(ICON)");
      }
      var grp = new byte[6 + n * 14];
      BitConverter.GetBytes((ushort)0).CopyTo(grp, 0);
      BitConverter.GetBytes((ushort)1).CopyTo(grp, 2);
      BitConverter.GetBytes((ushort)n).CopyTo(grp, 4);
      for (int i = 0; i < n; i++) {
        int o = 6 + i * 14;
        grp[o] = (byte)(widths[i] >= 256 ? 0 : widths[i]);
        grp[o + 1] = (byte)(heights[i] >= 256 ? 0 : heights[i]);
        grp[o + 2] = 0; grp[o + 3] = 0;
        BitConverter.GetBytes((ushort)1).CopyTo(grp, o + 4);
        BitConverter.GetBytes((ushort)32).CopyTo(grp, o + 6);
        BitConverter.GetBytes((uint)images[i].Length).CopyTo(grp, o + 8);
        BitConverter.GetBytes(ids[i]).CopyTo(grp, o + 12);
      }
      if (!UpdateResource(h, RT_GROUP_ICON, new IntPtr(1), 0, grp, (uint)grp.Length))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateResource(GROUP_ICON)");
    } catch {
      EndUpdateResource(h, true);
      throw;
    }
    if (!EndUpdateResource(h, false)) throw new Win32Exception(Marshal.GetLastWin32Error(), "EndUpdateResource");
  }
}
`;

/** 图标数据以十六进制字符串嵌入脚本，避免额外文件与转义问题。 */
const hexList = entries.map((e) => `'${Buffer.from(e.data).toString("hex")}'`).join(",\n  ");
const widthList = entries.map((e) => e.width).join(", ");
const heightList = entries.map((e) => e.height).join(", ");

const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS}
'@ -Language CSharp

$exe = '${exe.replace(/'/g, "''")}'
Write-Output ("原有图标组: " + ([IconEmbedder]::ListGroups($exe) -join ','))
Write-Output ("原有图标数: " + ([IconEmbedder]::ListIcons($exe)).Count)

$hexes = @(
  ${hexList}
)
$widths = @(${widthList})
$heights = @(${heightList})

function HexToBytes([string]$hex) {
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
  }
  return $bytes
}

$images = New-Object 'System.Collections.Generic.List[byte[]]'
$ws = New-Object 'System.Collections.Generic.List[uint16]'
$hs = New-Object 'System.Collections.Generic.List[uint16]'
for ($i = 0; $i -lt $hexes.Count; $i++) {
  $images.Add((HexToBytes $hexes[$i]))
  $ws.Add([uint16]$widths[$i])
  $hs.Add([uint16]$heights[$i])
}

[IconEmbedder]::Apply($exe, $images.ToArray(), $ws.ToArray(), $hs.ToArray())
Write-Output "写入完成"
Write-Output ("写入后图标组: " + ([IconEmbedder]::ListGroups($exe) -join ','))
Write-Output ("写入后图标数: " + ([IconEmbedder]::ListIcons($exe)).Count)
`;

const tmp = path.join(tmpdir(), `embed-icon-${Date.now()}.ps1`);
writeFileSync(tmp, script, "utf8");

/*
 * 用 powershell.exe（Windows PowerShell 5.1）而不是 pwsh：
 * 这个环境里 pwsh 不在 PATH 上，powershell.exe 可用且 Add-Type 能编译。
 */
const shell = process.env.DSH_POWERSHELL ?? "powershell.exe";
const result = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], {
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error("启动失败:", result.error.message);
console.log(`退出码: ${result.status}`);
process.exit(result.status ?? 1);
