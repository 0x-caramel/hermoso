<#
.SYNOPSIS
  Creates (or refreshes) the Start Menu shortcut of this fork ("Hermes (Mullvad)", "Hermoso": see fork/identity.json).

.DESCRIPTION
  The shortcut carries the fork's own AppUserModelID (the id electron/main.ts sets) and the fork's
  own icon. That is what gives the running fork its own taskbar button, its own icon and its own
  notification identity. Without it Windows folds the fork's window into the OFFICIAL Hermes (same
  id) and draws the official shortcut's black-and-white icon on the taskbar.

  Safe to run again at any time: it only rewrites this one shortcut. It never touches the official
  Hermes shortcuts or install.

    powershell -ExecutionPolicy Bypass -File fork\install-shortcut.ps1
    powershell -ExecutionPolicy Bypass -File fork\install-shortcut.ps1 -Desktop     (also on the Desktop)
#>
param(
  # Empty = what fork/identity.json says (the Mullvad fork has no such file and keeps its own defaults).
  [string] $Exe = '',
  [string] $Name = '',
  # Keep in sync with app.setAppUserModelId() in electron/main.ts (the baked identity's appId).
  [string] $AppId = '',
  [string] $Folder = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  [switch] $Desktop
)

$ErrorActionPreference = 'Stop'

$identity = $null
$identityFile = Join-Path $PSScriptRoot 'identity.json'
if (Test-Path -LiteralPath $identityFile) {
  $identity = (Get-Content -LiteralPath $identityFile -Raw -Encoding UTF8) | ConvertFrom-Json
}
function FromIdentity($field, $fallback) { if ($identity -and $identity.$field) { return [string]$identity.$field } else { return $fallback } }

if (-not $Name) { $Name = FromIdentity 'shortcutName' 'Hermes (Mullvad)' }
if (-not $AppId) { $AppId = FromIdentity 'appId' 'com.nousresearch.hermes.mullvad' }
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot ('..\release\win-unpacked\' + (FromIdentity 'executable' 'Hermes') + '.exe') }
$Description = if ($identity) { (FromIdentity 'displayName' $Name) } else { 'Hermes with the Mullvad VPN startup gate' }

if (-not ('AppShortcut' -as [type])) {
  # Windows PowerShell 5.1 compiles this as C# 5: no newer syntax below.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class AppShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLinkCoClass { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }

    // A PROPVARIANT is 16 bytes on x86 and 24 on x64; only the type and the pointer are used here.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);

    // System.AppUserModel.ID
    static PropertyKey AppUserModelId = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };

    public static void Write(string lnk, string target, string workDir, string icon, int iconIndex, string description, string appId)
    {
        IShellLinkW link = (IShellLinkW)new ShellLinkCoClass();
        link.SetPath(target);
        link.SetWorkingDirectory(workDir);
        link.SetIconLocation(icon, iconIndex);
        link.SetDescription(description);

        IPropertyStore store = (IPropertyStore)link;
        PropVariant value = new PropVariant();
        value.vt = 31; // VT_LPWSTR
        value.pointerValue = Marshal.StringToCoTaskMemUni(appId);
        try
        {
            store.SetValue(ref AppUserModelId, ref value);
            store.Commit();
        }
        finally
        {
            Marshal.FreeCoTaskMem(value.pointerValue);
        }

        ((IPersistFile)link).Save(lnk, true);
        Marshal.ReleaseComObject(link);
    }

    public static string ReadAppId(string lnk)
    {
        IShellLinkW link = (IShellLinkW)new ShellLinkCoClass();
        ((IPersistFile)link).Load(lnk, 0);
        IPropertyStore store = (IPropertyStore)link;
        PropVariant value;
        store.GetValue(ref AppUserModelId, out value);
        try
        {
            return (value.vt == 31 && value.pointerValue != IntPtr.Zero) ? Marshal.PtrToStringUni(value.pointerValue) : null;
        }
        finally
        {
            PropVariantClear(ref value);
            Marshal.ReleaseComObject(link);
        }
    }
}
'@
}

if (-not (Test-Path -LiteralPath $Exe)) {
  throw "$Exe not found. Build it first: node fork/pack.mjs (in apps/desktop)."
}

$exePath = (Resolve-Path -LiteralPath $Exe).Path
$workDir = Split-Path -Parent $exePath
$targets = @(Join-Path $Folder ($Name + '.lnk'))

if ($Desktop) {
  $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) ($Name + '.lnk')
}

foreach ($lnk in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lnk) | Out-Null
  [AppShortcut]::Write($lnk, $exePath, $workDir, $exePath, 0, $Description, $AppId)

  $back = [AppShortcut]::ReadAppId($lnk)
  if ($back -ne $AppId) {
    throw "wrote $lnk but read the AppUserModelID back as '$back' (expected '$AppId')"
  }

  Write-Output "shortcut: $lnk"
  Write-Output "  target: $exePath"
  Write-Output "  AppUserModelID: $back"
}

# Explorer may still hold the previous icon for this path; ask it to refresh (harmless).
& "$env:SystemRoot\System32\ie4uinit.exe" -show
